"""Jarvis Voice sidecar — Phase 3 audio model server.

Exposes STT (faster-whisper + Silero VAD), TTS (Kokoro), wake word
(openWakeWord) and lifecycle endpoints over HTTP/WebSocket so the TypeScript
voice orchestrator (``@jarvis/voice``) can drive all audio models without
importing Python.

Contract (keep exact — the TS ``voiceClient`` calls these):

    GET  /health
        → { state, components: { stt, tts, vad, wake },
            stt_engine: { configured, active, reason },
            tts_engine: { configured, active, reason } }

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

    POST /tts   { "text": "…", "request_id": "<optional uuid>", "engine": "kokoro|aura" }
        → Streams raw PCM-16 LE mono 24 kHz audio chunks (Content-Type:
          audio/pcm; rate=24000).  Request-id header ``X-TTS-Request-Id``
          echoed back.  ``engine`` is optional (defaults to the TTS_ENGINE
          env value); Kokoro is always the default and the fallback — an
          Aura failure yields Kokoro audio for the same request, never a
          500 or silence.  Close the response / call /tts/cancel to abort.

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
import functools
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

# Kokoro voice. Plain voice IDs ("bm_fable") work, as do blends:
#   "name:weight,name:weight"  e.g.  "bm_george:0.7,bf_emma:0.3"
# Blending averages the voicepack style tensors.  The default blends
# bm_george (male timbre) with bf_emma — the only B-grade British voice in
# Kokoro (hours of training data vs minutes for every British male) — to
# borrow her prosody.  All blended voices must share the language, and the
# voice prefix must agree with TTS_LANG (b* ↔ en-gb, a* ↔ en-us).
TTS_VOICE = os.environ.get("TTS_VOICE", "bm_george:0.7,bf_emma:0.3")
TTS_LANG = os.environ.get("TTS_LANG", "en-gb")

# Kokoro's KPipeline takes single-letter lang codes; map the friendly names
# explicitly so we don't depend on the library's alias table.
_KOKORO_LANG_CODES = {"en-us": "a", "en-gb": "b", "a": "a", "b": "b"}
TTS_LANG_CODE = _KOKORO_LANG_CODES.get(TTS_LANG.lower(), TTS_LANG)

# Silero VAD threshold (0..1); lower = more sensitive.
VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.5"))

# Wake word model path or name recognised by openWakeWord.
WAKE_WORD_MODEL = os.environ.get("WAKE_WORD_MODEL", "hey_jarvis")

# Deepgram streaming-STT config. The key is read ONCE here and is never
# logged, printed, or returned by any endpoint — /health only ever reports
# whether an engine is configured/active and a short, key-free reason.
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY")  # None = disabled
DEEPGRAM_MODEL = os.environ.get("DEEPGRAM_MODEL", "nova-3")
DEEPGRAM_STT_ENABLED = os.environ.get("DEEPGRAM_STT_ENABLED", "1")
DEEPGRAM_CONNECT_TIMEOUT_MS = int(os.environ.get("DEEPGRAM_CONNECT_TIMEOUT_MS", "2000"))
DEEPGRAM_FINALIZE_TIMEOUT_MS = int(os.environ.get("DEEPGRAM_FINALIZE_TIMEOUT_MS", "600"))

# Deepgram Aura-2 streaming-TTS config (parallel to the STT block above).
# "aura" (voice aura-2-draco-en) is the default by EXPLICIT USER DECISION in
# the plan 13.2-06 listening checkpoint (2026-08-01, "use aura-draco" — user
# wanted a deeper voice; measured mean TTFB 542ms vs Kokoro's 2370ms). The
# Kokoro British blend remains the automatic fallback whenever the key is
# absent or Aura fails mid-request (13.2-CONTEXT.md D-05).
TTS_ENGINE = os.environ.get("TTS_ENGINE", "aura")
DEEPGRAM_TTS_MODEL = os.environ.get("DEEPGRAM_TTS_MODEL", "aura-2-draco-en")

# Sidecar-side echo gate (round-2 live defect fix — see echo_gate.py's module
# docstring and .planning/debug/deepgram-stt-live-defects.md). During an
# active/recently-active TTS synthesis window, partial/final STT frames whose
# text fuzzy-matches the synthesized text are DROPPED before the WebSocket:
# Nova-3 re-hears no-AEC speaker echo as different words than were spoken, so
# the TS client's token-containment echo filter cannot catch them and every
# reply self-cancels via spurious confirmed barge-in. Dropping a frame is
# invisible to the TS client (additive-only WS contract change).
JARVIS_ECHO_GATE = os.environ.get("JARVIS_ECHO_GATE", "1")
JARVIS_ECHO_SIM_THRESHOLD = float(os.environ.get("JARVIS_ECHO_SIM_THRESHOLD", "0.72"))
JARVIS_ECHO_CONF_THRESHOLD = float(os.environ.get("JARVIS_ECHO_CONF_THRESHOLD", "0.85"))
JARVIS_ECHO_DECAY_MS = int(os.environ.get("JARVIS_ECHO_DECAY_MS", "3000"))

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

# Shared between /tts (registers synthesis windows) and /stt/stream (gates
# echo-suspect transcripts). Selftests replace this with a clock-injected
# instance; live config comes from the JARVIS_ECHO_* env values above.
from echo_gate import EchoGate  # noqa: E402  (import after config block, stdlib-only module)

echo_gate = EchoGate(
    enabled=JARVIS_ECHO_GATE != "0",
    sim_threshold=JARVIS_ECHO_SIM_THRESHOLD,
    conf_threshold=JARVIS_ECHO_CONF_THRESHOLD,
    decay_s=JARVIS_ECHO_DECAY_MS / 1000,
)

# In-flight TTS cancellation registry: request_id → asyncio.Event
_tts_cancel: Dict[str, asyncio.Event] = {}

# Resolved voice cache: spec string → str | torch.FloatTensor.
_resolved_voices: Dict[str, Any] = {}

# Active STT engine status, updated at session start and on mid-session
# Deepgram death. Surfaced verbatim (minus the key, which never enters this
# dict) via GET /health's top-level "stt_engine" key.
_stt_engine_status: Dict[str, Optional[str]] = {"active": None, "reason": None}


def _configured_stt_engine() -> str:
    """Which STT engine is configured (not necessarily currently active)."""
    if DEEPGRAM_API_KEY and DEEPGRAM_STT_ENABLED != "0":
        return "deepgram"
    return "faster-whisper"


def _configured_stt_reason() -> Optional[str]:
    """Why the configured engine is faster-whisper, or None when deepgram."""
    if not DEEPGRAM_API_KEY:
        return "DEEPGRAM_API_KEY not set"
    if DEEPGRAM_STT_ENABLED == "0":
        return "DEEPGRAM_STT_ENABLED=0"
    return None


# Active TTS engine status, updated at each /tts request. Surfaced verbatim
# (minus the key, which never enters this dict) via GET /health's top-level
# "tts_engine" key — mirrors _stt_engine_status above.
_tts_engine_status: Dict[str, Optional[str]] = {"active": None, "reason": None}


def _configured_tts_engine() -> str:
    """Which TTS engine is configured (not necessarily last active).

    "aura" only when TTS_ENGINE asks for it AND a key is present; otherwise
    "kokoro" — the committed default (D-05).
    """
    if TTS_ENGINE.lower() == "aura" and DEEPGRAM_API_KEY:
        return "aura"
    return "kokoro"


def _configured_tts_reason() -> Optional[str]:
    """Why the configured engine is kokoro, or None when aura."""
    if TTS_ENGINE.lower() == "aura" and not DEEPGRAM_API_KEY:
        return "DEEPGRAM_API_KEY not set"
    return None


def resolve_voice(pipeline: Any, spec: str) -> Any:
    """Resolve a voice spec to what KPipeline accepts (str or style tensor).

    Plain names ("bm_fable") and unweighted comma lists ("bm_george,bf_emma" —
    KPipeline averages those natively) pass through as strings.  Weighted
    blends use "name:weight,..." and resolve to a weighted average of the
    voicepack tensors via pipeline.load_voice().
    """
    if ":" not in spec:
        return spec
    import torch  # type: ignore[import]

    parts: List[tuple] = []
    for entry in spec.split(","):
        name, _, weight_s = entry.strip().partition(":")
        parts.append((name.strip(), float(weight_s) if weight_s else 1.0))
    total = sum(w for _, w in parts)
    if total <= 0:
        raise ValueError(f"voice blend has non-positive total weight: {spec!r}")
    return torch.stack(
        [pipeline.load_voice(name) * (w / total) for name, w in parts]
    ).sum(dim=0)


def _voice_for(spec: str) -> Any:
    """Cached resolve_voice against the loaded pipeline."""
    if spec not in _resolved_voices:
        _resolved_voices[spec] = resolve_voice(tts_mgr.get_pipeline(), spec)
    return _resolved_voices[spec]


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
          },
          "stt_engine": {
            "configured": "deepgram" | "faster-whisper",
            "active": "deepgram" | "faster-whisper" | null,
            "reason": "<short, key-free degradation reason>" | null
          },
          "tts_engine": {
            "configured": "aura" | "kokoro",
            "active": "aura" | "kokoro" | null,
            "reason": "<short, key-free degradation reason>" | null
          }
        }

    ``stt_engine``/``tts_engine`` are ADDITIVE TOP-LEVEL keys (never inside
    ``components`` — an engine name there would permanently force ``state``
    to "degraded" since the overall-state computation below iterates
    ``components.values()``, which stays exactly the four existing keys).
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
    return {
        "state": overall,
        "components": components,
        "stt_engine": {
            "configured": _configured_stt_engine(),
            "active": _stt_engine_status["active"],
            "reason": _stt_engine_status["reason"] or _configured_stt_reason(),
        },
        "tts_engine": {
            "configured": _configured_tts_engine(),
            "active": _tts_engine_status["active"],
            "reason": _tts_engine_status["reason"] or _configured_tts_reason(),
        },
    }


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
    faster-whisper (small int8) is the default.  When ``DEEPGRAM_API_KEY`` is
    configured, Deepgram's streaming ``/v1/listen`` supplies the text instead
    — Silero VAD still owns every ``speech_start``/``speech_end``/
    ``silence_ms`` boundary (see ``deepgram_stt.py``'s module docstring); a
    missing key, failed connect, or mid-session socket death degrades to
    faster-whisper automatically and is surfaced on ``GET /health``'s
    ``stt_engine`` key, never as an ``error`` frame or an abnormal close.
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
    import stt  # type: ignore[import]  # module reference, for stt.SAMPLE_RATE below

    buf = AudioBuffer()
    loop = asyncio.get_running_loop()

    async def _send(obj: Dict[str, Any]) -> None:
        try:
            await ws.send_text(json.dumps(obj))
        except Exception:  # noqa: BLE001
            pass

    def _echo_suppressed(frame: Dict[str, Any], word_confs: Any = None) -> bool:
        """True when the echo gate says to drop this partial/final frame.

        Only text frames are ever gated — speech_start/speech_end/error pass
        untouched (Silero remains the sole boundary authority; the gate drops
        TEXT the mic heard Jarvis say, never VAD state).
        """
        if frame.get("type") not in ("partial", "final"):
            return False
        mean_conf: Optional[float] = None
        if word_confs:
            try:
                mean_conf = sum(word_confs) / len(word_confs)
            except (TypeError, ZeroDivisionError):
                mean_conf = None
        reason = echo_gate.check(frame.get("text") or "", mean_conf)
        if reason is None:
            return False
        log.info(
            "Echo gate suppressed %s (%s): %.60r",
            frame.get("type"), reason, frame.get("text"),
        )
        return True

    # -----------------------------------------------------------------------
    # STT engine selection — attempted once, at session start, before the mic
    # loop. Silero VAD (below) remains the sole speech_start/speech_end/
    # silence_ms authority regardless of which engine wins; Deepgram only
    # ever supplies text, finalized on Silero's own cue (Pitfall 1).
    # -----------------------------------------------------------------------
    session: Any = None
    use_deepgram = False
    if _configured_stt_engine() == "deepgram":
        import deepgram_stt  # type: ignore[import]  # lazy, module-level so tests can patch the class

        session = deepgram_stt.DeepgramSttSession(
            DEEPGRAM_API_KEY,
            DEEPGRAM_MODEL,
            stt.SAMPLE_RATE,
            DEEPGRAM_CONNECT_TIMEOUT_MS / 1000,
            DEEPGRAM_FINALIZE_TIMEOUT_MS / 1000,
        )
        use_deepgram = await session.connect()
        if use_deepgram:
            log.info("STT engine: deepgram (model=%s).", DEEPGRAM_MODEL)
            _stt_engine_status["active"] = "deepgram"
            _stt_engine_status["reason"] = None
        else:
            # A failed connect must never send an error frame or abnormally
            # close the socket — those are reserved for a genuine STT load
            # failure above.
            _stt_engine_status["active"] = "faster-whisper"
            _stt_engine_status["reason"] = session.last_error
            log.warning(
                "Deepgram STT unavailable (falling back to faster-whisper): %s",
                session.last_error,
            )

    try:
        async for message in ws.iter_bytes():
            buf.extend(message)

            if use_deepgram:
                sent_ok = await session.send_audio(message)
                if not sent_ok:
                    # Mid-session death: only the in-flight segment's text is
                    # lost, and that loss is logged. Deliberately no retry
                    # loop here (out of scope; a PTT session is seconds long).
                    use_deepgram = False
                    _stt_engine_status["active"] = "faster-whisper"
                    _stt_engine_status["reason"] = session.last_error
                    log.warning(
                        "Deepgram STT lost mid-session (falling back to faster-whisper): %s",
                        session.last_error,
                    )
                    await session.close()

            # Run VAD + transcription step on executor so we don't block the
            # loop. transcribe is explicitly the inverse of use_deepgram: the
            # Whisper decode never runs while Deepgram is serving the segment.
            events = await loop.run_in_executor(
                None,
                functools.partial(
                    run_vad_and_transcribe,
                    buf,
                    stt_mgr.get_vad_model(),
                    stt_mgr.get_whisper(),
                    VAD_THRESHOLD,
                    transcribe=not use_deepgram,
                ),
            )
            for event in events:
                # Echo gate: during an active TTS window, faster-whisper
                # partials/finals that match the synthesized text are echo —
                # drop the frame (VAD frames always pass).
                if not _echo_suppressed(event):
                    await _send(event)
                # Silero's speech_start opens the Deepgram text segment: the
                # session discards anything Deepgram transcribed OUTSIDE a
                # Silero segment (speaker echo, noise, late tails of already-
                # finalized segments) instead of banking it into this one
                # (live defect: duplicated/garbled finals — see
                # .planning/debug/deepgram-stt-live-defects.md).
                if use_deepgram and event.get("type") == "speech_start":
                    session.begin_segment()
                # speech_end is sent BEFORE the Finalize flush is awaited —
                # this ordering is load-bearing (the orchestrator commits
                # finals only after it has seen the segment's speech_end).
                if use_deepgram and event.get("type") == "speech_end":
                    final_frame = await session.finalize_segment()
                    if final_frame is not None and not _echo_suppressed(
                        final_frame, getattr(session, "last_word_confs", None)
                    ):
                        await _send(final_frame)

            if use_deepgram:
                for partial_frame in session.drain_partials():
                    if not _echo_suppressed(partial_frame):
                        await _send(partial_frame)

    except WebSocketDisconnect:
        log.info("STT WebSocket disconnected (client close / barge-in).")
    except Exception as exc:  # noqa: BLE001
        log.exception("STT WebSocket error: %s", exc)
        try:
            await ws.send_text(json.dumps({"type": "error", "detail": str(exc)}))
        except Exception:  # noqa: BLE001
            pass
    finally:
        if session is not None:
            try:
                await session.close()
            except Exception:  # noqa: BLE001
                pass
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
    voice: Optional[str] = Field(
        default=None,
        description=(
            "Engine-scoped voice id. Kokoro id/blend spec applies only on the "
            "kokoro path (defaults to TTS_VOICE env); on the aura path only "
            "aura-* ids are honored (else DEEPGRAM_TTS_MODEL)."
        ),
    )
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    engine: Optional[str] = Field(
        default=None, description="kokoro | aura — defaults to the TTS_ENGINE env value."
    )


@app.post("/tts")
async def tts_synthesize(req: TTSRequest) -> StreamingResponse:
    """Synthesize text with Kokoro or Aura-2; stream raw PCM-16 LE mono 24 kHz.

    The client sends ``{ "text": "…" }`` and receives a chunked binary stream
    of raw PCM-16 LE mono audio at 24 000 Hz — identical for both engines.

    Engine selection
    ----------------
    ``req.engine`` (``"kokoro"`` | ``"aura"``) overrides the ``TTS_ENGINE`` env
    default for this one request; the TS client never sends it, so a live
    conversation is governed entirely by the sidecar's own env. Anything
    other than exactly ``"aura"`` is treated as ``"kokoro"``. Requesting
    ``"aura"`` with no ``DEEPGRAM_API_KEY`` configured degrades to Kokoro
    (never a 400/503) — see ``GET /health``'s ``tts_engine.reason``. A zero-
    byte Aura stream mid-request also falls through to Kokoro for the SAME
    request, so a failed cloud voice never produces silence.

    ``voice`` is engine-scoped: on the Aura path only Aura-shaped ids
    (``aura-…``, e.g. ``aura-2-pandora-en``) are honored — a Kokoro voice id
    or blend spec (such as a set ``JARVIS_TTS_VOICE``, which predates Aura
    and always means "Kokoro voice") is never forwarded to Deepgram as a
    (bogus) Aura model; the Aura voice stays ``DEEPGRAM_TTS_MODEL``. A
    Kokoro-shaped ``voice`` applies only when the request resolves to the
    kokoro engine.

    Response headers
    ----------------
    ``Content-Type: audio/pcm; rate=24000; channels=1; bits=16``
    ``X-TTS-Request-Id: <uuid>``   — echo the request_id for correlation.

    Cancellation
    ------------
    Call ``POST /tts/cancel { "request_id": "<id>" }`` while the response is
    streaming to abort synthesis mid-stream.  The HTTP response will end after
    the current chunk completes, for either engine.  Alternatively, close the
    HTTP connection; the server detects disconnect and stops generating.

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

    # Resolve the engine BEFORE resolving the voice — an Aura voice id must
    # never enter the Kokoro-only _resolved_voices cache below.
    requested_engine = (req.engine or TTS_ENGINE).lower()
    if requested_engine != "aura":
        requested_engine = "kokoro"
    use_aura = requested_engine == "aura"

    if use_aura and not DEEPGRAM_API_KEY:
        # An unset key must degrade to Kokoro, never 400/503 (D-05 / T-13.2-10).
        use_aura = False
        _tts_engine_status["reason"] = "DEEPGRAM_API_KEY not set"
    else:
        _tts_engine_status["reason"] = None

    if use_aura:
        # Plain string — Aura voice ids are never cached/resolved via
        # _voice_for (that cache is Kokoro-only).
        #
        # Voice-shape rule (WR-03): only an Aura-shaped id ("aura-…", e.g.
        # "aura-2-draco-en") is forwarded to Deepgram. A Kokoro-style value
        # (plain id or "name:weight,…" blend — exactly what the TS client
        # sends whenever JARVIS_TTS_VOICE is set, a knob that predates Aura
        # and always means "Kokoro voice") would reach Deepgram as an
        # invalid model: every request would pay a failed handshake and fall
        # back to Kokoro, silently defeating the user-chosen Aura default
        # (commit 81eb736). Kokoro-shaped voices therefore apply only when
        # the request's engine resolves to kokoro.
        requested_voice = (req.voice or "").strip()
        aura_voice = requested_voice if requested_voice.startswith("aura-") else DEEPGRAM_TTS_MODEL
        kokoro_voice = None
    else:
        try:
            kokoro_voice = _voice_for(req.voice or TTS_VOICE)
        except Exception as exc:  # noqa: BLE001  (bad blend spec / unknown voice)
            _tts_cancel.pop(request_id, None)
            raise HTTPException(status_code=400, detail=f"bad voice spec: {exc}") from exc
        aura_voice = None

    async def _generate() -> AsyncGenerator[bytes, None]:
        from tts import synthesize_streaming  # type: ignore[import]

        loop = asyncio.get_running_loop()

        # Echo gate: this request's text is about to come out of the
        # speakers — register the synthesis window so /stt/stream can drop
        # transcripts of the echo (see echo_gate.py).
        echo_gate.register_start(request_id, req.text)

        async def _kokoro_chunks(voice: Any) -> AsyncGenerator[bytes, None]:
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
                echo_gate.note_audio_bytes(request_id, len(pcm_chunk))
                yield pcm_chunk

        try:
            if use_aura:
                import deepgram_tts  # type: ignore[import]

                bytes_yielded = 0
                async for pcm_chunk in deepgram_tts.synthesize_streaming_aura(
                    text=req.text,
                    api_key=DEEPGRAM_API_KEY,
                    voice=aura_voice,
                    cancel_event=cancel_event,
                ):
                    if cancel_event.is_set():
                        log.info("TTS cancelled mid-stream (request_id=%s).", request_id)
                        return
                    bytes_yielded += len(pcm_chunk)
                    echo_gate.note_audio_bytes(request_id, len(pcm_chunk))
                    yield pcm_chunk

                if cancel_event.is_set():
                    return

                if bytes_yielded > 0:
                    _tts_engine_status["active"] = "aura"
                    return

                # Zero bytes and not cancelled: Aura failed somewhere between
                # connect and Flushed (deepgram_tts.py already logged the
                # specific reason on its own). A failed cloud voice must
                # never produce silence — fall through to Kokoro for the
                # SAME request (T-13.2-10).
                reason = f"Aura produced no audio for request_id={request_id}"
                log.warning("Aura TTS unavailable (falling back to Kokoro): %s", reason)
                _tts_engine_status["active"] = "kokoro"
                _tts_engine_status["reason"] = reason[:200]
                try:
                    fallback_voice = _voice_for(TTS_VOICE)
                except Exception as exc:  # noqa: BLE001
                    log.warning("Kokoro fallback voice resolution failed: %s", exc)
                    return
                async for pcm_chunk in _kokoro_chunks(fallback_voice):
                    yield pcm_chunk
            else:
                _tts_engine_status["active"] = "kokoro"
                async for pcm_chunk in _kokoro_chunks(kokoro_voice):
                    yield pcm_chunk
        finally:
            _tts_cancel.pop(request_id, None)
            echo_gate.register_end(request_id)

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
        _resolved_voices.clear()  # voicepack tensors die with the pipeline
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
            voice=_voice_for(TTS_VOICE),
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
