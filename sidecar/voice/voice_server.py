"""Jarvis Voice sidecar — Phase 3 audio model server.

Exposes STT (faster-whisper + Silero VAD), TTS (Kokoro), wake word
(openWakeWord) and lifecycle endpoints over HTTP/WebSocket so the TypeScript
voice orchestrator (``@jarvis/voice``) can drive all audio models without
importing Python.

Contract (keep exact — the TS ``voiceClient`` calls these):

    GET  /health
        → { state, components: { stt, tts, vad, wake } }

    WS   /stt/stream
        Client sends binary PCM-16 mono 16 kHz frames (any frame size,
        recommended 20 ms = 320 samples).
        Server sends JSON text frames:
            { "type": "speech_start" }
            { "type": "partial",  "text": "…", "stability": 0.0..1.0 }
            { "type": "final",    "text": "…", "confidence": 0.0..1.0 }
            { "type": "speech_end" }
            { "type": "error",    "detail": "…" }
        Close the WebSocket to cancel.

    POST /tts   { "text": "…", "request_id": "<optional uuid>" }
        → Streams raw PCM-16 LE mono 24 kHz audio chunks (Content-Type:
          audio/pcm; rate=24000).  Request-id header ``X-TTS-Request-Id``
          echoed back.  Close the response / call /tts/cancel to abort.

    POST /tts/cancel   { "request_id": "…" }
        → { "cancelled": bool }

    POST /wake/enable   → { "wake": "enabled" }
    POST /wake/disable  → { "wake": "disabled" }

    POST /unload   { "components": ["stt","tts","vad","wake"] }   (optional, default all)
        → { "unloaded": ["stt", …] }

Run with::

    uvicorn voice_server:app --host 127.0.0.1 --port ${VOICE_SIDECAR_PORT:-8089}

IMPORTANT: requires Python >= 3.11.
The system python3 on the target MacBook Air M3 is 3.9.6 — TOO OLD.
Use run.sh, which probes for python3.12 / python3.11 and builds an isolated
.venv.  See README.md.

Models are NOT bundled — they are downloaded on first use (or pre-downloaded
for lower cold-start).  See README.md → "Model downloads".
"""

from __future__ import annotations

import asyncio
import gc
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Dict, List, Literal, Optional, Set

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
log = logging.getLogger("voice_server")

# ---------------------------------------------------------------------------
# Config from environment
# ---------------------------------------------------------------------------

HOST = "127.0.0.1"
PORT = int(os.environ.get("VOICE_SIDECAR_PORT", "8089"))

# URL the wake word listener POSTs WakeEvents to (core's voice session).
VOICE_ORCHESTRATOR_URL = os.environ.get("VOICE_ORCHESTRATOR_URL", "http://127.0.0.1:8080/voice/wake")

# faster-whisper model size.  "small.int8" is the recommended default.
# Set to "base.en" for lower RAM / faster cold-start on English-only sessions.
STT_MODEL_SIZE = os.environ.get("STT_MODEL_SIZE", "small")

# Kokoro voice/lang. Jarvis defaults to a British male voice (bm_fable);
# other British options: bm_george, bm_lewis, bf_emma, bf_isabella.
# American voices (af_*/am_*) need TTS_LANG=en-us — voice prefix and lang
# pipeline must agree (b* ↔ en-gb, a* ↔ en-us).
TTS_VOICE = os.environ.get("TTS_VOICE", "bm_fable")
TTS_LANG = os.environ.get("TTS_LANG", "en-gb")

# Kokoro's KPipeline takes single-letter lang codes; map the friendly names
# explicitly so we don't depend on the library's alias table.
_KOKORO_LANG_CODES = {"en-us": "a", "en-gb": "b", "a": "a", "b": "b"}
TTS_LANG_CODE = _KOKORO_LANG_CODES.get(TTS_LANG.lower(), TTS_LANG)

# Silero VAD threshold (0..1); lower = more sensitive.
VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))

# Wake word model path or name recognised by openWakeWord.
WAKE_WORD_MODEL = os.environ.get("WAKE_WORD_MODEL", "hey_jarvis")

ComponentState = Literal["unloaded", "loading", "ready", "error"]

# ---------------------------------------------------------------------------
# STT manager (faster-whisper + Silero VAD)
# ---------------------------------------------------------------------------


class STTManager:
    """Lazy-loads faster-whisper (small, int8) and Silero VAD.

    Architecture note
    -----------------
    faster-whisper (CTranslate2 backend) is the **default** engine because it
    runs on CPU/ANE with int8 quant and starts quickly.  The *preferred*
    lower-latency alternative for production is **Parakeet-TDT via MLX** (the
    MLX sidecar can expose it), giving tens-of-ms streaming partials on Apple
    Silicon — see ``stt.py`` for that integration path.

    Silero VAD
    ----------
    A tiny ONNX/PyTorch model (<1 MB) that classifies every 30 ms frame as
    speech/non-speech in <1 ms.  It drives ``speech_start`` / ``speech_end``
    events on the WebSocket so the TS side can update UI state without waiting
    for a transcript.
    """

    def __init__(self) -> None:
        self.state: ComponentState = "unloaded"
        self.error: Optional[str] = None
        self._model: Any = None          # WhisperModel
        self._vad_model: Any = None      # Silero VAD callable
        self._vad_utils: Any = None      # (get_speech_timestamps, …)
        self._lock = asyncio.Lock()

    @property
    def loaded(self) -> bool:
        return self.state == "ready"

    async def ensure_ready(self) -> None:
        """Idempotent lazy load.  Runs blocking IO on the executor."""
        if self.state == "ready":
            return
        async with self._lock:
            if self.state == "ready":
                return
            self.state = "loading"
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, self._load_sync)
                self.state = "ready"
                self.error = None
            except Exception as exc:  # noqa: BLE001
                self.state = "error"
                self.error = str(exc)
                raise

    def _load_sync(self) -> None:
        """Synchronous model load (runs in executor thread)."""
        from faster_whisper import WhisperModel
        import torch

        log.info("Loading faster-whisper %s (int8) …", STT_MODEL_SIZE)
        self._model = WhisperModel(STT_MODEL_SIZE, device="cpu", compute_type="int8")

        log.info("Loading Silero VAD …")
        try:
            # Preferred: the silero-vad pip package (in requirements.txt) —
            # bundles the model, no network fetch, no interactive prompt.
            from silero_vad import load_silero_vad  # type: ignore[import]

            self._vad_model = load_silero_vad(onnx=False)
            self._vad_utils = None  # streaming path runs the model directly
        except ImportError:
            # Fallback: PyTorch Hub. trust_repo=True is REQUIRED headless —
            # without it torch.hub prompts "Do you trust this repository?"
            # on stdin and the load dies with "EOF when reading a line".
            vad_model, vad_utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                force_reload=False,
                onnx=False,
                trust_repo=True,
            )
            self._vad_model = vad_model
            self._vad_utils = vad_utils
        log.info("STT + VAD ready.")

    async def unload(self) -> None:
        async with self._lock:
            self._model = None
            self._vad_model = None
            self._vad_utils = None
            self.state = "unloaded"
            self.error = None
            gc.collect()

    def get_vad_model(self) -> Any:
        return self._vad_model

    def get_whisper(self) -> Any:
        return self._model


# ---------------------------------------------------------------------------
# TTS manager (Kokoro)
# ---------------------------------------------------------------------------


class TTSManager:
    """Lazy-loads Kokoro for streaming TTS.

    Kokoro produces 24 kHz mono PCM.  The MLX variant (mlx-audio / kokoro-mlx)
    is the preferred production path on Apple Silicon for sub-300 ms
    time-to-first-audio; the plain kokoro (torch) package works on any platform.

    Output format
    -------------
    The ``/tts`` endpoint streams raw PCM-16 LE mono 24 kHz audio chunks.  The
    TS orchestrator buffers and plays them via the CoreAudio transport.
    """

    def __init__(self) -> None:
        self.state: ComponentState = "unloaded"
        self.error: Optional[str] = None
        self._pipeline: Any = None       # KPipeline or KModel
        self._lock = asyncio.Lock()

    @property
    def loaded(self) -> bool:
        return self.state == "ready"

    async def ensure_ready(self) -> None:
        if self.state == "ready":
            return
        async with self._lock:
            if self.state == "ready":
                return
            self.state = "loading"
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, self._load_sync)
                self.state = "ready"
                self.error = None
            except Exception as exc:  # noqa: BLE001
                self.state = "error"
                self.error = str(exc)
                raise

    def _load_sync(self) -> None:
        # kokoro >= 0.9 ships KPipeline as the recommended high-level entry point.
        from kokoro import KPipeline  # type: ignore[import]

        log.info("Loading Kokoro TTS pipeline (lang=%s → %s) …", TTS_LANG, TTS_LANG_CODE)
        self._pipeline = KPipeline(lang_code=TTS_LANG_CODE)
        log.info("Kokoro TTS ready.")

    async def unload(self) -> None:
        async with self._lock:
            self._pipeline = None
            self.state = "unloaded"
            self.error = None
            gc.collect()

    def get_pipeline(self) -> Any:
        return self._pipeline


# ---------------------------------------------------------------------------
# Wake word manager (openWakeWord)
# ---------------------------------------------------------------------------


class WakeManager:
    """Manages the openWakeWord listener state.

    The actual listener loop lives in ``wakeword.py`` (``WakeWordListener``).
    This manager controls enabled/disabled state and owns the background task
    reference so the FastAPI app can start/stop it cleanly.
    """

    def __init__(self) -> None:
        self.state: ComponentState = "unloaded"
        self.error: Optional[str] = None
        self._enabled: bool = False
        self._listener_task: Optional[asyncio.Task[None]] = None
        self._lock = asyncio.Lock()

    @property
    def loaded(self) -> bool:
        return self.state == "ready"

    async def enable(self) -> None:
        """Start the background wake-word listener."""
        async with self._lock:
            if self._enabled and self._listener_task and not self._listener_task.done():
                return  # already running
            self._enabled = True
            self.state = "loading"
            from wakeword import WakeWordListener  # type: ignore[import]

            listener = WakeWordListener(
                model_name=WAKE_WORD_MODEL,
                orchestrator_url=VOICE_ORCHESTRATOR_URL,
                threshold=float(os.environ.get("WAKE_THRESHOLD", "0.35")),
            )
            self._listener_task = asyncio.create_task(listener.run(), name="wake_listener")
            self.state = "ready"
            self.error = None
            log.info("Wake word listener started (model=%s).", WAKE_WORD_MODEL)

    async def disable(self) -> None:
        """Stop the background listener."""
        async with self._lock:
            self._enabled = False
            if self._listener_task and not self._listener_task.done():
                self._listener_task.cancel()
                try:
                    await self._listener_task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            self._listener_task = None
            self.state = "unloaded"
            log.info("Wake word listener stopped.")

    async def unload(self) -> None:
        await self.disable()

    def status_str(self) -> str:
        if not self._enabled:
            return "disabled"
        return self.state


# ---------------------------------------------------------------------------
# Singleton component managers
# ---------------------------------------------------------------------------

stt_mgr = STTManager()
tts_mgr = TTSManager()
wake_mgr = WakeManager()

# In-flight TTS cancellation registry: request_id → asyncio.Event
_tts_cancel: Dict[str, asyncio.Event] = {}


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    log.info("Voice sidecar starting (port=%d).", PORT)
    yield
    log.info("Voice sidecar shutting down — unloading models …")
    await asyncio.gather(
        stt_mgr.unload(),
        tts_mgr.unload(),
        wake_mgr.unload(),
        return_exceptions=True,
    )


app = FastAPI(title="Jarvis Voice Sidecar", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness probe + per-component state.

    Returns::

        {
          "state": "ready" | "degraded" | "error",
          "components": {
            "stt":  "unloaded|loading|ready|error",
            "tts":  "unloaded|loading|ready|error",
            "vad":  "unloaded|loading|ready|error",  # shares stt_mgr
            "wake": "unloaded|loading|ready|error|disabled"
          }
        }
    """
    components = {
        "stt": stt_mgr.state,
        "tts": tts_mgr.state,
        "vad": stt_mgr.state,   # VAD co-loads with STT
        "wake": wake_mgr.status_str(),
    }
    # Overall state: ready only if no component is in error.
    states = list(components.values())
    if any(s == "error" for s in states):
        overall = "error"
    elif all(s in ("ready", "disabled") for s in states):
        overall = "ready"
    else:
        overall = "degraded"
    return {"state": overall, "components": components}


# ---------------------------------------------------------------------------
# Wake word control
# ---------------------------------------------------------------------------


@app.post("/wake/enable")
async def wake_enable() -> Dict[str, str]:
    """Start the openWakeWord listener background task."""
    try:
        await wake_mgr.enable()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"wake": "enabled"}


@app.post("/wake/disable")
async def wake_disable() -> Dict[str, str]:
    """Stop the openWakeWord listener background task."""
    await wake_mgr.disable()
    return {"wake": "disabled"}


# ---------------------------------------------------------------------------
# /stt/stream  WebSocket
# ---------------------------------------------------------------------------


@app.websocket("/stt/stream")
async def stt_stream(ws: WebSocket) -> None:
    """Stream PCM-16 mono 16 kHz audio → JSON transcript / VAD events.

    Protocol
    --------
    Client sends **binary** WebSocket frames containing raw PCM-16 LE mono
    16 kHz samples (any chunk size; 320 bytes / 20 ms recommended).

    Server sends **text** WebSocket frames containing JSON:

    * ``{ "type": "speech_start" }``
        Fired by Silero VAD on silence→speech rising edge.
    * ``{ "type": "partial", "text": "…", "stability": 0.7 }``
        Interim hypothesis from faster-whisper (emitted periodically).
    * ``{ "type": "final", "text": "…", "confidence": 0.92 }``
        Final transcript after speech_end (or when ``finalize`` requested).
    * ``{ "type": "speech_end" }``
        Fired by Silero VAD on speech→silence falling edge.
    * ``{ "type": "error", "detail": "…" }``
        Non-fatal server error; stream continues unless connection closed.

    Barge-in
    --------
    The TS orchestrator closes the connection to abort.  A new connection
    starts a fresh session.

    Engine note
    -----------
    faster-whisper (small int8) is the default.  For lower latency on Apple
    Silicon the MLX sidecar can expose Parakeet-TDT; see ``stt.py`` for the
    alternative integration path.
    """
    await ws.accept()
    log.info("STT WebSocket connected.")

    try:
        await stt_mgr.ensure_ready()
    except Exception as exc:  # noqa: BLE001
        await ws.send_text(json.dumps({"type": "error", "detail": f"STT load failed: {exc}"}))
        await ws.close(code=1011)
        return

    from stt import AudioBuffer, run_vad_and_transcribe  # type: ignore[import]

    buf = AudioBuffer()
    loop = asyncio.get_running_loop()

    async def _send(obj: Dict[str, Any]) -> None:
        try:
            await ws.send_text(json.dumps(obj))
        except Exception:  # noqa: BLE001
            pass

    try:
        async for message in ws.iter_bytes():
            buf.extend(message)

            # Run VAD + transcription step on executor so we don't block the loop.
            events = await loop.run_in_executor(
                None,
                run_vad_and_transcribe,
                buf,
                stt_mgr.get_vad_model(),
                stt_mgr.get_whisper(),
                VAD_THRESHOLD,
            )
            for event in events:
                await _send(event)

    except WebSocketDisconnect:
        log.info("STT WebSocket disconnected (client close / barge-in).")
    except Exception as exc:  # noqa: BLE001
        log.exception("STT WebSocket error: %s", exc)
        try:
            await ws.send_text(json.dumps({"type": "error", "detail": str(exc)}))
        except Exception:  # noqa: BLE001
            pass
    finally:
        log.info("STT session ended.")


# ---------------------------------------------------------------------------
# /tts  POST → streaming PCM
# ---------------------------------------------------------------------------


class TTSRequest(BaseModel):
    text: str = Field(..., description="Text to synthesize.")
    request_id: Optional[str] = Field(
        default=None,
        description="Client-supplied idempotency/cancel key. Auto-generated if omitted.",
    )
    voice: Optional[str] = Field(default=None, description="Kokoro voice ID. Defaults to TTS_VOICE env.")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.post("/tts")
async def tts_synthesize(req: TTSRequest) -> StreamingResponse:
    """Synthesize text with Kokoro; stream raw PCM-16 LE mono 24 kHz back.

    The client sends ``{ "text": "…" }`` and receives a chunked binary stream
    of raw PCM-16 LE mono audio at 24 000 Hz.

    Response headers
    ----------------
    ``Content-Type: audio/pcm; rate=24000; channels=1; bits=16``
    ``X-TTS-Request-Id: <uuid>``   — echo the request_id for correlation.

    Cancellation
    ------------
    Call ``POST /tts/cancel { "request_id": "<id>" }`` while the response is
    streaming to abort synthesis mid-stream.  The HTTP response will end after
    the current Kokoro chunk completes.  Alternatively, close the HTTP
    connection; the server detects disconnect and stops generating.

    Barge-in
    --------
    The TS voice orchestrator calls ``/tts/cancel`` (or closes the response)
    when Silero VAD fires a speech_start during playback.
    """
    try:
        await tts_mgr.ensure_ready()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"TTS load failed: {exc}") from exc

    request_id = req.request_id or str(uuid.uuid4())
    cancel_event = asyncio.Event()
    _tts_cancel[request_id] = cancel_event

    voice = req.voice or TTS_VOICE

    async def _generate() -> AsyncGenerator[bytes, None]:
        from tts import synthesize_streaming  # type: ignore[import]

        loop = asyncio.get_running_loop()
        try:
            async for pcm_chunk in synthesize_streaming(
                text=req.text,
                pipeline=tts_mgr.get_pipeline(),
                voice=voice,
                speed=req.speed,
                cancel_event=cancel_event,
                loop=loop,
            ):
                if cancel_event.is_set():
                    log.info("TTS cancelled mid-stream (request_id=%s).", request_id)
                    return
                yield pcm_chunk
        finally:
            _tts_cancel.pop(request_id, None)

    return StreamingResponse(
        _generate(),
        media_type="audio/pcm",
        headers={
            "Content-Type": "audio/pcm; rate=24000; channels=1; bits=16",
            "X-TTS-Request-Id": request_id,
        },
    )


# ---------------------------------------------------------------------------
# /tts/cancel
# ---------------------------------------------------------------------------


class TTSCancelRequest(BaseModel):
    request_id: str


@app.post("/tts/cancel")
async def tts_cancel(req: TTSCancelRequest) -> Dict[str, Any]:
    """Signal an in-flight TTS synthesis to stop after its current chunk.

    Returns ``{ "cancelled": true }`` if the request_id was found and the
    event was set, ``{ "cancelled": false }`` if it was already done / unknown.
    """
    event = _tts_cancel.get(req.request_id)
    if event is not None:
        event.set()
        return {"cancelled": True}
    return {"cancelled": False}


# ---------------------------------------------------------------------------
# /unload
# ---------------------------------------------------------------------------


class UnloadRequest(BaseModel):
    components: Optional[List[Literal["stt", "tts", "vad", "wake"]]] = None


@app.post("/unload")
async def unload(req: UnloadRequest) -> Dict[str, Any]:
    """Unload one or more components to reclaim RAM.

    Omit ``components`` (or pass ``null``) to unload everything.  VAD shares
    the STT process, so ``"vad"`` is an alias for ``"stt"``.

    Returns ``{ "unloaded": ["stt", …] }`` with the actually-unloaded names.
    """
    targets: Set[str] = set(req.components or ["stt", "tts", "vad", "wake"])
    # "vad" is an alias for stt (they share the same manager).
    if "vad" in targets:
        targets.add("stt")

    tasks: List[asyncio.Task[None]] = []
    done: List[str] = []

    if "stt" in targets:
        tasks.append(asyncio.create_task(stt_mgr.unload()))
        done.extend(["stt", "vad"] if "vad" in targets else ["stt"])
    if "tts" in targets:
        tasks.append(asyncio.create_task(tts_mgr.unload()))
        done.append("tts")
    if "wake" in targets:
        tasks.append(asyncio.create_task(wake_mgr.unload()))
        done.append("wake")

    await asyncio.gather(*tasks, return_exceptions=True)
    gc.collect()
    return {"unloaded": done}


# ---------------------------------------------------------------------------
# /warmup
# ---------------------------------------------------------------------------


@app.post("/warmup")
async def warmup() -> Dict[str, Any]:
    """Pre-load STT + TTS and run one tiny inference each.

    Loading alone is not enough — the first faster-whisper transcribe and the
    first Kokoro synthesis JIT-compile kernels and allocate buffers, which
    costs hundreds of ms.  Warming here keeps the first real turn fast.
    Components warm independently; a failure degrades, never 500s.
    """
    loop = asyncio.get_running_loop()
    components: Dict[str, str] = {}

    try:
        await stt_mgr.ensure_ready()

        def _warm_stt() -> None:
            import numpy as np  # type: ignore[import]

            silence = np.zeros(8000, dtype=np.float32)  # 0.5 s @ 16 kHz
            segments, _info = stt_mgr.get_whisper().transcribe(
                silence, language="en", beam_size=1
            )
            for _ in segments:
                pass

        await loop.run_in_executor(None, _warm_stt)
        components["stt"] = "ready"
    except Exception as exc:  # noqa: BLE001
        components["stt"] = f"error: {exc}"

    try:
        await tts_mgr.ensure_ready()
        from tts import synthesize_streaming  # type: ignore[import]

        async for _chunk in synthesize_streaming(
            text="Ready.",
            pipeline=tts_mgr.get_pipeline(),
            voice=TTS_VOICE,
            speed=1.0,
            loop=loop,
        ):
            break  # first chunk is enough to JIT-warm
        components["tts"] = "ready"
    except Exception as exc:  # noqa: BLE001
        components["tts"] = f"error: {exc}"

    ok = all(v == "ready" for v in components.values())
    return {"state": "ready" if ok else "degraded", "components": components}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
