"""Jarvis MLX model-serving sidecar.

A thin FastAPI wrapper around ``mlx-lm`` that exposes an OpenAI-compatible
chat/embeddings API *plus* explicit load/unload lifecycle control. This is
feature 1's "Local Qwen Inference Core" running on Apple Silicon.

Why this exists (and not plain ``mlx_lm.server``):
    The built-in ``mlx_lm.server`` serves ``/v1/chat/completions`` fine, but it
    gives the TS core no way to *unload* a model and reclaim unified RAM after
    the idle timer fires. On a 16 GB fanless M3 Air, RAM is the binding budget
    (chat + voice + embeddings + OS share one pool), so on-demand
    load/unload is mandatory — see ``architecture/model-serving.md`` §4. This
    wrapper adds ``POST /load`` / ``POST /unload`` and a state machine the Node
    ``ModelManager`` drives.

Contract (the TypeScript ``mlxProvider`` calls this — keep it exact):
    GET  /health               -> {state, model, loaded}
    POST /load   {model}       -> load into memory (lazy, idempotent, shared task)
    POST /unload               -> free weights + caches, gc, clear_cache
    POST /v1/chat/completions  -> OpenAI chat (stream via SSE or one-shot)
    POST /v1/embeddings        -> OpenAI embeddings (separate resident model)

Run with::

    uvicorn mlx_server:app --host 127.0.0.1 --port ${MLX_SIDECAR_PORT:-8088}

IMPORTANT: requires Python >= 3.11 (current ``mlx-lm`` does). The system
``python3`` on the target Air is 3.9 — use ``run.sh`` which builds a 3.11+
venv. See README.md.
"""

from __future__ import annotations

import asyncio
import gc
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Dict, List, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# mlx-lm public API. These imports require mlx-lm (and thus Python >= 3.11);
# they will fail on the system 3.9 interpreter — that is expected, run via the
# venv that run.sh provisions.
from mlx_lm import load, stream_generate
import mlx.core as mx

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

HOST = "127.0.0.1"
PORT = int(os.environ.get("MLX_SIDECAR_PORT", "8088"))

# Default embedding model for /v1/embeddings (see architecture/model-serving.md
# §1). The TS registry normally passes the model per request (config/models.yaml
# qwen-embed); this is only the fallback when none is supplied.
DEFAULT_EMBEDDING_MODEL = os.environ.get(
    "MLX_EMBEDDING_MODEL", "mlx-community/Qwen3-Embedding-0.6B-8bit"
)

ModelState = Literal["unloaded", "loading", "ready", "error"]


# --------------------------------------------------------------------------- #
# Model manager
# --------------------------------------------------------------------------- #


class ModelManager:
    """Owns the single resident chat model + tokenizer and its lifecycle.

    State machine (mirrors the TS ``ModelManager`` in feature 1):
        unloaded -> loading -> ready
                            \\-> error
        ready -> unloaded   (on /unload)

    Concurrency:
        * A single :class:`asyncio.Lock` guards all state transitions.
        * Concurrent ``/load`` (or auto-load) callers for the *same* model
          share ONE in-flight task — we never load the weights twice.
    """

    def __init__(self) -> None:
        self.state: ModelState = "unloaded"
        self.model_id: Optional[str] = None
        self.error: Optional[str] = None

        self._model: Any = None
        self._tokenizer: Any = None

        self._lock = asyncio.Lock()
        # The shared in-flight load task, keyed implicitly by ``model_id``.
        self._load_task: Optional["asyncio.Task[None]"] = None
        self._loading_id: Optional[str] = None

    # -- introspection ----------------------------------------------------- #

    @property
    def loaded(self) -> bool:
        return self.state == "ready" and self._model is not None

    def status(self) -> Dict[str, Any]:
        """The shape returned by /health, /load and /unload."""
        return {"state": self.state, "model": self.model_id, "loaded": self.loaded}

    # -- loading ----------------------------------------------------------- #

    async def ensure_ready(self, model_id: str) -> None:
        """Idempotently make ``model_id`` the resident, ready chat model.

        * Already ready with this model -> returns immediately.
        * A different model is resident -> unload it, then load the new one.
        * A load for this model is already in flight -> await that one task
          (no double load, no second set of weights in RAM).

        Raises:
            RuntimeError: if loading fails (caller maps this to 503 and the TS
                core falls back to HF).
        """
        # Fast path: the right model is already hot.
        if self.state == "ready" and self.model_id == model_id and self._model is not None:
            return

        async with self._lock:
            # Re-check under the lock (another coroutine may have just loaded it).
            if self.state == "ready" and self.model_id == model_id and self._model is not None:
                return

            # A load for this exact model is in flight -> join it.
            if self._load_task is not None and self._loading_id == model_id:
                task = self._load_task
            else:
                # A different model (or none) is loading/resident: tear down and
                # start a fresh shared load task for the requested model.
                if self._load_task is not None and not self._load_task.done():
                    # In-flight load is for a *different* model; let it finish
                    # then we override. Simplest correct behaviour: wait, then
                    # fall through to load ours.
                    await asyncio.shield(self._wait_quietly(self._load_task))

                if self._model is not None and self.model_id != model_id:
                    self._free_chat()

                self._loading_id = model_id
                self.state = "loading"
                self.error = None
                self.model_id = model_id
                self._load_task = asyncio.create_task(self._do_load(model_id))
                task = self._load_task

        # Await outside the lock so other coroutines can join the same task.
        try:
            await task
        except Exception as exc:  # noqa: BLE001 - surfaced to caller as 503
            raise RuntimeError(f"failed to load model {model_id!r}: {exc}") from exc

    @staticmethod
    async def _wait_quietly(task: "asyncio.Task[None]") -> None:
        try:
            await task
        except Exception:  # noqa: BLE001 - swallow; the owner handles its own errors
            pass

    async def _do_load(self, model_id: str) -> None:
        """Run the (blocking) ``mlx_lm.load`` off the event loop."""
        loop = asyncio.get_running_loop()
        try:
            model, tokenizer = await loop.run_in_executor(None, load, model_id)
            self._model = model
            self._tokenizer = tokenizer
            self.state = "ready"
            self.error = None
        except Exception as exc:  # noqa: BLE001
            self._free_chat()
            self.state = "error"
            self.error = str(exc)
            raise
        finally:
            self._load_task = None
            self._loading_id = None

    # -- unloading --------------------------------------------------------- #

    async def unload(self) -> None:
        """Drop the chat model + tokenizer and reclaim unified RAM.

        This is how the TS core reclaims RAM after the idle timer fires. We drop
        all references, run ``gc.collect()``, and ask MLX to clear its internal
        buffer/cache pool (``mlx.core.clear_cache`` when available).
        """
        async with self._lock:
            self._free_chat()
            self.state = "unloaded"
            self.model_id = None
            self.error = None

    def _free_chat(self) -> None:
        """Synchronous teardown of chat weights + MLX caches (no lock)."""
        self._model = None
        self._tokenizer = None
        gc.collect()
        _clear_mlx_cache()

    # -- generation -------------------------------------------------------- #

    def render_prompt(self, messages: List[Dict[str, str]]) -> str:
        """Apply the model's chat template to OpenAI-style ``messages``."""
        if self._tokenizer is None:
            raise RuntimeError("no tokenizer loaded")
        tok = self._tokenizer
        if hasattr(tok, "apply_chat_template") and getattr(tok, "chat_template", None):
            return tok.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        # Fallback: naive concatenation if the tokenizer ships no chat template.
        parts = [f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages]
        parts.append("assistant:")
        return "\n".join(parts)

    def stream_tokens(
        self,
        prompt: str,
        *,
        max_tokens: int,
        temperature: float,
    ) -> Any:
        """Yield ``GenerationResponse`` objects from ``mlx_lm.stream_generate``.

        ``stream_generate`` is a synchronous generator; callers must pump it on
        a worker thread (see :func:`_aiter_generation`) to avoid blocking the
        event loop.
        """
        if self._model is None or self._tokenizer is None:
            raise RuntimeError("model not loaded")
        sampler = _make_sampler(temperature)
        return stream_generate(
            self._model,
            self._tokenizer,
            prompt,
            max_tokens=max_tokens,
            sampler=sampler,
        )


def _make_sampler(temperature: float) -> Any:
    """Build an mlx-lm sampler for the given temperature (best-effort).

    Newer mlx-lm exposes ``mlx_lm.sample_utils.make_sampler``. If unavailable
    we return ``None`` and let ``stream_generate`` use its default (greedy).
    """
    try:
        from mlx_lm.sample_utils import make_sampler

        return make_sampler(temp=float(temperature))
    except Exception:  # noqa: BLE001 - older/newer API shapes; fall back to default
        return None


def _clear_mlx_cache() -> None:
    """Ask MLX to release its cached Metal buffers, if the API exists."""
    for name in ("clear_cache", "reset_peak_memory"):
        fn = getattr(mx, name, None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001 - best effort
                pass
    # Some versions nest it under mx.metal.
    metal = getattr(mx, "metal", None)
    if metal is not None:
        fn = getattr(metal, "clear_cache", None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass


# --------------------------------------------------------------------------- #
# Embedding manager (separate, may stay resident)
# --------------------------------------------------------------------------- #


class EmbeddingManager:
    """Holds the (tiny) embedding model. Loaded independently of the chat model.

    Per architecture/model-serving.md §4 the embedding model (~0.6 GB) is
    small enough to stay resident, so it has its own lifecycle separate from the
    chat model's idle-unload.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._model: Any = None
        self._tokenizer: Any = None
        self.model_id: Optional[str] = None

    async def ensure_ready(self, model_id: str) -> None:
        if self._model is not None and self.model_id == model_id:
            return
        async with self._lock:
            if self._model is not None and self.model_id == model_id:
                return
            loop = asyncio.get_running_loop()
            model, tokenizer = await loop.run_in_executor(None, load, model_id)
            self._model = model
            self._tokenizer = tokenizer
            self.model_id = model_id

    async def embed(self, texts: List[str]) -> List[List[float]]:
        """Return one embedding vector per input string.

        Qwen3-Embedding produces a sentence vector via **last-token pooling** on
        the transformer's final hidden states, then L2-normalize. We must read
        the hidden states from the transformer body (``model.model(tokens)``) —
        calling ``model(tokens)`` applies the LM head and returns vocab-sized
        *logits*, not embeddings (that bug produced ~151k-dim vectors).
        """
        if self._model is None or self._tokenizer is None:
            raise RuntimeError("embedding model not loaded")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._embed_sync, texts)

    def _embed_sync(self, texts: List[str]) -> List[List[float]]:
        # The transformer body that returns hidden states (1, seq, hidden),
        # before the LM head. mlx-lm wraps it as ``model.model``; fall back to
        # the top-level module if a model class doesn't follow that convention.
        body = getattr(self._model, "model", self._model)
        out: List[List[float]] = []
        for text in texts:
            ids = self._tokenizer.encode(text)
            tokens = mx.array([ids])  # (1, seq)
            hidden = body(tokens)  # (1, seq, hidden) — hidden states, NOT logits
            pooled = hidden[:, -1, :]  # (1, hidden) last-token pooling
            # L2 normalize.
            norm = mx.sqrt((pooled * pooled).sum(axis=-1, keepdims=True)) + 1e-12
            vec = (pooled / norm)[0]
            mx.eval(vec)
            out.append([float(x) for x in vec.tolist()])
        return out


# --------------------------------------------------------------------------- #
# OpenAI request/response models
# --------------------------------------------------------------------------- #


class ChatMessage(BaseModel):
    role: str
    content: str = ""


class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    stream: bool = False
    max_tokens: int = Field(default=512, ge=1)
    temperature: float = Field(default=0.7, ge=0.0)


class LoadRequest(BaseModel):
    model: str


class EmbeddingsRequest(BaseModel):
    model: Optional[str] = None
    # OpenAI allows a string or a list of strings.
    input: Any


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #

manager = ModelManager()
embeddings = EmbeddingManager()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Ensure the chat model is dropped on shutdown so RAM is released."""
    yield
    try:
        await manager.unload()
    except Exception:  # noqa: BLE001
        pass


app = FastAPI(title="Jarvis MLX Sidecar", version="1.0.0", lifespan=lifespan)


# -- lifecycle endpoints ---------------------------------------------------- #


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness + model state for the TS ``ModelManager``."""
    return manager.status()


@app.post("/load")
async def load_model(req: LoadRequest) -> JSONResponse:
    """Load (or confirm-loaded) a chat model. Lazy, idempotent, shared task."""
    try:
        await manager.ensure_ready(req.model)
    except RuntimeError as exc:
        # State is already "error"; surface 503 so the core can fall back to HF.
        return JSONResponse(
            status_code=503,
            content={**manager.status(), "error": str(exc)},
        )
    return JSONResponse(content=manager.status())


@app.post("/unload")
async def unload_model() -> Dict[str, Any]:
    """Free the chat model + caches and reclaim unified RAM."""
    await manager.unload()
    return manager.status()


# -- OpenAI-compatible: chat ------------------------------------------------ #


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest) -> Any:
    """OpenAI-compatible chat completions, streaming or one-shot.

    If the requested model is not the resident one, it is loaded on demand
    first; nothing is emitted to the client until the model is ready.
    """
    # Auto-load on demand (emit nothing until ready).
    try:
        await manager.ensure_ready(req.model)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    messages = [m.model_dump() for m in req.messages]
    try:
        prompt = manager.render_prompt(messages)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())

    if req.stream:
        generator = _stream_chat(
            req=req,
            prompt=prompt,
            completion_id=completion_id,
            created=created,
        )
        return StreamingResponse(generator, media_type="text/event-stream")

    return await _chat_oneshot(
        req=req, prompt=prompt, completion_id=completion_id, created=created
    )


async def _aiter_generation(
    prompt: str, *, max_tokens: int, temperature: float
) -> AsyncGenerator[Any, None]:
    """Pump the synchronous ``stream_generate`` generator across a thread.

    ``stream_generate`` blocks on each decode step, so we run it on the default
    executor and hand chunks back to the event loop via a queue. This keeps the
    sidecar responsive (and cancellable) while generating.
    """
    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[Any]" = asyncio.Queue()
    sentinel = object()

    def _producer() -> None:
        try:
            for chunk in manager.stream_tokens(
                prompt, max_tokens=max_tokens, temperature=temperature
            ):
                loop.call_soon_threadsafe(queue.put_nowait, chunk)
        except Exception as exc:  # noqa: BLE001 - propagate to consumer
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)

    producer = loop.run_in_executor(None, _producer)
    try:
        while True:
            item = await queue.get()
            if item is sentinel:
                break
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        # Ensure the worker drains even on client disconnect / cancellation.
        await producer


async def _stream_chat(
    *, req: ChatCompletionRequest, prompt: str, completion_id: str, created: int
) -> AsyncGenerator[str, None]:
    """Yield OpenAI-shaped SSE chunks, terminating with ``[DONE]``."""
    # Leading chunk announcing the assistant role (matches OpenAI behaviour).
    yield _sse(
        _chunk(
            completion_id,
            created,
            req.model,
            delta={"role": "assistant"},
            finish_reason=None,
        )
    )

    finish_reason = "stop"
    try:
        async for gen in _aiter_generation(
            prompt, max_tokens=req.max_tokens, temperature=req.temperature
        ):
            text = getattr(gen, "text", "") or ""
            if text:
                yield _sse(
                    _chunk(
                        completion_id,
                        created,
                        req.model,
                        delta={"content": text},
                        finish_reason=None,
                    )
                )
    except Exception:  # noqa: BLE001 - surface as a truncated stream
        finish_reason = "error"

    # Terminal chunk with finish_reason, then the OpenAI [DONE] sentinel.
    yield _sse(
        _chunk(
            completion_id,
            created,
            req.model,
            delta={},
            finish_reason=finish_reason,
        )
    )
    yield "data: [DONE]\n\n"


async def _chat_oneshot(
    *, req: ChatCompletionRequest, prompt: str, completion_id: str, created: int
) -> Dict[str, Any]:
    """Collect the full generation and return a normal OpenAI completion."""
    pieces: List[str] = []
    prompt_tokens = 0
    completion_tokens = 0
    async for gen in _aiter_generation(
        prompt, max_tokens=req.max_tokens, temperature=req.temperature
    ):
        text = getattr(gen, "text", "") or ""
        if text:
            pieces.append(text)
        # mlx-lm GenerationResponse carries running token counts.
        prompt_tokens = getattr(gen, "prompt_tokens", prompt_tokens) or prompt_tokens
        completion_tokens = (
            getattr(gen, "generation_tokens", completion_tokens) or completion_tokens
        )

    content = "".join(pieces)
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def _chunk(
    completion_id: str,
    created: int,
    model: str,
    *,
    delta: Dict[str, Any],
    finish_reason: Optional[str],
) -> Dict[str, Any]:
    """Build one ``chat.completion.chunk`` object (OpenAI streaming shape)."""
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {"index": 0, "delta": delta, "finish_reason": finish_reason}
        ],
    }


def _sse(obj: Dict[str, Any]) -> str:
    """Serialize ``obj`` as one SSE ``data:`` event."""
    import json

    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# -- OpenAI-compatible: embeddings ----------------------------------------- #


@app.post("/v1/embeddings")
async def create_embeddings(req: EmbeddingsRequest) -> Dict[str, Any]:
    """OpenAI-compatible embeddings using the resident embedding model."""
    model_id = req.model or DEFAULT_EMBEDDING_MODEL
    # Normalize input to a list of strings.
    if isinstance(req.input, str):
        texts = [req.input]
    elif isinstance(req.input, list) and all(isinstance(t, str) for t in req.input):
        texts = list(req.input)
    else:
        raise HTTPException(
            status_code=400, detail="`input` must be a string or list of strings"
        )

    try:
        await embeddings.ensure_ready(model_id)
        vectors = await embeddings.embed(texts)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    data = [
        {"object": "embedding", "index": i, "embedding": vec}
        for i, vec in enumerate(vectors)
    ]
    return {
        "object": "list",
        "data": data,
        "model": model_id,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
