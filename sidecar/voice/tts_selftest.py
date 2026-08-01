"""Hermetic FastAPI TestClient selftest for `/tts`'s engine branch (plan 13.2-04).

No test framework is used (Python has none installed in this sidecar) — plain
asserts, following ``stt_stream_selftest.py``'s standalone-script precedent
(itself following ``selftest.py``'s). Run directly:

    ./.venv/bin/python tts_selftest.py

Zero network, zero real models, zero real Deepgram key: ``voice_server.tts_mgr``
is replaced with a stub exposing a sentinel pipeline, ``tts.synthesize_streaming``
(Kokoro) is replaced with an async-generator stub yielding known bytes, and
``deepgram_tts.synthesize_streaming_aura`` is replaced with a scriptable
async-generator stub that records the kwargs it received.

Nine cases are asserted:
    1. Default engine — Kokoro serves, Aura stub never called, headers pinned.
    2. Per-request Aura — ``engine: "aura"`` serves via Aura even with the env
       default at kokoro; default voice is DEEPGRAM_TTS_MODEL, an Aura-shaped
       request voice overrides it.
    3. Env-selected Aura — TTS_ENGINE="aura" + a key serves Aura with no
       ``engine`` field in the request body (the path a live conversation
       takes, since the TS client never sends ``engine``).
    4. Aura degraded, no key — TTS_ENGINE="aura" with no key still returns 200
       with Kokoro bytes; /health explains why.
    5. Aura fails mid-request — a zero-byte Aura stream still returns 200 with
       Kokoro bytes (same-request fallthrough); /health.tts_engine.active
       reports kokoro.
    6. Cancellation parity — /tts/cancel during an in-flight Aura stream sets
       the same cancel_event the Aura generator observes.
    7. Key hygiene — a sentinel key value appears in no response body and
       nowhere in the /health JSON.
    8. Engine-scoped voice (WR-03) — a Kokoro-shaped ``voice`` (id or blend
       spec, e.g. a set JARVIS_TTS_VOICE) on the Aura path is NOT forwarded
       to Deepgram (Aura serves with DEEPGRAM_TTS_MODEL, no Kokoro
       fallback); an ``aura-*`` voice IS forwarded; the same Kokoro-shaped
       voice still applies on the kokoro engine.
    9. Cancel-registry lifecycle (WR-06) — a response whose generator is
       never iterated registers nothing (no _tts_cancel leak; /tts/cancel
       for that id honestly reports false), while a consumed request
       registers on first iteration and pops on completion.

Prints ``TTS_SELFTEST_OK`` and exits 0 on success; prints a failure message to
stderr and exits non-zero otherwise.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi.testclient import TestClient

import deepgram_tts  # type: ignore[import]
import tts  # type: ignore[import]
import voice_server  # type: ignore[import]

# ---------------------------------------------------------------------------
# Fixed stub bytes + the pinned response contract.
# ---------------------------------------------------------------------------

KOKORO_BYTES = b"KOKORO-STUB-AUDIO-BYTES"
AURA_CHUNKS_DEFAULT = [b"AURA-CHUNK-1", b"AURA-CHUNK-2"]

EXPECTED_CONTENT_TYPE = "audio/pcm; rate=24000; channels=1; bits=16"

# A no-colon override for voice_server.TTS_VOICE so _voice_for()'s blend-parse
# branch (which needs a loaded torch + Kokoro pipeline) is never exercised —
# our stub pipeline is a bare sentinel object, not a real KPipeline.
TEST_KOKORO_VOICE_SPEC = "selftest-kokoro-voice"


# ---------------------------------------------------------------------------
# Stub TTSManager — no real Kokoro model, no lock.
# ---------------------------------------------------------------------------


class _StubTtsMgr:
    def __init__(self) -> None:
        self.state = "ready"

    async def ensure_ready(self) -> None:
        return None

    async def unload(self) -> None:
        return None

    def get_pipeline(self) -> Any:
        return object()  # sentinel; the Kokoro stub below never touches it


# ---------------------------------------------------------------------------
# Kokoro stub — imitates tts.synthesize_streaming's signature.
# ---------------------------------------------------------------------------


class _KokoroCalls:
    calls: List[Dict[str, Any]] = []
    chunks: List[bytes] = [KOKORO_BYTES]


async def _kokoro_stub(
    text: str,
    pipeline: Any,
    voice: Any,
    speed: float = 1.0,
    cancel_event: Optional[asyncio.Event] = None,
    loop: Any = None,
) -> AsyncGenerator[bytes, None]:
    _KokoroCalls.calls.append({"text": text, "voice": voice, "speed": speed})
    for chunk in _KokoroCalls.chunks:
        if cancel_event is not None and cancel_event.is_set():
            return
        yield chunk


# ---------------------------------------------------------------------------
# Aura stub — imitates deepgram_tts.synthesize_streaming_aura's signature,
# recording every kwarg it received and (for case 6) observing cancel_event.
# ---------------------------------------------------------------------------


class _AuraCalls:
    calls: List[Dict[str, Any]] = []
    chunks: List[bytes] = list(AURA_CHUNKS_DEFAULT)
    delay_s: float = 0.0
    observed_cancel_set: List[bool] = []


async def _aura_stub(
    text: str,
    api_key: str,
    voice: str = deepgram_tts.DEFAULT_AURA_VOICE,
    sample_rate: int = deepgram_tts.AURA_SAMPLE_RATE,
    cancel_event: Optional[asyncio.Event] = None,
) -> AsyncGenerator[bytes, None]:
    _AuraCalls.calls.append({"text": text, "api_key": api_key, "voice": voice})
    for chunk in _AuraCalls.chunks:
        if _AuraCalls.delay_s:
            await asyncio.sleep(_AuraCalls.delay_s)
        if cancel_event is not None and cancel_event.is_set():
            _AuraCalls.observed_cancel_set.append(True)
            return
        yield chunk


def _reset() -> None:
    _KokoroCalls.calls = []
    _KokoroCalls.chunks = [KOKORO_BYTES]
    _AuraCalls.calls = []
    _AuraCalls.chunks = list(AURA_CHUNKS_DEFAULT)
    _AuraCalls.delay_s = 0.0
    _AuraCalls.observed_cancel_set = []


tts.synthesize_streaming = _kokoro_stub  # type: ignore[assignment]
deepgram_tts.synthesize_streaming_aura = _aura_stub  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Case 1: Default engine — Kokoro serves, Aura stub never called.
# ---------------------------------------------------------------------------


def test_case1_default_engine(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "kokoro"
    voice_server.DEEPGRAM_API_KEY = None
    _reset()

    resp = client.post("/tts", json={"text": "hello", "request_id": "rid-1"})

    assert resp.status_code == 200, resp.status_code
    assert resp.content == KOKORO_BYTES, resp.content
    assert resp.headers["content-type"] == EXPECTED_CONTENT_TYPE, resp.headers
    assert resp.headers["x-tts-request-id"] == "rid-1", resp.headers
    assert not _AuraCalls.calls, "Aura stub must never be called on the default (kokoro) path"


# ---------------------------------------------------------------------------
# Case 2: Per-request Aura — engine="aura" overrides the env default.
# ---------------------------------------------------------------------------


def test_case2_per_request_aura(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "kokoro"  # env still says kokoro
    voice_server.DEEPGRAM_API_KEY = "case2-key-not-a-real-secret"
    _reset()

    # No voice supplied: Aura stub should receive DEEPGRAM_TTS_MODEL.
    resp = client.post("/tts", json={"text": "hello", "engine": "aura"})
    assert resp.status_code == 200, resp.status_code
    assert resp.content == b"".join(AURA_CHUNKS_DEFAULT), resp.content
    assert resp.headers["content-type"] == EXPECTED_CONTENT_TYPE, resp.headers
    assert not _KokoroCalls.calls, "Kokoro stub must never be called when Aura succeeds"
    assert _AuraCalls.calls[-1]["voice"] == voice_server.DEEPGRAM_TTS_MODEL, _AuraCalls.calls[-1]

    # Explicit voice: Aura stub should receive the request's voice instead.
    _reset()
    resp2 = client.post(
        "/tts", json={"text": "hello", "engine": "aura", "voice": "aura-2-pandora-en"}
    )
    assert resp2.status_code == 200, resp2.status_code
    assert resp2.headers["content-type"] == EXPECTED_CONTENT_TYPE, resp2.headers
    assert _AuraCalls.calls[-1]["voice"] == "aura-2-pandora-en", _AuraCalls.calls[-1]
    assert not _KokoroCalls.calls


# ---------------------------------------------------------------------------
# Case 3: Env-selected Aura — the TS client's engine-free body still reaches
# Aura when TTS_ENGINE says so. This is the live-conversation path.
# ---------------------------------------------------------------------------


def test_case3_env_selected_aura(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "aura"
    voice_server.DEEPGRAM_API_KEY = "case3-key-not-a-real-secret"
    _reset()

    resp = client.post("/tts", json={"text": "hello"})  # no "engine" field at all

    assert resp.status_code == 200, resp.status_code
    assert resp.content == b"".join(AURA_CHUNKS_DEFAULT), resp.content
    assert not _KokoroCalls.calls, "Kokoro stub must never be called when env selects aura"
    assert _AuraCalls.calls, "Aura stub must be called when TTS_ENGINE=aura and no engine field is sent"


# ---------------------------------------------------------------------------
# Case 4: Aura degraded, no key — a missing key must degrade, never 4xx/5xx.
# ---------------------------------------------------------------------------


def test_case4_aura_degraded_no_key(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "aura"
    voice_server.DEEPGRAM_API_KEY = None
    _reset()

    resp = client.post("/tts", json={"text": "hello"})

    assert resp.status_code == 200, resp.status_code
    assert resp.content == KOKORO_BYTES, resp.content
    assert not _AuraCalls.calls, "Aura stub must never be attempted with no key"

    health = client.get("/health").json()
    assert health["tts_engine"]["reason"] == "DEEPGRAM_API_KEY not set", health["tts_engine"]
    assert health["tts_engine"]["configured"] == "kokoro", health["tts_engine"]


# ---------------------------------------------------------------------------
# Case 5: Aura fails mid-request — zero bytes still yields Kokoro audio in
# the SAME response (same-request fallthrough), never silence.
# ---------------------------------------------------------------------------


def test_case5_aura_fails_mid_request(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "kokoro"
    voice_server.DEEPGRAM_API_KEY = "case5-key-not-a-real-secret"
    _reset()
    _AuraCalls.chunks = []  # Aura "succeeds" but yields nothing

    resp = client.post("/tts", json={"text": "hello", "engine": "aura"})

    assert resp.status_code == 200, resp.status_code
    assert resp.content == KOKORO_BYTES, resp.content
    assert _AuraCalls.calls, "Aura stub should have been attempted"
    assert _KokoroCalls.calls, "Kokoro fallback must have run in the same request"

    health = client.get("/health").json()
    assert health["tts_engine"]["active"] == "kokoro", health["tts_engine"]


# ---------------------------------------------------------------------------
# Case 6: Cancellation parity — /tts/cancel during an in-flight Aura stream
# sets the same cancel_event the Aura generator observes.
# ---------------------------------------------------------------------------


async def _case6_async() -> None:
    """Drives the real ``tts_synthesize``/``tts_cancel`` route functions
    directly (not through any ASGI transport). This is deliberate: both
    ``starlette.testclient.TestClient`` (blocking portal) and
    ``httpx.ASGITransport`` (verified via its source —
    ``ASGIResponseStream`` buffers the whole body into a list before the
    Response is ever returned) fully drain a StreamingResponse before
    control comes back to the caller, so neither can observe a genuinely
    in-flight request. Calling the route coroutines directly on this same
    event loop drives the exact same production code path (same
    ``_tts_cancel`` registry, same ``cancel_event``) with true concurrency:
    awaiting the first chunk actually suspends on the Aura stub's
    ``asyncio.sleep``, letting ``tts_cancel`` run and set the event before
    the generator is resumed for chunk 2.
    """
    request_id = "cancel-rid-6"
    req = voice_server.TTSRequest(text="hello", request_id=request_id, engine="aura")
    response = await voice_server.tts_synthesize(req)

    collected = bytearray()
    body_iter = response.body_iterator.__aiter__()

    first_chunk = await body_iter.__anext__()
    collected.extend(first_chunk)

    cancel_result = await voice_server.tts_cancel(voice_server.TTSCancelRequest(request_id=request_id))
    assert cancel_result == {"cancelled": True}, cancel_result

    async for chunk in body_iter:
        collected.extend(chunk)

    assert _AuraCalls.observed_cancel_set and _AuraCalls.observed_cancel_set[-1] is True, (
        "the Aura stub never observed cancel_event set",
        _AuraCalls.observed_cancel_set,
    )
    # Fewer bytes than the full 4-chunk stream would have produced — proof
    # that cancellation actually stopped it early, not that it ran to completion.
    assert len(collected) < len(b"".join(_AuraCalls.chunks)), len(collected)


def test_case6_cancellation_parity() -> None:
    voice_server.TTS_ENGINE = "kokoro"
    voice_server.DEEPGRAM_API_KEY = "case6-key-not-a-real-secret"
    _reset()
    _AuraCalls.chunks = [b"AURA-C1", b"AURA-C2", b"AURA-C3", b"AURA-C4"]
    _AuraCalls.delay_s = 0.05  # small await between chunks — gives /tts/cancel a window

    asyncio.run(_case6_async())


# ---------------------------------------------------------------------------
# Case 7: Key hygiene — the sentinel key value appears in no response body
# and nowhere in the /health JSON.
# ---------------------------------------------------------------------------


def test_case7_key_hygiene(client: TestClient) -> None:
    sentinel = "SENTINEL-DG-TTS-KEY-9f8e7d6c5b4a"
    voice_server.TTS_ENGINE = "aura"
    voice_server.DEEPGRAM_API_KEY = sentinel
    _reset()

    resp = client.post("/tts", json={"text": "hello"})
    assert sentinel not in resp.content.decode("latin-1"), "sentinel key leaked into /tts response body"

    health_resp = client.get("/health")
    assert sentinel not in health_resp.text, "sentinel key leaked into /health response"


# ---------------------------------------------------------------------------
# Case 8: engine-scoped voice (WR-03) — a Kokoro-shaped voice must never be
# forwarded to Deepgram as a (bogus) Aura model; only aura-* ids are honored
# on the Aura path. JARVIS_TTS_VOICE predates Aura and always means "Kokoro
# voice", so a set value must not silently defeat the Aura default.
# ---------------------------------------------------------------------------


def test_case8_engine_scoped_voice(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "aura"
    voice_server.DEEPGRAM_API_KEY = "case8-key-not-a-real-secret"

    # (a) Kokoro blend spec (what the TS client sends whenever
    # JARVIS_TTS_VOICE is set) on the Aura path → Aura serves with
    # DEEPGRAM_TTS_MODEL; Deepgram never sees the blend; Kokoro never runs.
    _reset()
    resp = client.post(
        "/tts", json={"text": "hello", "voice": "bm_george:0.7,bf_emma:0.3"}
    )
    assert resp.status_code == 200, resp.status_code
    assert resp.content == b"".join(AURA_CHUNKS_DEFAULT), resp.content
    assert _AuraCalls.calls[-1]["voice"] == voice_server.DEEPGRAM_TTS_MODEL, _AuraCalls.calls[-1]
    assert not _KokoroCalls.calls, "Kokoro must not serve when Aura succeeds"

    # (b) An Aura-shaped voice IS forwarded verbatim.
    _reset()
    resp2 = client.post("/tts", json={"text": "hello", "voice": "aura-2-pandora-en"})
    assert resp2.status_code == 200, resp2.status_code
    assert _AuraCalls.calls[-1]["voice"] == "aura-2-pandora-en", _AuraCalls.calls[-1]

    # (c) The same Kokoro-shaped voice still applies on the kokoro engine.
    _reset()
    resp3 = client.post(
        "/tts", json={"text": "hello", "engine": "kokoro", "voice": "bm_fable"}
    )
    assert resp3.status_code == 200, resp3.status_code
    assert resp3.content == KOKORO_BYTES, resp3.content
    assert _KokoroCalls.calls[-1]["voice"] == "bm_fable", _KokoroCalls.calls[-1]
    assert not _AuraCalls.calls, "Aura must not be attempted on the kokoro engine"


# ---------------------------------------------------------------------------
# Case 9: cancel-registry lifecycle (WR-06) — registration now lives INSIDE
# the response generator, next to echo_gate.register_start, so a generator
# that never starts (client disconnected before streaming; Starlette can
# cancel the stream task before the first __anext__, and aclose() on an
# unstarted async generator runs none of its body) leaks no _tts_cancel
# entry and a later /tts/cancel for that id honestly reports false.
# ---------------------------------------------------------------------------


async def _case9_async() -> None:
    # (a) Never-iterated response: nothing registered, cancel says false.
    request_id = "leak-rid-9"
    req = voice_server.TTSRequest(text="hello", request_id=request_id, engine="aura")
    response = await voice_server.tts_synthesize(req)
    assert request_id not in voice_server._tts_cancel, (
        "route-level registration leaked a _tts_cancel entry before the "
        "generator ever started (WR-06)"
    )
    cancel_result = await voice_server.tts_cancel(
        voice_server.TTSCancelRequest(request_id=request_id)
    )
    assert cancel_result == {"cancelled": False}, cancel_result
    # aclose() on the un-started generator runs none of its body — still clean.
    await response.body_iterator.aclose()
    assert request_id not in voice_server._tts_cancel

    # (b) A consumed request registers on first iteration and pops on completion.
    req2 = voice_server.TTSRequest(text="hello", request_id="leak-rid-9b", engine="aura")
    response2 = await voice_server.tts_synthesize(req2)
    body_iter = response2.body_iterator.__aiter__()
    await body_iter.__anext__()
    assert "leak-rid-9b" in voice_server._tts_cancel, (
        "a started generator must register its cancel event"
    )
    async for _ in body_iter:
        pass
    assert "leak-rid-9b" not in voice_server._tts_cancel, (
        "a finished generator must pop its registry entry"
    )


def test_case9_registry_lifecycle() -> None:
    voice_server.TTS_ENGINE = "kokoro"
    voice_server.DEEPGRAM_API_KEY = "case9-key-not-a-real-secret"
    _reset()
    asyncio.run(_case9_async())


def main() -> None:
    orig_tts_mgr = voice_server.tts_mgr
    orig_engine = voice_server.TTS_ENGINE
    orig_key = voice_server.DEEPGRAM_API_KEY
    orig_tts_voice = voice_server.TTS_VOICE
    orig_kokoro_synth = tts.synthesize_streaming
    orig_aura_synth = deepgram_tts.synthesize_streaming_aura
    try:
        voice_server.tts_mgr = _StubTtsMgr()
        voice_server.TTS_VOICE = TEST_KOKORO_VOICE_SPEC
        with TestClient(voice_server.app) as client:
            test_case1_default_engine(client)
            test_case2_per_request_aura(client)
            test_case3_env_selected_aura(client)
            test_case4_aura_degraded_no_key(client)
            test_case5_aura_fails_mid_request(client)
            test_case6_cancellation_parity()
            test_case7_key_hygiene(client)
            test_case8_engine_scoped_voice(client)
            test_case9_registry_lifecycle()
    finally:
        voice_server.tts_mgr = orig_tts_mgr
        voice_server.TTS_ENGINE = orig_engine
        voice_server.DEEPGRAM_API_KEY = orig_key
        voice_server.TTS_VOICE = orig_tts_voice
        tts.synthesize_streaming = orig_kokoro_synth
        deepgram_tts.synthesize_streaming_aura = orig_aura_synth
    print("TTS_SELFTEST_OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"SELFTEST FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
