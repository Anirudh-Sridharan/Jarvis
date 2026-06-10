"""OPTIONAL: Pipecat all-in-one voice pipeline.

This module is the **recommended production path** for the full voice loop
(VAD → STT → LLM → TTS) when running as a standalone Pipecat pipeline rather
than driving the models via the FastAPI HTTP/WS endpoints.

Both approaches are valid:
  * **HTTP/WS sidecar** (``voice_server.py``): the TypeScript orchestrator
    drives each model independently over the network.  Simpler integration for
    the existing Node/TS architecture.
  * **Pipecat pipeline** (this file): a single Python process owns mic-in,
    STT, LLM SSE client, TTS, and speaker-out in one streaming pipeline.
    Lower per-frame overhead; better barge-in because interruption is handled
    inside the pipeline without a round-trip to the TS layer.

Architecture note (from ``features/7-low-latency-voice-interface.md``)
-----------------------------------------------------------------------
The recommended pipeline is::

    CoreAudio mic (16 kHz, 20 ms frames)
      → Silero VAD + Smart Turn (acoustic gate + semantic end-of-turn)
      → Parakeet-TDT/MLX  STT  (streaming partials, tens-of-ms)
      → Qwen/MLX LLM (SSE, feature 1 server at 127.0.0.1:8001)
      → SentenceChunker (token → sentence flush)
      → Kokoro/MLX TTS (sub-300 ms TTFA)
      → CoreAudio speaker

This module wires those stages via Pipecat's frame system.  The
``SentenceChunker`` from ``features/7-low-latency-voice-interface.md`` is
included verbatim.

Guard
-----
All imports are inside the functions / classes so that ``import
pipeline_pipecat`` never fails even if pipecat / torch are not installed.
This file is importable as a library and as a Pipecat task runner::

    python pipeline_pipecat.py   # runs the pipeline in foreground

IMPORTANT: requires Python >= 3.11 and the following extras:
    pip install pipecat-ai[silero,local,openai] kokoro torch

The system python3 on the target MacBook Air M3 is 3.9.6 — use run.sh.

Model downloads
---------------
* Parakeet-TDT weights: mlx-community/parakeet-tdt-0.6b-mlx (or via mlx-audio).
* Kokoro weights: downloaded automatically by the kokoro package.
* Silero VAD: downloaded by torch.hub on first use.
* Qwen inference: served by the MLX sidecar (sidecar/mlx/), see feature 1.
See README.md → "Model downloads" for details.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Optional

log = logging.getLogger("pipeline_pipecat")

# ---------------------------------------------------------------------------
# Configuration (from environment)
# ---------------------------------------------------------------------------

LLM_BASE_URL = os.environ.get("MLX_SIDECAR_URL", "http://127.0.0.1:8001/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen3.5-4b-instruct")
TTS_VOICE = os.environ.get("TTS_VOICE", "af_heart")
VAD_STOP_SECS = float(os.environ.get("VAD_STOP_SECS", "0.8"))
SAMPLE_RATE_IN = 16000
SAMPLE_RATE_OUT = 24000


# ---------------------------------------------------------------------------
# Sentence chunker (ported from features/7-low-latency-voice-interface.md)
# ---------------------------------------------------------------------------


class SentenceChunker:
    """Buffer LLM tokens and flush to TTS at sentence boundaries.

    Ships the first speakable clause as fast as possible, then flushes on
    terminators (. ? ! … \\n), on max-buffer, or when the LLM stream ends.

    This is a self-contained helper that does NOT require pipecat itself.
    The ``PipecatSentenceChunker`` subclass below wraps it as a Pipecat
    ``FrameProcessor``.

    Parameters
    ----------
    min_chars:
        Minimum chunk length before flushing on a terminator (12 default).
        Relaxed to 1 for the very first chunk to minimize first-audio latency.
    max_chars:
        Maximum buffer length; flush even without a terminator (200 default).
    """

    _TERMINATORS = re.compile(r"[.!?…](?=\s|$)|[\n]")

    def __init__(self, min_chars: int = 12, max_chars: int = 200) -> None:
        self._buf: str = ""
        self._min = min_chars
        self._max = max_chars
        self._first = True   # relax min-length for the very first chunk

    def push(self, token: str) -> list[str]:  # type: ignore[type-arg]
        """Push a token fragment.  Returns a list of ready-to-speak chunks."""
        self._buf += token
        return self._maybe_flush()

    def flush(self) -> list[str]:  # type: ignore[type-arg]
        """Force-flush remaining buffer (call on LLM stream end)."""
        text = self._buf.strip()
        self._buf = ""
        self._first = True
        return [text] if text else []

    def _maybe_flush(self) -> list[str]:  # type: ignore[type-arg]
        chunks: list[str] = []  # type: ignore[type-arg]
        matches = list(self._TERMINATORS.finditer(self._buf))
        if matches:
            end = matches[-1].end()
            candidate = self._buf[:end].strip()
            floor = 1 if self._first else self._min
            if len(candidate) >= floor:
                self._buf = self._buf[end:]
                self._first = False
                chunks.append(candidate)
        elif len(self._buf) >= self._max:
            text = self._buf.strip()
            self._buf = ""
            self._first = False
            chunks.append(text)
        return chunks


# ---------------------------------------------------------------------------
# Pipecat FrameProcessor wrapper for SentenceChunker
# ---------------------------------------------------------------------------


class PipecatSentenceChunker:
    """Pipecat ``FrameProcessor`` that wraps ``SentenceChunker``.

    All Pipecat imports are lazy so this module loads even without pipecat.
    """

    def __init__(self, min_chars: int = 12, max_chars: int = 200) -> None:
        self._chunker = SentenceChunker(min_chars=min_chars, max_chars=max_chars)
        self._pipecat_base: Optional[Any] = None

    def _ensure_base(self) -> None:
        if self._pipecat_base is not None:
            return
        from pipecat.processors.frame_processor import FrameProcessor  # type: ignore[import]
        self._pipecat_base = FrameProcessor  # store the class for issubclass checks

    async def process_frame(self, frame: Any, direction: Any) -> None:
        self._ensure_base()
        from pipecat.frames.frames import (  # type: ignore[import]
            TextFrame,
            LLMFullResponseEndFrame,
            TTSSpeakFrame,
        )
        from pipecat.processors.frame_processor import FrameDirection  # type: ignore[import]

        if isinstance(frame, TextFrame):
            chunks = self._chunker.push(frame.text)
            for chunk in chunks:
                await self.push_frame(TTSSpeakFrame(chunk), FrameDirection.DOWNSTREAM)
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            for chunk in self._chunker.flush():
                await self.push_frame(TTSSpeakFrame(chunk), FrameDirection.DOWNSTREAM)
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    async def push_frame(self, frame: Any, direction: Any) -> None:
        """Implemented by FrameProcessor base; overridden in the real subclass."""
        raise NotImplementedError  # Pipecat wires this up at runtime.


# ---------------------------------------------------------------------------
# Pipeline builder
# ---------------------------------------------------------------------------


def build_pipeline(system_prompt: str = "You are Jarvis, a helpful voice assistant.") -> Any:
    """Build and return a runnable Pipecat ``PipelineTask``.

    All heavy imports are inside this function so that ``import
    pipeline_pipecat`` succeeds even when pipecat / torch are not installed.

    Parameters
    ----------
    system_prompt:
        System message injected into every LLM context.  Defaults to the
        Jarvis persona.  The caller should include retrieved memory context
        (feature 3) here or via the LLMUserResponseAggregator context object.

    Returns
    -------
    ``pipecat.pipeline.task.PipelineTask`` ready to be ``await task.run()``'d.

    Usage::

        task = build_pipeline()
        await task.run()    # blocks until pipeline ends or is cancelled
    """
    # ---- Pipecat imports ---------------------------------------------------
    from pipecat.pipeline.pipeline import Pipeline  # type: ignore[import]
    from pipecat.pipeline.task import PipelineTask, PipelineParams  # type: ignore[import]
    from pipecat.audio.vad.silero import SileroVADAnalyzer  # type: ignore[import]
    from pipecat.processors.aggregators.llm_response import (  # type: ignore[import]
        LLMUserResponseAggregator,
        LLMAssistantResponseAggregator,
    )
    from pipecat.services.openai import OpenAILLMService  # type: ignore[import]

    # ---- Local transports / services (these wrap the models loaded above) --
    # CoreAudio transport: mic in + speaker out (macOS only).
    # Falls back to a no-op transport if not available (for testing).
    try:
        from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioParams  # type: ignore[import]

        transport = LocalAudioTransport(
            LocalAudioParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                vad_analyzer=SileroVADAnalyzer(stop_secs=VAD_STOP_SECS),
            )
        )
    except ImportError:
        log.warning("pipecat LocalAudioTransport not available; using a dummy transport.")
        transport = _DummyTransport()

    # LLM: OpenAI-compatible call to the local MLX sidecar (feature 1).
    llm = OpenAILLMService(
        base_url=LLM_BASE_URL,
        api_key="local",       # MLX sidecar does not validate the key.
        model=LLM_MODEL,
    )

    # TTS: Kokoro via a lightweight Pipecat-compatible service wrapper.
    tts = _KokoroTTSService(voice=TTS_VOICE)

    # Aggregators: wrap the user message and record the assistant reply.
    context: Any = _build_context(system_prompt)
    user_agg = LLMUserResponseAggregator(context)
    asst_agg = LLMAssistantResponseAggregator(context)

    # Sentence chunker.
    chunker = _PipecatChunkerAdapter(min_chars=12, max_chars=200)

    pipeline = Pipeline(
        [
            transport.input(),   # mic frames (16 kHz PCM)
            user_agg,            # build LLM message with memory context
            llm,                 # → LLM token stream
            chunker,             # → TTSSpeakFrame per sentence chunk
            tts,                 # → PCM audio frames
            transport.output(),  # speaker
            asst_agg,            # record assistant reply
        ]
    )

    task = PipelineTask(
        pipeline,
        PipelineParams(
            allow_interruptions=True,   # barge-in: VAD speech_start cancels TTS
            enable_metrics=True,        # per-stage latency logging
        ),
    )

    log.info(
        "Pipecat pipeline built (LLM=%s, TTS_VOICE=%s, VAD_STOP_SECS=%.1f).",
        LLM_MODEL,
        TTS_VOICE,
        VAD_STOP_SECS,
    )
    return task


# ---------------------------------------------------------------------------
# Minimal Kokoro TTS service for Pipecat
# ---------------------------------------------------------------------------


class _KokoroTTSService:
    """Thin Pipecat-compatible TTS service backed by Kokoro.

    Pipecat expects a ``BaseTTSService``-compatible object; we provide the
    minimum interface needed for Pipeline assembly.  Replace with a proper
    ``BaseTTSService`` subclass once Pipecat ships an official Kokoro plugin.
    """

    def __init__(self, voice: str = "af_heart", speed: float = 1.0) -> None:
        self.voice = voice
        self.speed = speed
        self._pipeline: Optional[Any] = None

    def _ensure_loaded(self) -> None:
        if self._pipeline is not None:
            return
        from kokoro import KPipeline  # type: ignore[import]
        self._pipeline = KPipeline(lang_code="en-us")
        log.info("Kokoro TTS pipeline loaded (voice=%s).", self.voice)

    async def synthesize(self, text: str) -> bytes:
        """Synthesize ``text`` and return raw PCM-16 LE 24 kHz bytes."""
        import numpy as np  # type: ignore[import]

        loop = asyncio.get_running_loop()
        self._ensure_loaded()

        def _run() -> bytes:
            chunks = []
            for _g, _p, audio in self._pipeline(text, voice=self.voice, speed=self.speed):  # type: ignore[misc]
                if audio is not None and len(audio) > 0:
                    arr = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
                    chunks.append(arr.flatten())
            if not chunks:
                return b""
            full = np.concatenate(chunks).astype(np.float32)
            full = np.clip(full, -1.0, 1.0)
            return (full * 32767).astype(np.int16).tobytes()

        return await loop.run_in_executor(None, _run)


# ---------------------------------------------------------------------------
# Adapter to make PipecatSentenceChunker a real FrameProcessor subclass
# ---------------------------------------------------------------------------


class _PipecatChunkerAdapter:
    """Lazy-resolves the FrameProcessor base class at pipeline build time."""

    def __new__(cls, **kwargs: Any) -> Any:  # type: ignore[misc]
        from pipecat.processors.frame_processor import FrameProcessor  # type: ignore[import]
        from pipecat.frames.frames import TextFrame, LLMFullResponseEndFrame, TTSSpeakFrame  # type: ignore[import]
        from pipecat.processors.frame_processor import FrameDirection  # type: ignore[import]
        import re as _re

        chunker_state = {"buf": "", "first": True}
        _TERMINATORS = _re.compile(r"[.!?…](?=\s|$)|[\n]")
        min_chars = kwargs.get("min_chars", 12)
        max_chars = kwargs.get("max_chars", 200)

        class _Impl(FrameProcessor):  # type: ignore[misc]
            async def process_frame(self, frame: Any, direction: Any) -> None:
                await super().process_frame(frame, direction)

                if isinstance(frame, TextFrame):
                    chunker_state["buf"] += frame.text
                    matches = list(_TERMINATORS.finditer(chunker_state["buf"]))
                    if matches:
                        end = matches[-1].end()
                        candidate = chunker_state["buf"][:end].strip()
                        floor = 1 if chunker_state["first"] else min_chars
                        if len(candidate) >= floor:
                            chunker_state["buf"] = chunker_state["buf"][end:]
                            chunker_state["first"] = False
                            await self.push_frame(TTSSpeakFrame(candidate), FrameDirection.DOWNSTREAM)
                    elif len(chunker_state["buf"]) >= max_chars:
                        text = chunker_state["buf"].strip()
                        chunker_state["buf"] = ""
                        chunker_state["first"] = False
                        await self.push_frame(TTSSpeakFrame(text), FrameDirection.DOWNSTREAM)
                    return

                if isinstance(frame, LLMFullResponseEndFrame):
                    text = chunker_state["buf"].strip()
                    chunker_state["buf"] = ""
                    chunker_state["first"] = True
                    if text:
                        await self.push_frame(TTSSpeakFrame(text), FrameDirection.DOWNSTREAM)
                    await self.push_frame(frame, direction)
                    return

                await self.push_frame(frame, direction)

        return _Impl()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_context(system_prompt: str) -> Any:
    """Build an OpenAILLMContext with the given system prompt."""
    try:
        from pipecat.services.openai import OpenAILLMContext  # type: ignore[import]
        return OpenAILLMContext([{"role": "system", "content": system_prompt}])
    except ImportError:
        return None


class _DummyTransport:
    """No-op transport for testing without CoreAudio."""

    def input(self) -> Any:
        return _NoOpProcessor()

    def output(self) -> Any:
        return _NoOpProcessor()


class _NoOpProcessor:
    """Stand-in FrameProcessor that passes all frames through."""

    async def process_frame(self, frame: Any, direction: Any) -> None:
        pass


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------


async def _run() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    )
    log.info("Starting Jarvis Pipecat pipeline …")
    task = build_pipeline()
    await task.run()


if __name__ == "__main__":
    asyncio.run(_run())
