"""Deepgram Aura-2 TTS client — streaming WS synthesis, Kokoro-compatible.

Overview
--------
This module wraps Deepgram's Aura-2 streaming text-to-speech WebSocket API
(``wss://api.deepgram.com/v1/speak``) to produce the exact same output shape
``tts.synthesize_streaming`` (Kokoro) already produces, so ``voice_server.py``
can swap between the two engines by changing which generator it calls — no
change to the ``/tts`` response headers or the TS ``SidecarTtsEngine``/ffplay
playback pipeline is required.

Output format
-------------
Aura-2's default ``encoding=linear16`` at ``sample_rate=24000`` is **raw
PCM-16 LE mono 24 kHz** — byte-identical to Kokoro's ``KOKORO_SAMPLE_RATE``
(see ``tts.py``). ``synthesize_streaming_aura`` yields ``bytes`` of that exact
shape, no WAV header, no resampling.

Cancellation
------------
``synthesize_streaming_aura`` accepts a ``cancel_event: asyncio.Event``,
mirroring Kokoro's ``synthesize_streaming`` contract. When the event is set
(barge-in), the generator sends a best-effort ``{"type": "Clear"}`` message,
closes the WebSocket, and returns — so barge-in behaves identically whichever
engine is active.

Unlike the Kokoro path, there is no thread executor or queue here: Kokoro
needed one because ``KPipeline.__call__`` is a *synchronous* generator run on
the executor thread. Deepgram's client is natively async via ``websockets``,
so this module talks to the socket directly on the running event loop.

Failure handling
----------------
A connect/protocol failure (bad key, network unreachable, non-2xx upgrade,
malformed event) is caught broadly, logged as a single line of the form
``"Aura TTS unavailable (falling back to Kokoro): <reason>"`` (reason
truncated to ``MAX_ERROR_CHARS``, never including the API key or the full
Authorization header), and the generator ends without yielding anything.
Raising here would 500 a ``/tts`` request; plan 13.2-04's caller relies on
this generator simply producing zero bytes so it can fall through to Kokoro.

IMPORTANT: requires Python >= 3.11. Do NOT run with the system python3 3.9.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional
from urllib.parse import urlencode

log = logging.getLogger("deepgram_tts")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEEPGRAM_SPEAK_URL = "wss://api.deepgram.com/v1/speak"

# Aura-2's linear16 @ 24 kHz output is byte-identical to tts.KOKORO_SAMPLE_RATE
# (see tts.py) — no resampling is needed on either side of the engine swap.
AURA_SAMPLE_RATE = 24000

DEFAULT_AURA_VOICE = "aura-2-draco-en"
AURA_BRITISH_VOICES = ("aura-2-draco-en", "aura-2-pandora-en")

# Truncate any logged error text to this many characters — never log the key.
MAX_ERROR_CHARS = 200

# Short connect timeout: a per-turn TTS session is seconds long, no reconnect
# loop / exponential backoff is appropriate here (mirrors wakeword.py's
# fail-fast-then-fallback outbound-call shape).
CONNECT_TIMEOUT_S = 3.0


# ---------------------------------------------------------------------------
# URL construction (pure, no credential)
# ---------------------------------------------------------------------------


def build_speak_url(voice: str = DEFAULT_AURA_VOICE, sample_rate: int = AURA_SAMPLE_RATE) -> str:
    """Build the Aura-2 ``/v1/speak`` WS URL for ``voice``/``sample_rate``.

    Deliberately takes no credential and no ``speed`` parameter — Aura speed
    is unverified for this endpoint (see module docstring), so this plan runs
    Aura at its natural rate. Always ``wss://`` (never ``ws://``).
    """
    query = urlencode({"model": voice, "encoding": "linear16", "sample_rate": sample_rate})
    return f"{DEEPGRAM_SPEAK_URL}?{query}"


# ---------------------------------------------------------------------------
# Streaming synthesis
# ---------------------------------------------------------------------------


async def synthesize_streaming_aura(
    text: str,
    api_key: str,
    voice: str = DEFAULT_AURA_VOICE,
    sample_rate: int = AURA_SAMPLE_RATE,
    cancel_event: Optional[asyncio.Event] = None,
) -> AsyncGenerator[bytes, None]:
    """Yield PCM-16 LE mono 24 kHz chunks for ``text`` using Deepgram Aura-2.

    Parameters
    ----------
    text:
        The text to synthesize.
    api_key:
        Deepgram API key. Used only inside the ``Authorization: Token <key>``
        header — never placed in the URL, never logged.
    voice:
        An Aura-2 voice model id, e.g. ``"aura-2-draco-en"``.
    sample_rate:
        Output sample rate; defaults to 24000 to match Kokoro.
    cancel_event:
        Set this ``asyncio.Event`` to abort synthesis (barge-in). Checked
        before each yield; when set, a best-effort ``Clear`` message is sent,
        the socket is closed, and the generator returns.

    Yields
    ------
    bytes
        Raw PCM-16 LE mono audio, chunked exactly as Deepgram delivers binary
        WS frames (no re-chunking, no resampling, no WAV header).

    Notes
    -----
    Never raises: connect/protocol failures are logged and the generator ends
    having yielded nothing, so the caller (``voice_server.py``, plan 13.2-04)
    can fall through to Kokoro instead of 500-ing the ``/tts`` request.
    """
    try:
        from websockets.asyncio.client import connect  # type: ignore[import]
    except Exception as exc:  # noqa: BLE001 — missing/broken websockets install
        log.warning("Aura TTS unavailable (falling back to Kokoro): %s", _truncate(str(exc)))
        return

    url = build_speak_url(voice=voice, sample_rate=sample_rate)

    try:
        async with connect(
            url,
            additional_headers={"Authorization": f"Token {api_key}"},
            open_timeout=CONNECT_TIMEOUT_S,
        ) as ws:
            await ws.send(json.dumps({"type": "Speak", "text": text}))
            await ws.send(json.dumps({"type": "Flush"}))

            async for message in ws:
                if cancel_event is not None and cancel_event.is_set():
                    await _best_effort_clear(ws)
                    log.info("Aura TTS synthesis cancelled mid-stream (cancel_event set).")
                    return

                if isinstance(message, (bytes, bytearray)):
                    yield bytes(message)
                    continue

                # Text frame: a JSON event. Decode defensively — an
                # unparseable event must not crash the generator.
                try:
                    evt = json.loads(message)
                except (TypeError, ValueError) as exc:
                    log.warning(
                        "Aura TTS unavailable (falling back to Kokoro): "
                        "unparseable event: %s",
                        _truncate(str(exc)),
                    )
                    return

                evt_type = evt.get("type") if isinstance(evt, dict) else None
                if evt_type == "Flushed":
                    return
                if evt_type in ("Warning", "Error"):
                    log.warning(
                        "Aura TTS unavailable (falling back to Kokoro): %s event: %s",
                        evt_type,
                        _truncate(json.dumps(evt)),
                    )
                    return
                # Unknown event type — ignore and keep streaming.
    except Exception as exc:  # noqa: BLE001 — connect/protocol failure, never raise
        log.warning("Aura TTS unavailable (falling back to Kokoro): %s", _truncate(str(exc)))
        return


async def _best_effort_clear(ws: object) -> None:
    """Send a Clear message and let the caller's `async with` close the socket.

    Best-effort: any failure here is swallowed — cancellation must never raise.
    """
    try:
        await ws.send(json.dumps({"type": "Clear"}))  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


def _truncate(text: str, limit: int = MAX_ERROR_CHARS) -> str:
    """Truncate ``text`` to ``limit`` characters for safe, bounded logging."""
    return text if len(text) <= limit else text[:limit] + "…"
