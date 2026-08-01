"""Deepgram streaming-STT client for the voice sidecar's ``/stt/stream`` boundary.

Design: Silero VAD (``sidecar/voice/stt.py``) remains the sole authority for
``speech_start``/``speech_end``/``silence_ms`` — this module never
re-implements or overrides those signals. Deepgram is used purely as a
faster/more accurate text source: audio frames are streamed to Deepgram's
``/v1/listen`` endpoint in parallel with Silero's own local VAD step, and a
segment's finalized transcript is force-flushed via the
``{"type": "Finalize"}`` control message the instant Silero's hangover
threshold detects ``speech_end`` (RESEARCH.md Architecture Pattern 1;
Pitfalls 1-2: Deepgram's own ``speech_final``/``UtteranceEnd`` events must
never be allowed to drive segment boundaries themselves — they can lag or
disagree with Silero on a fanless-mic capture path).

This module is deliberately split into a pure, network-free translation core
(``build_listen_url``, ``parse_results``, ``SegmentAccumulator``) — covered
by ``selftest.py`` with zero network and zero credential — and an I/O layer
(``DeepgramSttSession``) that owns the actual WebSocket connection. Wiring
this into ``voice_server.py``'s ``/stt/stream`` handler is deferred to plan
13.2-03; this module is standalone and unused by the running sidecar until
then.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, List, NamedTuple, Optional
from urllib.parse import urlencode

log = logging.getLogger("deepgram_stt")

# ---------------------------------------------------------------------------
# Module constants
# ---------------------------------------------------------------------------

DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen"
DEFAULT_MODEL = "nova-3"

# Hz — MUST stay tied to stt.py's SAMPLE_RATE. Deepgram trusts the declared
# sample_rate query parameter blindly; a mismatch silently corrupts
# transcription rather than raising an error (Pitfall 3).
SAMPLE_RATE = 16000

DEFAULT_CONNECT_TIMEOUT_S = 2.0
DEFAULT_FINALIZE_TIMEOUT_S = 0.6

# Exception descriptions are truncated to this many characters before being
# logged/stored in last_error — Deepgram/websockets exception text is
# external-ish (can echo request details) and must stay bounded (T-13.2-01).
MAX_ERROR_CHARS = 200


# ---------------------------------------------------------------------------
# Pure helpers — no I/O, no os.environ, no websockets reference.
# These are what selftest.py asserts on with zero network and zero key.
# ---------------------------------------------------------------------------


def build_listen_url(model: str = DEFAULT_MODEL, sample_rate: int = SAMPLE_RATE) -> str:
    """Build the Deepgram ``/v1/listen`` WebSocket URL.

    Auth is header-only (``Authorization: Token <key>``) — this function
    intentionally accepts no credential parameter at all. A key placed in a
    query string would leak into logs, proxies, and error strings wherever
    this URL is subsequently printed (Security Domain, T-13.2-01).
    """
    params = {
        "model": model,
        "language": "en",
        "encoding": "linear16",
        "sample_rate": sample_rate,
        "channels": 1,
        "interim_results": "true",
        "smart_format": "true",
        "punctuate": "true",
        "endpointing": 300,
        "utterance_end_ms": 1000,
        "vad_events": "true",
    }
    return f"{DEEPGRAM_LISTEN_URL}?{urlencode(params)}"


class DgResult(NamedTuple):
    """One parsed Deepgram ``Results`` message."""

    transcript: str
    confidence: float
    is_final: bool
    speech_final: bool
    from_finalize: bool


def parse_results(msg: dict) -> Optional[DgResult]:
    """Translate one Deepgram message into a ``DgResult``, or ``None``.

    Returns ``None`` for any message whose ``type`` is not ``"Results"``, and
    defensively returns ``None`` when ``channel``/``channel.alternatives`` is
    missing, malformed, or empty. Never raises: Deepgram JSON is external
    input, and a ``KeyError``/``TypeError`` here would kill the mic session
    (Threat T-13.2-05).
    """
    try:
        if not isinstance(msg, dict) or msg.get("type") != "Results":
            return None

        channel = msg.get("channel")
        if not isinstance(channel, dict):
            return None

        alternatives = channel.get("alternatives")
        if not isinstance(alternatives, list) or not alternatives:
            return None

        first = alternatives[0]
        if not isinstance(first, dict):
            return None

        transcript = first.get("transcript") or ""
        confidence = first.get("confidence")
        if confidence is None:
            confidence = 0.0

        return DgResult(
            transcript=str(transcript),
            confidence=float(confidence),
            is_final=bool(msg.get("is_final", False)),
            speech_final=bool(msg.get("speech_final", False)),
            from_finalize=bool(msg.get("from_finalize", False)),
        )
    except Exception:  # noqa: BLE001 — external JSON must never raise into the caller
        return None


class SegmentAccumulator:
    """Accumulates Deepgram interim/final results into sidecar frame dicts.

    Deepgram sends many interim (``is_final=False``) messages per segment
    plus one or more ``is_final=True`` messages as words lock in. This class
    banks finalized transcript pieces and only forwards a ``partial`` frame
    when the composed (banked-final + current interim) text actually
    changes — forwarding every interim verbatim would flood the WebSocket
    with near-duplicate partials (Pitfall 5).
    """

    def __init__(self) -> None:
        self._finalized_transcripts: List[str] = []
        self._finalized_confidences: List[float] = []
        self._last_partial_text: Optional[str] = None

    def feed(self, result: DgResult) -> Optional[dict]:
        """Feed one ``DgResult``. Returns a ``partial`` frame dict or ``None``."""
        if result.is_final:
            text = result.transcript.strip()
            if text:
                self._finalized_transcripts.append(text)
                self._finalized_confidences.append(result.confidence)
            return None

        composed = self._compose(result.transcript)
        if composed == self._last_partial_text:
            return None
        self._last_partial_text = composed
        return {"type": "partial", "text": composed, "stability": 0.5}

    def _compose(self, interim_text: str) -> str:
        parts = list(self._finalized_transcripts)
        interim_text = (interim_text or "").strip()
        if interim_text:
            parts.append(interim_text)
        return " ".join(parts).strip()

    def take_final(self) -> Optional[dict]:
        """Return the banked ``final`` frame (or ``None`` if empty), then reset."""
        text = " ".join(self._finalized_transcripts).strip()
        frame: Optional[dict] = None
        if text:
            confidences = self._finalized_confidences
            mean_conf = sum(confidences) / len(confidences) if confidences else 0.0
            frame = {"type": "final", "text": text, "confidence": round(mean_conf, 4)}
        self.reset()
        return frame

    def reset(self) -> None:
        self._finalized_transcripts = []
        self._finalized_confidences = []
        self._last_partial_text = None


def _truncate_error(exc: BaseException) -> str:
    """Build a short, key-free description of ``exc`` for logging/last_error."""
    text = f"{type(exc).__name__}: {exc}"
    if len(text) > MAX_ERROR_CHARS:
        text = text[:MAX_ERROR_CHARS]
    return text


# ---------------------------------------------------------------------------
# I/O layer — owns the actual Deepgram WebSocket connection.
# ---------------------------------------------------------------------------


class DeepgramSttSession:
    """One Deepgram ``/v1/listen`` streaming session for a single mic turn.

    Mirrors ``STTManager.ensure_ready``'s state/error style (module docstring
    above): ``connect()`` never raises — a failure is recorded on
    ``last_error`` and logged exactly once, and the caller falls back to the
    existing ``AudioBuffer``/``run_vad_and_transcribe`` path unchanged
    (Threat T-13.2-06 / D-02).
    """

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        sample_rate: int = SAMPLE_RATE,
        connect_timeout_s: float = DEFAULT_CONNECT_TIMEOUT_S,
        finalize_timeout_s: float = DEFAULT_FINALIZE_TIMEOUT_S,
    ) -> None:
        # Stored privately; read only inside connect()'s header construction.
        self._api_key = api_key
        self._model = model
        self._sample_rate = sample_rate
        self._connect_timeout_s = connect_timeout_s
        self._finalize_timeout_s = finalize_timeout_s

        self._ws: Any = None
        self._receive_task: Optional["asyncio.Task[None]"] = None
        self._alive: bool = False
        self._last_error: Optional[str] = None

        self._accumulator = SegmentAccumulator()
        self._partial_queue: "asyncio.Queue[dict]" = asyncio.Queue()
        self._finalize_event = asyncio.Event()

    @property
    def alive(self) -> bool:
        return self._alive

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    async def connect(self) -> bool:
        """Open the Deepgram WebSocket and start the receive loop.

        Returns ``True`` on success, ``False`` on ANY failure (missing/bad
        key, 401, DNS/TLS failure, timeout, ...). Never raises to the
        caller.
        """
        try:
            from websockets.asyncio.client import connect as ws_connect

            url = build_listen_url(model=self._model, sample_rate=self._sample_rate)
            # Header-only auth, literal "Token" scheme (Deepgram-specific —
            # deliberately NOT the other common HTTP auth scheme name).
            # Built via concatenation (not an f-string) so the key is
            # interpolated in exactly one place and never appears anywhere
            # near a log/print call.
            auth_header = "Token " + self._api_key
            self._ws = await ws_connect(
                url,
                additional_headers={"Authorization": auth_header},
                open_timeout=self._connect_timeout_s,
            )
            self._alive = True
            self._last_error = None
            self._receive_task = asyncio.create_task(self._receive_loop())
            return True
        except Exception as exc:  # noqa: BLE001 — any failure must degrade, never raise
            self._alive = False
            self._last_error = _truncate_error(exc)
            log.warning(
                "Deepgram STT unavailable (falling back to faster-whisper): %s",
                self._last_error,
            )
            return False

    async def _receive_loop(self) -> None:
        """Consume Deepgram messages until the socket closes or errors.

        Never raises into the event loop — a connection drop just marks the
        session dead and records ``last_error``.
        """
        try:
            async for message in self._ws:
                if isinstance(message, (bytes, bytearray)):
                    continue  # binary frames are not sent by /v1/listen
                try:
                    payload = json.loads(message)
                except (TypeError, ValueError):
                    log.debug("Deepgram STT: malformed JSON message, skipping")
                    continue

                result = parse_results(payload)
                if result is None:
                    continue

                partial = self._accumulator.feed(result)
                if partial is not None:
                    self._partial_queue.put_nowait(partial)

                if result.from_finalize or result.speech_final:
                    self._finalize_event.set()
        except Exception as exc:  # noqa: BLE001 — connection drop must not raise
            self._last_error = _truncate_error(exc)
            log.debug("Deepgram STT receive loop ended: %s", self._last_error)
        finally:
            self._alive = False

    async def send_audio(self, pcm: bytes) -> bool:
        """Send raw PCM bytes. Returns ``False`` (never raises) on failure."""
        if not self._alive or self._ws is None:
            return False
        try:
            await self._ws.send(pcm)
            return True
        except Exception as exc:  # noqa: BLE001
            self._alive = False
            self._last_error = _truncate_error(exc)
            return False

    def drain_partials(self) -> List[dict]:
        """Non-blocking drain of all currently queued partial frames."""
        drained: List[dict] = []
        while True:
            try:
                drained.append(self._partial_queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return drained

    async def finalize_segment(self) -> Optional[dict]:
        """Force-flush the current segment and return the ``final`` frame.

        Sends the documented ``{"type": "Finalize"}`` control message, waits
        up to ``finalize_timeout_s`` for Deepgram's flush acknowledgement,
        then returns ``accumulator.take_final()`` regardless of whether the
        wait timed out — a timeout means "use whatever was already
        finalized", not "lose the turn". Never raises.
        """
        if not self._alive or self._ws is None:
            return self._accumulator.take_final()

        self._finalize_event.clear()
        started = time.monotonic()
        flushed = False
        try:
            await self._ws.send(json.dumps({"type": "Finalize"}))
            try:
                await asyncio.wait_for(self._finalize_event.wait(), timeout=self._finalize_timeout_s)
                flushed = True
            except asyncio.TimeoutError:
                flushed = False
        except Exception as exc:  # noqa: BLE001 — send failure: use whatever is banked
            self._alive = False
            self._last_error = _truncate_error(exc)

        elapsed_ms = int((time.monotonic() - started) * 1000)
        log.debug("Deepgram STT finalize: flushed=%s elapsed_ms=%d", flushed, elapsed_ms)
        return self._accumulator.take_final()

    async def close(self) -> None:
        """Best-effort close: CloseStream control message, socket close, task cancel."""
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:  # noqa: BLE001
                pass
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
        if self._receive_task is not None:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._alive = False
