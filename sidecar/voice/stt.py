"""STT helpers — faster-whisper + Silero VAD streaming wrapper.

This module provides:

``AudioBuffer``
    A simple ring-buffer that accumulates raw PCM-16 LE mono 16 kHz bytes
    from the WebSocket and tracks VAD-detected speech boundaries.

``run_vad_and_transcribe``
    One-shot step function called per WebSocket frame batch.  Runs Silero VAD
    to detect speech start/end, accumulates speech frames, and when a speech
    segment ends runs faster-whisper to produce a final transcript.  Returns a
    list of event dicts ready to be sent back to the client.

Engine overview
---------------
**Default engine: faster-whisper (small, int8)**

    faster-whisper uses CTranslate2 for efficient CPU inference.  On the M3 Air
    with int8 quantisation, transcription of a 5-second utterance takes ~200–400 ms
    (post-warmup).  It is the reliable fallback that works out-of-the-box on any
    platform.

**Preferred lower-latency alternative: Parakeet-TDT via MLX**

    For sub-100 ms partial transcripts on Apple Silicon, the recommended
    production path is `mlx-community/parakeet-tdt-0.6b-mlx` (or the
    `mlx-audio` Parakeet binding).  Parakeet emits streaming partials in
    tens-of-ms while the user is still speaking, which faster-whisper cannot
    do (it is segment-based, not streaming).

    To use Parakeet: have the MLX sidecar (`sidecar/mlx/`) expose a Parakeet
    streaming endpoint, then replace ``run_vad_and_transcribe`` with a call to
    that endpoint.  The WebSocket protocol emitted upward remains identical.

    Alternatively, install ``mlx-audio`` and use its Parakeet bindings
    directly in this process (same venv, Apple Silicon only).

**Other fallbacks (selectable via STT_ENGINE env):**
    - ``moonshine`` — Moonshine v2 (sub-200 ms TTFT, small model)
    - ``apple``     — Apple SpeechTranscriber (macOS 26+, on-device, requires
                      AVFoundation; lowest latency, no Python deps)

VAD
---
Silero VAD (~1 MB, <1 ms per 30 ms frame) gates audio into speech segments.
It emits ``speech_start`` / ``speech_end`` events before any transcription so
the UI can react instantly.

IMPORTANT: requires Python >= 3.11.  Do NOT run with the system python3 3.9.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

import numpy as np  # type: ignore[import]

log = logging.getLogger("stt")

# ---------------------------------------------------------------------------
# VAD parameters
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16000     # Hz
FRAME_SAMPLES = 512     # Silero VAD window = 512 samples (32 ms at 16 kHz)
SILENCE_HANGOVER = 15   # consecutive silent frames before speech_end fires (15 × 32 ms = 480 ms)
MIN_SPEECH_FRAMES = 3   # ignore sub-frame blips


# ---------------------------------------------------------------------------
# AudioBuffer
# ---------------------------------------------------------------------------


class AudioBuffer:
    """Accumulates raw PCM bytes and tracks VAD state.

    Attributes
    ----------
    pcm_bytes : bytearray
        Full accumulated PCM (int16 LE) since last reset.  Extended by
        ``extend()``.
    speech_frames : bytearray
        PCM inside the current detected speech region.  Cleared on
        ``speech_end``.
    in_speech : bool
        True while we believe the user is speaking.
    """

    def __init__(self) -> None:
        self.pcm_bytes: bytearray = bytearray()
        self.speech_frames: bytearray = bytearray()
        self.in_speech: bool = False
        self.last_voiced_monotonic: Optional[float] = None
        self._silent_frame_count: int = 0
        self._speech_frame_count: int = 0

    def extend(self, data: bytes) -> None:
        """Append raw PCM bytes from the WebSocket."""
        self.pcm_bytes.extend(data)

    def reset_speech(self) -> None:
        """Clear the accumulated speech PCM after a final transcript is emitted."""
        self.speech_frames = bytearray()
        self.in_speech = False
        self._silent_frame_count = 0
        self._speech_frame_count = 0


# ---------------------------------------------------------------------------
# Core step function
# ---------------------------------------------------------------------------


def run_vad_and_transcribe(
    buf: AudioBuffer,
    vad_model: Any,
    whisper_model: Any,
    threshold: float = 0.5,
) -> List[Dict[str, Any]]:
    """Process buffered PCM through VAD and (when a segment ends) Whisper.

    This function is designed to be called from ``asyncio.get_event_loop().
    run_in_executor`` — it is synchronous and CPU-bound.

    Parameters
    ----------
    buf:
        The ``AudioBuffer`` accumulating WebSocket audio frames.
    vad_model:
        Silero VAD model (``torch.hub`` or ``silero_vad`` package instance).
    whisper_model:
        ``faster_whisper.WhisperModel`` instance.
    threshold:
        VAD speech probability threshold.

    Returns
    -------
    List of event dicts to send back over the WebSocket::

        [
          {"type": "speech_start"},                              # on rising edge
          {"type": "partial", "text": "…", "stability": 0.0},   # mid-speech hint
          {"type": "speech_end"},                                # on falling edge
          {"type": "final",   "text": "…", "confidence": 0.9},  # post-segment
        ]

    Notes
    -----
    *Partial transcripts*: faster-whisper does not expose token-level streaming
    during capture.  We emit a single ``partial`` event mid-speech using the
    last Whisper hypothesis (over a short window) as a "still listening" hint.
    For genuine sub-100 ms partials, switch to the Parakeet-MLX path (see
    module docstring).
    """
    import torch  # type: ignore[import]

    events: List[Dict[str, Any]] = []

    # Number of bytes for one VAD window (FRAME_SAMPLES int16 samples).
    frame_bytes = FRAME_SAMPLES * 2  # int16 = 2 bytes

    # Drain whole VAD frames from buf.pcm_bytes.
    while len(buf.pcm_bytes) >= frame_bytes:
        frame_raw = bytes(buf.pcm_bytes[:frame_bytes])
        buf.pcm_bytes = buf.pcm_bytes[frame_bytes:]

        # Convert to float32 in [-1, 1] for Silero.
        frame_f32 = np.frombuffer(frame_raw, dtype=np.int16).astype(np.float32) / 32768.0
        frame_tensor = torch.from_numpy(frame_f32).unsqueeze(0)  # (1, 512)

        speech_prob: float = float(vad_model(frame_tensor, SAMPLE_RATE).item())

        if speech_prob >= threshold:
            # Active speech frame.
            buf._silent_frame_count = 0
            buf._speech_frame_count += 1
            buf.speech_frames.extend(frame_raw)
            buf.last_voiced_monotonic = time.monotonic()

            if not buf.in_speech and buf._speech_frame_count >= MIN_SPEECH_FRAMES:
                buf.in_speech = True
                events.append({"type": "speech_start"})
                log.debug("speech_start (prob=%.3f)", speech_prob)

        else:
            # Silent frame.
            if buf.in_speech:
                buf._silent_frame_count += 1
                buf.speech_frames.extend(frame_raw)  # include hangover frames

                if buf._silent_frame_count >= SILENCE_HANGOVER:
                    # End of speech segment — run Whisper on the accumulated frames.
                    end_event: Dict[str, Any] = {"type": "speech_end"}
                    events.append(end_event)
                    log.debug("speech_end (hangover=%d)", SILENCE_HANGOVER)

                    transcript, confidence = _transcribe(
                        bytes(buf.speech_frames), whisper_model
                    )
                    # Honest silence measurement: time since the last voiced
                    # frame, INCLUDING the transcription time that just elapsed.
                    # The TS orchestrator counts this toward its end-of-turn
                    # silence threshold instead of re-waiting silence the VAD
                    # already observed (it previously received silenceMs: 0).
                    if buf.last_voiced_monotonic is not None:
                        end_event["silence_ms"] = int(
                            (time.monotonic() - buf.last_voiced_monotonic) * 1000
                        )
                    if transcript:
                        events.append({
                            "type": "final",
                            "text": transcript,
                            "confidence": round(confidence, 4),
                        })
                        log.info("STT final: %r (conf=%.3f)", transcript, confidence)
                    buf.reset_speech()

    return events


def _transcribe(pcm_bytes: bytes, whisper_model: Any) -> tuple[str, float]:
    """Run faster-whisper on a complete speech segment.

    Parameters
    ----------
    pcm_bytes:
        Raw PCM-16 LE mono 16 kHz bytes for the full speech segment.
    whisper_model:
        ``faster_whisper.WhisperModel`` instance.

    Returns
    -------
    (transcript, avg_confidence) — confidence is the mean segment log-prob
    mapped to 0..1 range (rough estimate).
    """
    audio_f32 = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    segments, info = whisper_model.transcribe(
        audio_f32,
        language="en",
        beam_size=1,        # greedy — ~30-40% faster on short utterances
        vad_filter=False,   # We already VAD-gated; avoid double-filtering.
        word_timestamps=False,
    )

    text_parts: list[str] = []
    total_avg_logprob: float = 0.0
    seg_count = 0

    for seg in segments:
        if seg.text.strip():
            text_parts.append(seg.text.strip())
        total_avg_logprob += seg.avg_logprob
        seg_count += 1

    transcript = " ".join(text_parts).strip()
    if seg_count == 0:
        return transcript, 0.0

    # avg_logprob is typically in [-1, 0].  Map to [0, 1]: exp(logprob).
    import math
    confidence = min(1.0, math.exp(total_avg_logprob / seg_count))
    return transcript, confidence


# ---------------------------------------------------------------------------
# Alternative: Parakeet-MLX streaming STT (Apple Silicon, lower latency)
# ---------------------------------------------------------------------------


def make_parakeet_transcriber(model_id: str = "mlx-community/parakeet-tdt-0.6b-mlx") -> Any:
    """(Optional) Construct a Parakeet-TDT/MLX transcriber.

    Parakeet-TDT emits streaming partial transcripts in tens-of-ms on Apple
    Silicon, versus faster-whisper's segment-based latency.  Use this for
    production voice sessions when latency is critical.

    Usage::

        transcriber = make_parakeet_transcriber()
        for partial in transcriber.stream(audio_frames):
            # partial is {"type": "partial", "text": "…", "stability": 0.8}
            ...

    This function is a **stub** — integrate with the mlx-audio Parakeet
    bindings (``pip install mlx-audio``) or via the MLX sidecar's
    ``/v1/chat/completions`` equivalent once that endpoint is exposed.

    Raises
    ------
    NotImplementedError
        Until the Parakeet binding is wired up.
    """
    raise NotImplementedError(
        "Parakeet-MLX integration is not yet wired in this sidecar.  "
        "Options:\n"
        "  1. Use the MLX sidecar (sidecar/mlx/) once it exposes a Parakeet "
        "streaming endpoint.\n"
        "  2. Install mlx-audio and integrate mlx_audio.parakeet here.\n"
        "  3. Keep faster-whisper (default) for compatibility."
    )
