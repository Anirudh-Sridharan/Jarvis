"""Wake word listener — openWakeWord "Hey Jarvis".

Runs a continuous mic-capture loop, passes 16 kHz mono PCM frames through the
openWakeWord model, and POSTs a ``WakeEvent`` JSON payload to the TypeScript
voice orchestrator whenever a confirmed detection occurs.

Usage (the FastAPI app drives this via ``WakeWordListener.run()``):

    from wakeword import WakeWordListener
    listener = WakeWordListener(
        model_name="hey_jarvis",
        orchestrator_url="http://127.0.0.1:8080/voice/wake",
        threshold=0.35,
    )
    await listener.run()   # runs until cancelled

You can also run this standalone for debugging::

    python wakeword.py

IMPORTANT: requires Python >= 3.11.
The system python3 on the target MacBook Air M3 is 3.9.6 — use run.sh.

Model download
--------------
openWakeWord downloads pre-trained models on first use via its own download
helper (``openwakeword.utils.download_models``).  The "hey_jarvis" model is
provided by the openWakeWord project.  Alternatively, download manually and
set ``WAKE_WORD_MODEL`` to the file path.  See README.md → "Model downloads".

WakeEvent schema (POSTed to orchestrator, mirrors TS WakeEvent interface)
--------------------------------------------------------------------------
{
  "event": "wake",
  "id": "<uuid>",
  "source": "wakeword",
  "phrase": "Hey Jarvis",
  "confidence": 0.87,
  "ts": 1718000000123,
  "device_id": "<pyaudio device index or name>"
}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional

log = logging.getLogger("wakeword")

# ---------------------------------------------------------------------------
# Constants / env
# ---------------------------------------------------------------------------

# How many seconds to ignore new triggers after a confirmed detection.
DEBOUNCE_SECONDS = float(os.environ.get("WAKE_DEBOUNCE_SECS", "1.5"))

# Mic capture chunk size in frames (16 kHz → 1280 frames = 80 ms)
CHUNK_FRAMES = int(os.environ.get("WAKE_CHUNK_FRAMES", "1280"))

SAMPLE_RATE = 16000      # openWakeWord expects 16 kHz
CHANNELS = 1             # mono
SAMPLE_WIDTH = 2         # int16 PCM


# ---------------------------------------------------------------------------
# WakeWordListener
# ---------------------------------------------------------------------------


class WakeWordListener:
    """Continuous openWakeWord listener that fires a callback on detection.

    Parameters
    ----------
    model_name:
        openWakeWord model identifier (e.g. ``"hey_jarvis"``) *or* a path to
        a local ``.tflite`` / ``.onnx`` model file.
    orchestrator_url:
        HTTP URL to POST ``WakeEvent`` JSON to.  Set via ``VOICE_ORCHESTRATOR_URL``
        env or passed explicitly.
    threshold:
        Detection confidence threshold (0..1).  Lower = more sensitive but
        more false accepts.  Default 0.35 (0.5 missed too many real wakes
        in practice on the built-in MacBook mic).
    """

    def __init__(
        self,
        model_name: str,
        orchestrator_url: str,
        threshold: float = 0.35,
    ) -> None:
        self.model_name = model_name
        self.orchestrator_url = orchestrator_url
        self.threshold = threshold
        self._last_fire: float = 0.0
        self._enabled: bool = True

    async def run(self) -> None:
        """Main listener loop.  Runs until the asyncio Task is cancelled."""
        import openwakeword  # type: ignore[import]
        from openwakeword.model import Model as OWWModel  # type: ignore[import]
        import pyaudio  # type: ignore[import]
        import numpy as np  # type: ignore[import]

        log.info("Initialising openWakeWord model: %s", self.model_name)
        # Download pre-trained models if not already cached.
        openwakeword.utils.download_models()

        # Build the model.  If model_name is a file path, pass it directly;
        # otherwise let openWakeWord resolve it from its registry.
        if os.path.isfile(self.model_name):
            oww = OWWModel(wakeword_models=[self.model_name])
        else:
            oww = OWWModel(wakeword_models=[self.model_name])

        pa = pyaudio.PyAudio()
        device_index = self._default_input_device(pa)
        stream = pa.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_FRAMES,
            input_device_index=device_index,
        )

        log.info(
            "Wake word listener active (model=%s, threshold=%.2f, device=%s).",
            self.model_name,
            self.threshold,
            device_index,
        )

        loop = asyncio.get_running_loop()

        try:
            while self._enabled:
                # Read from mic in the executor so we don't block the event loop.
                raw: bytes = await loop.run_in_executor(
                    None, stream.read, CHUNK_FRAMES
                )
                audio_data = np.frombuffer(raw, dtype=np.int16)

                # Run openWakeWord inference (synchronous, fast <5 ms).
                predictions = oww.predict(audio_data)

                # ``predictions`` is a dict: { model_name: confidence_float }
                for ww_name, confidence in predictions.items():
                    if confidence >= self.threshold:
                        now = time.monotonic()
                        if now - self._last_fire >= DEBOUNCE_SECONDS:
                            self._last_fire = now
                            await self._fire(confidence, device_index)

        except asyncio.CancelledError:
            log.info("Wake word listener cancelled.")
        finally:
            stream.stop_stream()
            stream.close()
            pa.terminate()
            log.info("Wake word audio stream closed.")

    async def _fire(self, confidence: float, device_index: Optional[int]) -> None:
        """POST a WakeEvent to the TS orchestrator (fire-and-forget)."""
        event = {
            "event": "wake",
            "id": str(uuid.uuid4()),
            "source": "wakeword",
            "phrase": "Hey Jarvis",
            "confidence": round(float(confidence), 4),
            "ts": int(time.time() * 1000),
            "device_id": str(device_index) if device_index is not None else "default",
        }
        log.info("Wake detected! confidence=%.3f → POST %s", confidence, self.orchestrator_url)
        await _post_event(self.orchestrator_url, event)

    @staticmethod
    def _default_input_device(pa: Any) -> Optional[int]:
        """Return PyAudio's default input device index, or None for system default."""
        try:
            info = pa.get_default_input_device_info()
            return int(info["index"])
        except Exception:  # noqa: BLE001
            return None


# ---------------------------------------------------------------------------
# HTTP helper (urllib only — no aiohttp / httpx dependency at wake stage)
# ---------------------------------------------------------------------------


async def _post_event(url: str, payload: dict) -> None:  # type: ignore[type-arg]
    """Fire-and-forget POST of ``payload`` as JSON.

    Uses ``asyncio`` + the standard library ``urllib`` (no extra deps) so wake
    remains lightweight.  Errors are logged but never raised — a failed POST
    must never crash the listener loop.
    """
    import urllib.request
    import urllib.error

    loop = asyncio.get_running_loop()
    body = json.dumps(payload).encode("utf-8")

    def _send() -> None:
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                log.debug("WakeEvent POST → %d", resp.status)
        except urllib.error.URLError as exc:
            log.warning("WakeEvent POST failed (orchestrator reachable?): %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.warning("WakeEvent POST unexpected error: %s", exc)

    await loop.run_in_executor(None, _send)


# ---------------------------------------------------------------------------
# Standalone debug entry point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import os

    logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
    model = os.environ.get("WAKE_WORD_MODEL", "hey_jarvis")
    url = os.environ.get("VOICE_ORCHESTRATOR_URL", "http://127.0.0.1:8080/voice/wake")
    threshold = float(os.environ.get("WAKE_THRESHOLD", "0.35"))

    listener = WakeWordListener(model_name=model, orchestrator_url=url, threshold=threshold)
    asyncio.run(listener.run())
