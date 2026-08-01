"""Hermetic FastAPI TestClient WS integration selftest for `/stt/stream`'s
engine branch (plan 13.2-03).

No test framework is used (Python has none installed in this sidecar) —
plain asserts, following ``selftest.py``'s standalone-script precedent. Run
directly:

    ./.venv/bin/python stt_stream_selftest.py

Zero network, zero real models, zero real Deepgram key: ``voice_server.stt_mgr``
is replaced with a stub exposing scripted VAD/whisper objects, and
``deepgram_stt.DeepgramSttSession`` is replaced with a scriptable fake that
implements the exact same public surface (``connect``/``send_audio``/
``drain_partials``/``finalize_segment``/``close``/``last_error``).

Nine cases are asserted:
    1. Deepgram happy path — one final per VAD segment, whisper never touched,
       begin_segment called on Silero's speech_start.
    2. No key — faster-whisper path, no error frame, /health explains why.
    3. Connect failure — faster-whisper path, no error frame, no abnormal close.
    4. Mid-session death — the following segment finishes on faster-whisper.
    5. Key hygiene — a sentinel key value appears in no frame and nowhere in
       the /health JSON.
    6. Frame-shape pin — every frame collected above matches the documented
       key set for its ``type``, and no undocumented frame type was sent.
       (Runs AFTER case 8 in main() so echo-gated sessions' frames are pinned
       too — suppression must drop whole frames, never reshape them.)
    7. Real-session Results sequencing (live-defect regression,
       .planning/debug/deepgram-stt-live-defects.md): drives the REAL
       ``DeepgramSttSession`` receive loop with a scripted fake Deepgram WS —
       (a) inter-segment junk results are never banked, (b) a late
       duplicate final arriving after finalize_segment does not leak into
       the next segment's final, (c) a stale result (audio window before the
       open segment) is rejected even while the segment is open, and (d)
       finalize's coverage wait returns the complete banked text.
    8. Echo gate, wire level (round-2 live-defect regression, same session
       file): with a TTS synthesis window ACTIVE, (a) an echo-similar
       Deepgram final is suppressed (frame never sent), (b) a dissimilar
       final passes during the SAME window, (c) a low-word-confidence
       hallucination ("Thea, Annie Rhodes." for a reply containing
       "Alex") is suppressed via the word-confidence tier, (d) after the
       window expires the same echo-similar text passes unaffected, and
       (e) the faster-whisper fallback path is gated identically.
    9. Echo gate, pure decision table — the live + isolated-sidecar-collected
       sample set: echo/hallucination candidates suppress, genuine
       interruptions (including token-overlapping ones) pass, and the
       disable knobs (enabled=False, conf_threshold=0) behave.

Prints ``STT_STREAM_SELFTEST_OK`` and exits 0 on success; prints a failure
message to stderr and exits non-zero otherwise.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Dict, List, Optional

import numpy as np  # type: ignore[import]
from fastapi.testclient import TestClient

import deepgram_stt  # type: ignore[import]
import voice_server  # type: ignore[import]
from stt import FRAME_SAMPLES, MIN_SPEECH_FRAMES, SILENCE_HANGOVER  # type: ignore[import]

# ---------------------------------------------------------------------------
# Audio fixtures — a "full segment" is enough speech frames to clear
# MIN_SPEECH_FRAMES followed by enough silent frames to clear SILENCE_HANGOVER,
# producing exactly speech_start + speech_end (+ one final) per VAD pass.
# ---------------------------------------------------------------------------


def _speech_bytes(n_frames: int) -> bytes:
    return np.full(FRAME_SAMPLES, 1000, dtype=np.int16).tobytes() * n_frames


def _silence_bytes(n_frames: int) -> bytes:
    return np.zeros(FRAME_SAMPLES, dtype=np.int16).tobytes() * n_frames


def _full_segment_bytes() -> bytes:
    return _speech_bytes(MIN_SPEECH_FRAMES + 1) + _silence_bytes(SILENCE_HANGOVER + 2)


# ---------------------------------------------------------------------------
# Stub VAD (Silero) + whisper — same shape as selftest.py's stubs.
# ---------------------------------------------------------------------------


class _FakeVadResult:
    def __init__(self, value: float) -> None:
        self._value = value

    def item(self) -> float:
        return self._value


def _stub_vad(frame_tensor: Any, _sample_rate: int) -> _FakeVadResult:
    import torch  # type: ignore[import]

    is_speech = bool(torch.any(frame_tensor != 0))
    return _FakeVadResult(0.9 if is_speech else 0.0)


class _NeverCalledWhisper:
    """Proves the Deepgram path never touches the whisper decode."""

    @property
    def transcribe(self) -> Any:
        raise AssertionError("whisper.transcribe must never be touched on the Deepgram path")


class _FakeSegment:
    def __init__(self, text: str, avg_logprob: float) -> None:
        self.text = text
        self.avg_logprob = avg_logprob


class _WorkingWhisper:
    def __init__(self, text: str) -> None:
        self._text = text

    def transcribe(self, _audio: Any, **_kwargs: Any) -> tuple:
        return [_FakeSegment(self._text, -0.1)], None


class _StubSttMgr:
    """Replaces ``voice_server.stt_mgr`` — no real models, no lock."""

    def __init__(self, whisper: Any) -> None:
        self.state = "ready"
        self._whisper = whisper

    async def ensure_ready(self) -> None:
        return None

    async def unload(self) -> None:
        return None

    def get_vad_model(self) -> Any:
        return _stub_vad

    def get_whisper(self) -> Any:
        return self._whisper


# ---------------------------------------------------------------------------
# Fake DeepgramSttSession — same public surface as deepgram_stt.DeepgramSttSession,
# fully scriptable via class attributes reset before each case.
# ---------------------------------------------------------------------------


class _FakeDgSession:
    connect_result = True
    connect_error = "fake connect failure"
    send_audio_fail_after: Optional[int] = None  # None = never fails
    finalize_text: Optional[str] = "deepgram final text"
    finalize_confidence = 0.91
    finalize_word_confs: Optional[List[float]] = None  # echo-gate tier-3 side-channel

    instances: List["_FakeDgSession"] = []

    def __init__(
        self,
        api_key: str,
        model: str,
        sample_rate: int,
        connect_timeout_s: float,
        finalize_timeout_s: float,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.sample_rate = sample_rate
        self.connect_timeout_s = connect_timeout_s
        self.finalize_timeout_s = finalize_timeout_s
        self._send_count = 0
        self._last_error: Optional[str] = None
        self.received_audio = bytearray()
        self.finalize_calls = 0
        self.begin_segment_calls = 0
        self.closed = False
        _FakeDgSession.instances.append(self)

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    async def connect(self) -> bool:
        if _FakeDgSession.connect_result:
            return True
        self._last_error = _FakeDgSession.connect_error
        return False

    async def send_audio(self, pcm: bytes) -> bool:
        self._send_count += 1
        self.received_audio.extend(pcm)
        if (
            _FakeDgSession.send_audio_fail_after is not None
            and self._send_count > _FakeDgSession.send_audio_fail_after
        ):
            self._last_error = "fake send_audio failure"
            return False
        return True

    def begin_segment(self) -> None:
        self.begin_segment_calls += 1

    @property
    def last_word_confs(self) -> List[float]:
        return list(_FakeDgSession.finalize_word_confs or [])

    def drain_partials(self) -> List[dict]:
        return []

    async def finalize_segment(self) -> Optional[dict]:
        self.finalize_calls += 1
        if _FakeDgSession.finalize_text is None:
            return None
        return {
            "type": "final",
            "text": _FakeDgSession.finalize_text,
            "confidence": _FakeDgSession.finalize_confidence,
        }

    async def close(self) -> None:
        self.closed = True


def _reset_fake_dg_session(**overrides: Any) -> None:
    _FakeDgSession.connect_result = True
    _FakeDgSession.connect_error = "fake connect failure"
    _FakeDgSession.send_audio_fail_after = None
    _FakeDgSession.finalize_text = "deepgram final text"
    _FakeDgSession.finalize_confidence = 0.91
    _FakeDgSession.finalize_word_confs = None
    _FakeDgSession.instances = []
    for key, value in overrides.items():
        setattr(_FakeDgSession, key, value)


# Captured BEFORE the monkeypatch below — case 7 drives the REAL session class.
_RealDgSession = deepgram_stt.DeepgramSttSession

deepgram_stt.DeepgramSttSession = _FakeDgSession  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# WS driver + frame collection for the shape-pin case.
# ---------------------------------------------------------------------------

ALL_FRAMES: List[Dict[str, Any]] = []


def _drive_ws(client: TestClient, audio_chunks: List[bytes], expected_frame_count: int) -> List[Dict[str, Any]]:
    frames: List[Dict[str, Any]] = []
    with client.websocket_connect("/stt/stream") as ws:
        for chunk in audio_chunks:
            ws.send_bytes(chunk)
        for _ in range(expected_frame_count):
            frames.append(json.loads(ws.receive_text()))
    ALL_FRAMES.extend(frames)
    return frames


# ---------------------------------------------------------------------------
# Case 1: Deepgram happy path.
# ---------------------------------------------------------------------------


def test_case1_deepgram_happy_path(client: TestClient) -> None:
    voice_server.DEEPGRAM_API_KEY = "case1-key-not-a-real-secret"
    voice_server.DEEPGRAM_STT_ENABLED = "1"
    _reset_fake_dg_session(finalize_text="deepgram happy path text")
    voice_server.stt_mgr = _StubSttMgr(_NeverCalledWhisper())

    frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=3)

    types = [f["type"] for f in frames]
    assert types == ["speech_start", "speech_end", "final"], types
    assert frames[2]["text"] == "deepgram happy path text", frames[2]
    assert isinstance(frames[1].get("silence_ms"), int), frames[1]

    session = _FakeDgSession.instances[-1]
    assert session.finalize_calls == 1, session.finalize_calls
    assert session.begin_segment_calls == 1, session.begin_segment_calls
    assert bytes(session.received_audio) == _full_segment_bytes()

    health = client.get("/health").json()
    assert health["stt_engine"]["active"] == "deepgram", health["stt_engine"]


# ---------------------------------------------------------------------------
# Case 2: No key.
# ---------------------------------------------------------------------------


def test_case2_no_key(client: TestClient) -> None:
    voice_server.DEEPGRAM_API_KEY = None
    voice_server.DEEPGRAM_STT_ENABLED = "1"
    voice_server.stt_mgr = _StubSttMgr(_WorkingWhisper("whisper text case2"))

    frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=3)

    types = [f["type"] for f in frames]
    assert types == ["speech_start", "speech_end", "final"], types
    assert frames[2]["text"] == "whisper text case2", frames[2]
    assert not any(f["type"] == "error" for f in frames), frames

    health = client.get("/health").json()
    assert health["stt_engine"]["configured"] == "faster-whisper", health["stt_engine"]
    assert health["stt_engine"]["reason"] == "DEEPGRAM_API_KEY not set", health["stt_engine"]


# ---------------------------------------------------------------------------
# Case 3: Connect failure.
# ---------------------------------------------------------------------------


def test_case3_connect_failure(client: TestClient) -> None:
    voice_server.DEEPGRAM_API_KEY = "case3-key-not-a-real-secret"
    voice_server.DEEPGRAM_STT_ENABLED = "1"
    _reset_fake_dg_session(connect_result=False, connect_error="simulated 401")
    voice_server.stt_mgr = _StubSttMgr(_WorkingWhisper("whisper text case3"))

    frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=3)

    types = [f["type"] for f in frames]
    assert types == ["speech_start", "speech_end", "final"], types
    assert frames[2]["text"] == "whisper text case3", frames[2]
    assert not any(f["type"] == "error" for f in frames), frames

    health = client.get("/health").json()
    assert health["stt_engine"]["active"] == "faster-whisper", health["stt_engine"]
    assert health["stt_engine"]["reason"] == "simulated 401", health["stt_engine"]


# ---------------------------------------------------------------------------
# Case 4: Mid-session death.
# ---------------------------------------------------------------------------


def test_case4_mid_session_death(client: TestClient) -> None:
    voice_server.DEEPGRAM_API_KEY = "case4-key-not-a-real-secret"
    voice_server.DEEPGRAM_STT_ENABLED = "1"
    _reset_fake_dg_session(send_audio_fail_after=0)  # the very first send_audio call fails
    voice_server.stt_mgr = _StubSttMgr(_WorkingWhisper("whisper text case4"))

    # Message 1: less than one full VAD frame — no VAD event fires, but it
    # still drives the (failing) send_audio call.
    partial_chunk = np.full(FRAME_SAMPLES, 1000, dtype=np.int16).tobytes()[:500]
    # Message 2: the FOLLOWING segment, now fully on faster-whisper.
    frames = _drive_ws(client, [partial_chunk, _full_segment_bytes()], expected_frame_count=3)

    types = [f["type"] for f in frames]
    assert types == ["speech_start", "speech_end", "final"], types
    assert frames[2]["text"] == "whisper text case4", frames[2]

    health = client.get("/health").json()
    assert health["stt_engine"]["active"] == "faster-whisper", health["stt_engine"]
    assert health["stt_engine"]["reason"] == "fake send_audio failure", health["stt_engine"]


# ---------------------------------------------------------------------------
# Case 5: Key hygiene.
# ---------------------------------------------------------------------------


def test_case5_key_hygiene(client: TestClient) -> None:
    sentinel = "SENTINEL-DG-KEY-9f8e7d6c5b4a"
    voice_server.DEEPGRAM_API_KEY = sentinel
    voice_server.DEEPGRAM_STT_ENABLED = "1"
    _reset_fake_dg_session(finalize_text="deepgram text case5")
    voice_server.stt_mgr = _StubSttMgr(_NeverCalledWhisper())

    frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=3)
    for frame in frames:
        assert sentinel not in json.dumps(frame), frame

    health_resp = client.get("/health")
    assert sentinel not in health_resp.text


# ---------------------------------------------------------------------------
# Case 6: Frame-shape pin — every frame collected above matches the
# documented contract for its type; no undocumented type was ever sent.
# ---------------------------------------------------------------------------

_ALLOWED_KEYS: Dict[str, set] = {
    "speech_start": {"type"},
    "partial": {"type", "text", "stability"},
    "final": {"type", "text", "confidence"},
    "speech_end": {"type", "silence_ms"},
}


def test_case6_frame_shape_pin() -> None:
    assert ALL_FRAMES, "expected frames collected from prior cases"
    for frame in ALL_FRAMES:
        ftype = frame.get("type")
        assert ftype in _ALLOWED_KEYS, f"undocumented frame type: {ftype!r}"
        allowed = _ALLOWED_KEYS[ftype]
        extra = set(frame.keys()) - allowed
        assert not extra, f"frame {frame!r} has undocumented keys: {extra}"


# ---------------------------------------------------------------------------
# Case 7: real-session Results sequencing — live-defect regression
# (.planning/debug/deepgram-stt-live-defects.md). Drives the REAL
# DeepgramSttSession receive loop + SegmentAccumulator with a scripted fake
# Deepgram WS. No network, no key: the WS object is injected directly.
# ---------------------------------------------------------------------------


class _ScriptedDgWs:
    """Fake Deepgram /v1/listen socket: records sends, replays scripted JSON."""

    def __init__(self) -> None:
        self.sent: List[Any] = []
        self._queue: "asyncio.Queue[Optional[str]]" = asyncio.Queue()

    async def send(self, data: Any) -> None:
        self.sent.append(data)

    def push_results(
        self,
        transcript: str,
        *,
        is_final: bool,
        speech_final: bool = False,
        from_finalize: bool = False,
        start: float = 0.0,
        duration: float = 0.0,
        confidence: float = 0.9,
    ) -> None:
        self._queue.put_nowait(
            json.dumps(
                {
                    "type": "Results",
                    "is_final": is_final,
                    "speech_final": speech_final,
                    "from_finalize": from_finalize,
                    "start": start,
                    "duration": duration,
                    "channel": {
                        "alternatives": [
                            {"transcript": transcript, "confidence": confidence}
                        ]
                    },
                }
            )
        )

    def end(self) -> None:
        self._queue.put_nowait(None)

    def __aiter__(self) -> "_ScriptedDgWs":
        return self

    async def __anext__(self) -> str:
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def close(self) -> None:
        return None


async def _case7_scenario() -> None:
    import time as _time

    # 16 kHz mono s16le → 32 000 bytes per stream-second.
    session = _RealDgSession(
        "case7-key-not-a-real-secret", finalize_timeout_s=0.3
    )
    ws = _ScriptedDgWs()
    session._ws = ws
    session._alive = True
    session._receive_task = asyncio.create_task(session._receive_loop())

    async def settle() -> None:
        for _ in range(20):
            await asyncio.sleep(0.001)

    # (a) Inter-segment junk (speaker echo / noise Silero never segmented)
    # arriving with NO segment open must never be banked.
    ws.push_results("junk echo noise", is_final=True, start=0.1, duration=0.5)
    await settle()

    # ---- Segment 1: 2.0 s of audio sent, then Silero speech_start. ----
    assert await session.send_audio(b"\x00" * 64000)  # stream pos 2.0 s
    session.begin_segment()  # segment_start = 1.5 s (2.0 - 0.5 margin)
    ws.push_results("pack two", is_final=False, start=1.0, duration=0.4)
    ws.push_results(
        "pack two three", is_final=True, speech_final=True, start=1.0, duration=0.8
    )
    await settle()
    t0 = _time.monotonic()
    final1 = await session.finalize_segment()
    fast_elapsed = _time.monotonic() - t0
    assert final1 is not None and final1["text"] == "pack two three", final1
    # (d) coverage fast-path: banked coverage (1.8 s) is within the slack of
    # the segment end (2.0 s) → finalize returns without burning its timeout.
    assert fast_elapsed < 0.15, f"coverage fast-path burned the timeout: {fast_elapsed:.3f}s"

    # (b) LATE duplicate flush — the live "Pack two three." delivered twice:
    # the same utterance's from_finalize lands AFTER take_final. Must be
    # dropped, not banked into the next segment.
    ws.push_results(
        "pack two three", is_final=True, from_finalize=True, start=1.0, duration=0.8
    )
    await settle()

    # ---- Segment 2: stream advances to 10.0 s, new Silero segment. ----
    assert await session.send_audio(b"\x00" * 256000)  # stream pos 10.0 s
    session.begin_segment()  # segment_start = 9.5 s
    # (c) stale-window rejection WHILE OPEN: a late-decoded tail of earlier
    # audio (window 4.0–5.0 s) arriving during segment 2 must be rejected.
    ws.push_results("the appointment", is_final=True, start=4.0, duration=1.0)
    ws.push_results(
        "next words", is_final=True, speech_final=True, start=9.6, duration=0.3
    )
    await settle()
    final2 = await session.finalize_segment()
    assert final2 is not None and final2["text"] == "next words", final2

    # ---- Segment 3: burst lag — coverage short, bounded wait, clean text. ----
    assert await session.send_audio(b"\x00" * 64000)  # stream pos 12.0 s
    session.begin_segment()  # segment_start = 11.5 s
    assert await session.send_audio(b"\x00" * 320000)  # segment audio → 22.0 s
    ws.push_results("part one", is_final=True, start=11.6, duration=1.4)
    await settle()
    # Mid-wait arrival that still leaves coverage short of the segment end:
    asyncio.get_running_loop().call_later(
        0.02,
        lambda: ws.push_results(
            "part two", is_final=True, from_finalize=True, start=13.0, duration=1.5
        ),
    )
    t0 = _time.monotonic()
    final3 = await session.finalize_segment()
    wait_elapsed = _time.monotonic() - t0
    # Coverage (14.5 s) never reaches segment end (22.0 s) − slack → the wait
    # is BOUNDED by the timeout and returns everything banked, in order,
    # truncated but clean (no stale text, no loss of banked pieces).
    assert final3 is not None and final3["text"] == "part one part two", final3
    assert wait_elapsed >= 0.25, f"expected bounded wait to reach its budget: {wait_elapsed:.3f}s"

    # One Finalize control message per segment.
    finalize_msgs = [
        d for d in ws.sent if isinstance(d, str) and '"Finalize"' in d
    ]
    assert len(finalize_msgs) == 3, ws.sent

    ws.end()
    await session.close()


def test_case7_real_session_sequencing() -> None:
    import asyncio as _asyncio

    _asyncio.run(_case7_scenario())


# ---------------------------------------------------------------------------
# Case 8: echo gate, wire level (round-2 live-defect regression). A TTS
# synthesis window is registered on a clock-injected EchoGate; echo-similar
# finals must be dropped BEFORE the WebSocket while dissimilar finals pass,
# and expiry of the window restores pass-through. Sub-case (e) proves the
# faster-whisper fallback path is gated by the same chokepoint.
# ---------------------------------------------------------------------------

_REPLY_TEXT = (
    "Good evening, Alex. Here is what is on your plate today. Your calendar is "
    "clear this afternoon, and there are two reminders pending. Would you like me "
    "to go through them now?"
)


def test_case8_echo_gate_wire(client: TestClient) -> None:
    from echo_gate import EchoGate

    fake_now = [1000.0]
    orig_gate = voice_server.echo_gate
    voice_server.echo_gate = EchoGate(
        enabled=True,
        sim_threshold=0.72,
        conf_threshold=0.85,
        decay_s=3.0,
        clock=lambda: fake_now[0],
    )
    try:
        gate = voice_server.echo_gate
        voice_server.DEEPGRAM_API_KEY = "case8-key-not-a-real-secret"
        voice_server.DEEPGRAM_STT_ENABLED = "1"
        voice_server.stt_mgr = _StubSttMgr(_NeverCalledWhisper())

        # Reply streaming: window open (no end), 10 s of audio noted.
        gate.register_start("tts-echo-1", _REPLY_TEXT)
        gate.note_audio_bytes("tts-echo-1", 480000)  # 10.0 s @ 48 000 B/s

        # (a) Echo-similar hallucinated final (8091 repro, Nova-3 conf 0.98)
        # during the active window → SUPPRESSED: only speech_start/speech_end.
        _reset_fake_dg_session(finalize_text="Good evening, Annie Rudd. Here is")
        frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=2)
        assert [f["type"] for f in frames] == ["speech_start", "speech_end"], frames

        # (b) Dissimilar (genuine interruption) final during the SAME window
        # → PASSES. Barge-in must stay reachable through the gate.
        _reset_fake_dg_session(
            finalize_text="Remind me to call the dentist tomorrow afternoon."
        )
        frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=3)
        assert [f["type"] for f in frames] == ["speech_start", "speech_end", "final"], frames
        assert frames[2]["text"] == "Remind me to call the dentist tomorrow afternoon."

        # (c) LIVE-evidence hallucination "Thea, Annie Rhodes." — too
        # dissimilar for the char tier (measured 0.44) but all-hallucinated
        # word confidences trip the tier-3 word-confidence gate.
        _reset_fake_dg_session(
            finalize_text="Thea, Annie Rhodes.",
            finalize_word_confs=[0.70, 0.74, 0.83],
        )
        frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=2)
        assert [f["type"] for f in frames] == ["speech_start", "speech_end"], frames

        # (d) Window expiry: end the request, advance past playback estimate
        # (first_audio 1000 + 10 s audio) + decay 3 s → the SAME echo text
        # now passes unaffected (the gate never gates outside playback).
        gate.register_end("tts-echo-1")
        fake_now[0] = 1015.0
        _reset_fake_dg_session(finalize_text="Good evening, Annie Rudd. Here is")
        frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=3)
        assert [f["type"] for f in frames] == ["speech_start", "speech_end", "final"], frames
        assert frames[2]["text"] == "Good evening, Annie Rudd. Here is"

        # (e) faster-whisper fallback path (no key) is gated by the same
        # chokepoint: faithful echo text during a fresh active window.
        gate.register_start("tts-echo-2", _REPLY_TEXT)
        voice_server.DEEPGRAM_API_KEY = None
        voice_server.stt_mgr = _StubSttMgr(
            _WorkingWhisper("your calendar is clear this afternoon")
        )
        frames = _drive_ws(client, [_full_segment_bytes()], expected_frame_count=2)
        assert [f["type"] for f in frames] == ["speech_start", "speech_end"], frames
    finally:
        voice_server.echo_gate = orig_gate


# ---------------------------------------------------------------------------
# Case 9: echo gate, pure decision table — samples collected live (round-2
# checkpoint) and on the isolated 8091 sidecar. Genuine interruptions MUST
# pass even during an active window; echo/hallucinations MUST suppress.
# ---------------------------------------------------------------------------


def test_case9_echo_gate_decisions() -> None:
    from echo_gate import EchoGate

    fake_now = [0.0]
    gate = EchoGate(
        enabled=True,
        sim_threshold=0.72,
        conf_threshold=0.85,
        decay_s=3.0,
        clock=lambda: fake_now[0],
    )

    # No window at all: nothing is ever suppressed, similarity be damned.
    assert gate.check(_REPLY_TEXT) is None

    gate.register_start("t1", _REPLY_TEXT)
    gate.note_audio_bytes("t1", 480000)  # 10 s

    suppress = [
        # (transcript, mean_word_conf) — echo / hallucinated echo
        ("Good evening, Annie Rudd. Here is", 0.90),   # 8091 repro (char tier)
        ("Evening, Anna Rudd.", 0.52),                 # 8091 repro (char tier)
        ("Here is what", 0.99),                        # 8091 repro (token tier)
        ("Thea, Annie Rhodes.", 0.76),                 # LIVE (lowconf tier)
        ("Thea Alec.", 0.80),                        # LIVE (lowconf tier)
        ("Your calendar is clear this afternoon", None),   # faithful echo
        ("Would you like me to go through them now?", None),
        ("two reminders pending", None),
    ]
    passes = [
        # Genuine interruptions — including token-overlapping ones. Clean
        # word confidences (0.98-1.0 measured) keep tier 3 quiet.
        ("Stop.", None),
        ("Stop talking.", 0.99),
        ("Jarvis, stop.", 0.99),
        ("Wait, hold on.", 0.99),
        ("Wait wait wait.", 0.99),        # ratio("wait","what")=0.75 < 0.78 pin
        ("Pause.", 0.99),
        ("What time is it?", 0.99),
        ("No, not the calendar. Check my email instead.", 0.99),
        ("Remind me to call the dentist tomorrow afternoon about the appointment.", 0.99),
        ("Skip that. What else is pending?", 0.99),
    ]
    for text, conf in suppress:
        reason = gate.check(text, conf)
        assert reason is not None, f"echo NOT suppressed: {text!r}"
    for text, conf in passes:
        reason = gate.check(text, conf)
        assert reason is None, f"genuine interruption suppressed ({reason}): {text!r}"

    # conf_threshold=0 disables tier 3: the extreme hallucination then passes
    # (documented residual risk — tiers 1/2 still cover the rest).
    gate_no_conf = EchoGate(
        enabled=True, sim_threshold=0.72, conf_threshold=0.0, decay_s=3.0,
        clock=lambda: fake_now[0],
    )
    gate_no_conf.register_start("t1", _REPLY_TEXT)
    assert gate_no_conf.check("Thea, Annie Rhodes.", 0.5) is None
    assert gate_no_conf.check("Good evening, Annie Rudd. Here is", 0.9) is not None

    # enabled=False is a full bypass.
    gate_off = EchoGate(enabled=False, clock=lambda: fake_now[0])
    gate_off.register_start("t1", _REPLY_TEXT)
    assert gate_off.check("Your calendar is clear this afternoon", 0.5) is None


def main() -> None:
    orig_stt_mgr = voice_server.stt_mgr
    orig_key = voice_server.DEEPGRAM_API_KEY
    orig_enabled = voice_server.DEEPGRAM_STT_ENABLED
    try:
        with TestClient(voice_server.app) as client:
            test_case1_deepgram_happy_path(client)
            test_case2_no_key(client)
            test_case3_connect_failure(client)
            test_case4_mid_session_death(client)
            test_case5_key_hygiene(client)
            test_case8_echo_gate_wire(client)
            test_case6_frame_shape_pin()  # pin runs LAST: covers case-8 frames too
        test_case7_real_session_sequencing()
        test_case9_echo_gate_decisions()
    finally:
        voice_server.stt_mgr = orig_stt_mgr
        voice_server.DEEPGRAM_API_KEY = orig_key
        voice_server.DEEPGRAM_STT_ENABLED = orig_enabled
    print("STT_STREAM_SELFTEST_OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"SELFTEST FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
