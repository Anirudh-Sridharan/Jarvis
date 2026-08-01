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

Twelve cases are asserted:
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
    10. Stall fallback, route level (WR-07) — an Aura stream reporting
        outcome "stalled" after partial audio falls through to Kokoro in
        the SAME response; /health surfaces the stall reason.
    11. Real Aura generator read deadline (WR-07) — drives the REAL
        synthesize_streaming_aura against a scripted stalled-but-alive
        socket: (a) the bounded read ends the stream with outcome
        "stalled" instead of hanging; (b) cancel_event is observed even
        while a read is pending (outcome "cancelled").
    12. Voice resolution off the event loop (WR-08) — a blend-spec cache
        miss runs pipeline.load_voice on an executor thread (never the
        loop thread) and the loop keeps ticking while it loads; a repeat
        resolve is a cache hit.

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

# A no-colon override for voice_server.TTS_VOICE so _voice_for_async()'s blend-parse
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
    # What the stub writes into outcome["result"] when the chunk list is
    # exhausted normally ("stalled" scripts a WR-07 mid-request stall).
    outcome_result: Optional[str] = "complete"


async def _aura_stub(
    text: str,
    api_key: str,
    voice: str = deepgram_tts.DEFAULT_AURA_VOICE,
    sample_rate: int = deepgram_tts.AURA_SAMPLE_RATE,
    cancel_event: Optional[asyncio.Event] = None,
    outcome: Optional[Dict[str, str]] = None,
) -> AsyncGenerator[bytes, None]:
    _AuraCalls.calls.append({"text": text, "api_key": api_key, "voice": voice})
    for chunk in _AuraCalls.chunks:
        if _AuraCalls.delay_s:
            await asyncio.sleep(_AuraCalls.delay_s)
        if cancel_event is not None and cancel_event.is_set():
            _AuraCalls.observed_cancel_set.append(True)
            if outcome is not None:
                outcome["result"] = "cancelled"
            return
        yield chunk
    if outcome is not None and _AuraCalls.outcome_result is not None:
        outcome["result"] = _AuraCalls.outcome_result


def _reset() -> None:
    _KokoroCalls.calls = []
    _KokoroCalls.chunks = [KOKORO_BYTES]
    _AuraCalls.calls = []
    _AuraCalls.chunks = list(AURA_CHUNKS_DEFAULT)
    _AuraCalls.delay_s = 0.0
    _AuraCalls.observed_cancel_set = []
    _AuraCalls.outcome_result = "complete"


# Captured BEFORE the monkeypatch below — case 11 drives the REAL Aura
# generator's read-deadline/cancel-watch machinery against a scripted socket.
_REAL_AURA_SYNTH = deepgram_tts.synthesize_streaming_aura

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


# ---------------------------------------------------------------------------
# Case 10: mid-request STALL fallback (WR-07, route level) — an Aura stream
# that stalls after partial audio must fall through to Kokoro in the SAME
# response (not hang, not end truncated), with the stall surfaced on
# /health.tts_engine.
# ---------------------------------------------------------------------------


def test_case10_stall_falls_back_same_request(client: TestClient) -> None:
    voice_server.TTS_ENGINE = "aura"
    voice_server.DEEPGRAM_API_KEY = "case10-key-not-a-real-secret"
    _reset()
    _AuraCalls.chunks = [b"AURA-PARTIAL-1"]
    _AuraCalls.outcome_result = "stalled"

    resp = client.post("/tts", json={"text": "hello"})

    assert resp.status_code == 200, resp.status_code
    # Partial Aura bytes, then the FULL Kokoro fallback, in one response.
    assert resp.content == b"AURA-PARTIAL-1" + KOKORO_BYTES, resp.content
    assert _KokoroCalls.calls, "Kokoro fallback must run in the same request on a stall"

    health = client.get("/health").json()
    assert health["tts_engine"]["active"] == "kokoro", health["tts_engine"]
    assert "stalled" in (health["tts_engine"]["reason"] or ""), health["tts_engine"]


# ---------------------------------------------------------------------------
# Case 11: REAL Aura generator read-deadline + concurrent cancel watch
# (WR-07, deepgram_tts level) — drives _REAL_AURA_SYNTH against a scripted
# stalled-but-alive socket (one audio frame, then recv never resolves) with
# websockets' connect() patched at the module attribute deepgram_tts imports.
# ---------------------------------------------------------------------------


class _StallingWs:
    """Fake Aura socket: one binary frame, then alive-but-silent forever."""

    def __init__(self) -> None:
        self.sent: List[Any] = []
        self._yielded = False

    async def send(self, data: Any) -> None:
        self.sent.append(data)

    async def recv(self) -> Any:
        if not self._yielded:
            self._yielded = True
            return b"REAL-AURA-CHUNK"
        await asyncio.sleep(3600)  # stalled-but-alive: never resolves


class _FakeConnectCtx:
    def __init__(self) -> None:
        self.ws = _StallingWs()

    async def __aenter__(self) -> Any:
        return self.ws

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


async def _case11_async() -> None:
    import websockets.asyncio.client as wac

    orig_connect = wac.connect
    orig_timeout = deepgram_tts.READ_TIMEOUT_S
    wac.connect = lambda *_a, **_k: _FakeConnectCtx()  # type: ignore[assignment]
    try:
        # (a) Read deadline: the stalled socket ends the stream with
        # outcome "stalled" after yielding the one real chunk — previously
        # this hung indefinitely on `async for message in ws`.
        deepgram_tts.READ_TIMEOUT_S = 0.05
        outcome: Dict[str, str] = {}
        chunks: List[bytes] = []
        async for chunk in _REAL_AURA_SYNTH(
            text="hi", api_key="case11-key-not-a-real-secret", outcome=outcome
        ):
            chunks.append(chunk)
        assert chunks == [b"REAL-AURA-CHUNK"], chunks
        assert outcome.get("result") == "stalled", outcome

        # (b) Cancellation is observed even while a read is pending
        # (previously only checked when a message arrived): with a long
        # read deadline, setting cancel_event mid-stall ends the stream
        # promptly with outcome "cancelled".
        deepgram_tts.READ_TIMEOUT_S = 30.0
        cancel_event = asyncio.Event()

        async def _set_cancel() -> None:
            await asyncio.sleep(0.05)
            cancel_event.set()

        canceller = asyncio.create_task(_set_cancel())
        outcome2: Dict[str, str] = {}
        chunks2: List[bytes] = []
        async for chunk in _REAL_AURA_SYNTH(
            text="hi",
            api_key="case11-key-not-a-real-secret",
            cancel_event=cancel_event,
            outcome=outcome2,
        ):
            chunks2.append(chunk)
        await canceller
        assert chunks2 == [b"REAL-AURA-CHUNK"], chunks2
        assert outcome2.get("result") == "cancelled", outcome2
    finally:
        wac.connect = orig_connect
        deepgram_tts.READ_TIMEOUT_S = orig_timeout


def test_case11_real_generator_read_deadline() -> None:
    asyncio.run(_case11_async())


# ---------------------------------------------------------------------------
# Case 12: voice resolution off the event loop (WR-08) — a blend-spec cache
# miss runs pipeline.load_voice (blocking torch/file I/O) on the executor,
# never on the loop thread, and the loop keeps servicing other coroutines
# while it loads.
# ---------------------------------------------------------------------------


async def _case12_async() -> None:
    import threading
    import time as _time

    loaded_on: List[Any] = []

    class _SlowPipeline:
        def load_voice(self, _name: str) -> Any:
            import torch  # type: ignore[import]

            loaded_on.append(threading.current_thread())
            _time.sleep(0.15)  # stand-in for blocking voicepack tensor/disk I/O
            return torch.zeros(4)

    class _SlowTtsMgr(_StubTtsMgr):
        def get_pipeline(self) -> Any:
            return _SlowPipeline()

    spec = "bm_case12_a:0.5,bm_case12_b:0.5"
    orig_mgr = voice_server.tts_mgr
    voice_server.tts_mgr = _SlowTtsMgr()
    ticks = [0]
    stop = asyncio.Event()

    async def _heartbeat() -> None:
        while not stop.is_set():
            ticks[0] += 1
            await asyncio.sleep(0.01)

    hb = asyncio.create_task(_heartbeat())
    try:
        resolved = await voice_server._voice_for_async(spec)
        assert resolved is not None
        # Cache hit resolves without touching the pipeline again.
        again = await voice_server._voice_for_async(spec)
        assert again is resolved, "second resolve must be a cache hit"
    finally:
        stop.set()
        await hb
        voice_server.tts_mgr = orig_mgr
        voice_server._resolved_voices.pop(spec, None)

    loop_thread = threading.current_thread()
    assert loaded_on and all(t is not loop_thread for t in loaded_on), (
        "pipeline.load_voice ran on the event-loop thread (WR-08)",
        loaded_on,
    )
    assert len(loaded_on) == 2, ("expected exactly one load per blend component", loaded_on)
    # ~0.3s of blocking I/O with a 10ms heartbeat: off-loop → ~30 ticks;
    # on-loop → the heartbeat would starve to ~1-2.
    assert ticks[0] >= 5, f"event loop starved during voice resolution (ticks={ticks[0]})"


def test_case12_voice_resolution_off_loop() -> None:
    voice_server.TTS_ENGINE = "kokoro"
    voice_server.DEEPGRAM_API_KEY = None
    _reset()
    asyncio.run(_case12_async())


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
            test_case10_stall_falls_back_same_request(client)
            test_case11_real_generator_read_deadline()
            test_case12_voice_resolution_off_loop()
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
