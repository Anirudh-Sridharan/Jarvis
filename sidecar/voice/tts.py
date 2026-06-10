"""TTS helpers — Kokoro streaming synthesis wrapper.

This module wraps Kokoro's ``KPipeline`` to produce a streaming async
generator of raw PCM-16 LE mono 24 kHz audio chunks that the FastAPI
``/tts`` endpoint can stream directly to the TS orchestrator.

Kokoro overview
---------------
Kokoro (https://github.com/hexgrad/kokoro) is a lightweight, high-quality
TTS model with:
  * Native 24 kHz mono float32 PCM output.
  * Multiple voices (``af_heart``, ``af_sky``, ``am_adam``, …).
  * Sub-300 ms time-to-first-audio per sentence chunk on Apple Silicon.
  * An MLX variant (``mlx-audio`` / ``kokoro-mlx``) for even lower latency
    on M-series; see ``MLX variant`` note below.

Output format
-------------
``synthesize_streaming`` yields ``bytes`` of **PCM-16 LE mono 24 kHz** audio.
The TS orchestrator decodes these raw bytes via its CoreAudio output transport.

MLX variant (recommended for production on Apple Silicon)
---------------------------------------------------------
Instead of the ``kokoro`` (torch) package, use the ``mlx-audio`` package:

    pip install mlx-audio

Then replace the ``KPipeline`` call with the mlx-audio Kokoro pipeline::

    from mlx_audio.tts.models.kokoro import KokoroPipeline  # mlx-audio
    pipeline = KokoroPipeline(lang_code="en-us")
    # usage is identical to the torch KPipeline

This shaves ~50–100 ms off first-audio latency on M1/M2/M3 devices because
weights stay in Apple's unified memory and inference uses Metal via MLX.

Barge-in / cancellation
-----------------------
``synthesize_streaming`` accepts a ``cancel_event: asyncio.Event``.  When the
event is set (by ``POST /tts/cancel`` or HTTP disconnect), the generator stops
after the current Kokoro chunk completes.  This is the hook the TS orchestrator
uses to implement barge-in: it fires the cancel event the instant Silero VAD
detects the user speaking during TTS playback.

IMPORTANT: requires Python >= 3.11.
Do NOT run with the system python3 3.9.6.  Use run.sh.
"""

from __future__ import annotations

import asyncio
import logging
import struct
from typing import Any, AsyncGenerator, Optional

import numpy as np  # type: ignore[import]

log = logging.getLogger("tts")

KOKORO_SAMPLE_RATE = 24000   # Hz — Kokoro's native output rate
OUTPUT_DTYPE = np.float32    # Kokoro emits float32; we convert to int16


# ---------------------------------------------------------------------------
# Streaming synthesis
# ---------------------------------------------------------------------------


async def synthesize_streaming(
    text: str,
    pipeline: Any,
    voice: str,
    speed: float = 1.0,
    cancel_event: Optional[asyncio.Event] = None,
    loop: Optional[asyncio.AbstractEventLoop] = None,
) -> AsyncGenerator[bytes, None]:
    """Yield PCM-16 LE mono 24 kHz chunks for ``text`` using Kokoro.

    Parameters
    ----------
    text:
        The text to synthesize.  Can be a full sentence or a sentence chunk
        (the sentence chunker in the Pipecat pipeline calls this per chunk).
    pipeline:
        A loaded ``kokoro.KPipeline`` instance.
    voice:
        Kokoro voice ID string (e.g. ``"af_heart"``).
    speed:
        Playback speed multiplier (0.5–2.0).
    cancel_event:
        Set this ``asyncio.Event`` to abort synthesis after the current chunk.
        Used for barge-in: the TS orchestrator sets it when Silero VAD fires
        speech_start during TTS playback.
    loop:
        The running event loop (used for ``run_in_executor``).  Defaults to
        ``asyncio.get_event_loop()``.

    Yields
    ------
    bytes
        Raw PCM-16 LE mono 24 kHz audio.  Each yield corresponds to one Kokoro
        generation chunk (typically 0.5–2 seconds of audio).

    Notes
    -----
    * Kokoro's ``KPipeline.__call__`` is a *synchronous* generator that yields
      ``(graphemes, phonemes, audio_float32_array)`` tuples.  We run it on the
      thread executor so it does not block the asyncio event loop.
    * We convert float32 → int16 (PCM-16) before yielding so the TS side does
      not need to handle float audio.
    """
    if loop is None:
        loop = asyncio.get_event_loop()

    queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue()

    def _produce() -> None:
        """Run Kokoro on the executor thread and enqueue PCM chunks."""
        try:
            for _graphemes, _phonemes, audio in pipeline(text, voice=voice, speed=speed):
                if cancel_event is not None and cancel_event.is_set():
                    log.debug("TTS synthesis cancelled mid-chunk.")
                    break
                if audio is None or len(audio) == 0:
                    continue
                pcm_bytes = _float32_to_pcm16(audio)
                loop.call_soon_threadsafe(queue.put_nowait, pcm_bytes)
        except Exception as exc:  # noqa: BLE001
            log.exception("Kokoro synthesis error: %s", exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

    producer_future = loop.run_in_executor(None, _produce)

    try:
        while True:
            chunk = await queue.get()
            if chunk is None:
                break  # synthesis complete (or cancelled by producer)
            if cancel_event is not None and cancel_event.is_set():
                log.info("TTS streaming aborted (cancel_event set).")
                break
            yield chunk
            log.debug("TTS chunk yielded: %d bytes (%.1f ms)", len(chunk), _bytes_to_ms(len(chunk)))
    finally:
        # Drain the queue and wait for the producer to finish.
        await producer_future
        while not queue.empty():
            queue.get_nowait()


# ---------------------------------------------------------------------------
# PCM helpers
# ---------------------------------------------------------------------------


def _float32_to_pcm16(audio: Any) -> bytes:
    """Convert a float32 numpy array (or torch Tensor) in [-1, 1] to PCM-16 LE bytes.

    Kokoro ``KPipeline`` yields ``torch.Tensor`` objects.  We handle both
    numpy arrays and torch tensors for compatibility.
    """
    # Accept torch.Tensor or numpy ndarray.
    try:
        arr = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
    except Exception:  # noqa: BLE001
        arr = np.asarray(audio)

    arr = arr.flatten().astype(np.float32)
    # Clip to [-1, 1] to avoid clipping artefacts.
    arr = np.clip(arr, -1.0, 1.0)
    # Scale to int16 range.
    pcm16 = (arr * 32767).astype(np.int16)
    return pcm16.tobytes()


def _bytes_to_ms(n_bytes: int, sample_rate: int = KOKORO_SAMPLE_RATE) -> float:
    """Convert a PCM-16 mono byte count to milliseconds."""
    samples = n_bytes // 2  # 2 bytes per int16 sample
    return samples / sample_rate * 1000.0


# ---------------------------------------------------------------------------
# Utility: build a WAV header for clients that need it
# ---------------------------------------------------------------------------


def pcm_to_wav_header(n_bytes: int, sample_rate: int = KOKORO_SAMPLE_RATE) -> bytes:
    """Return a 44-byte WAV header for ``n_bytes`` of PCM-16 LE mono audio.

    The ``/tts`` endpoint streams raw PCM (no header) for lowest latency, but
    if a client requests a single-shot WAV (e.g. for debugging), prepend this
    header to the concatenated PCM bytes.
    """
    channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_chunk_size = n_bytes
    riff_chunk_size = 36 + data_chunk_size

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_chunk_size,
        b"WAVE",
        b"fmt ",
        16,               # PCM sub-chunk size
        1,                # AudioFormat = PCM
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_chunk_size,
    )
    return header
