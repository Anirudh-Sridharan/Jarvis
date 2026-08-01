"""Network-free selftest for ``deepgram_stt.py``'s pure translation helpers.

No test framework is used here (Python has none installed in this sidecar) —
plain asserts, following ``wakeword.py``'s standalone-script precedent
(``if __name__ == "__main__":`` block). Run directly:

    ./.venv/bin/python selftest.py

Every assertion below runs with zero network calls and (deliberately) no
Deepgram API key — ``env -u DEEPGRAM_API_KEY ./.venv/bin/python selftest.py``
must still pass, proving the tested core (``build_listen_url``,
``parse_results``, ``SegmentAccumulator``) never touches ``os.environ`` or
the network.

Prints ``SIDECAR_SELFTEST_OK`` and exits 0 on success; prints a failure
message to stderr and exits non-zero otherwise.
"""

from __future__ import annotations

import sys
from typing import Any
from urllib.parse import parse_qs, urlparse

from deepgram_stt import (
    DgResult,
    SegmentAccumulator,
    build_listen_url,
    parse_results,
)


def test_build_listen_url() -> None:
    url = build_listen_url()
    assert url.startswith("wss://"), f"expected a wss:// URL, got: {url}"
    assert "model=nova-3" in url, url
    assert "sample_rate=16000" in url, url
    assert "interim_results=true" in url, url

    # No credential-shaped query parameter NAME anywhere — auth is
    # header-only (Security Domain: a key in a query string ends up in
    # logs and error strings).
    params = parse_qs(urlparse(url).query)
    for name in params:
        lower = name.lower()
        assert "token" not in lower, f"query param name leaks 'token': {name}"
        assert "key" not in lower, f"query param name leaks 'key': {name}"
        assert "api" not in lower, f"query param name leaks 'api': {name}"


def test_parse_results_metadata_and_empty_alternatives() -> None:
    # Non-Results message type -> None.
    assert parse_results({"type": "Metadata", "request_id": "abc"}) is None

    # Results message with an empty alternatives list -> None.
    assert (
        parse_results(
            {
                "type": "Results",
                "is_final": False,
                "channel": {"alternatives": []},
            }
        )
        is None
    )


def test_parse_results_well_formed_interim_and_final() -> None:
    interim_msg = {
        "type": "Results",
        "is_final": False,
        "speech_final": False,
        "from_finalize": False,
        "channel": {"alternatives": [{"transcript": "hello wor", "confidence": 0.7}]},
    }
    result = parse_results(interim_msg)
    assert result == DgResult(
        transcript="hello wor",
        confidence=0.7,
        is_final=False,
        speech_final=False,
        from_finalize=False,
    ), result

    final_msg = {
        "type": "Results",
        "is_final": True,
        "speech_final": True,
        "from_finalize": True,
        "channel": {"alternatives": [{"transcript": "hello world", "confidence": 0.95}]},
    }
    result = parse_results(final_msg)
    assert result == DgResult(
        transcript="hello world",
        confidence=0.95,
        is_final=True,
        speech_final=True,
        from_finalize=True,
    ), result


def test_parse_results_missing_channel_does_not_raise() -> None:
    # No "channel" key at all -- must return None, never raise.
    assert parse_results({"type": "Results"}) is None


def test_segment_accumulator_partial_dedup() -> None:
    acc = SegmentAccumulator()
    r1 = DgResult(transcript="hello", confidence=0.5, is_final=False, speech_final=False, from_finalize=False)
    r2 = DgResult(transcript="hello", confidence=0.5, is_final=False, speech_final=False, from_finalize=False)
    r3 = DgResult(transcript="hello there", confidence=0.6, is_final=False, speech_final=False, from_finalize=False)

    frame1 = acc.feed(r1)
    frame2 = acc.feed(r2)  # identical composed text -> no new frame
    frame3 = acc.feed(r3)

    assert frame1 is not None, "expected a partial frame for the first interim"
    assert set(frame1.keys()) == {"type", "text", "stability"}, frame1
    assert frame1["type"] == "partial"
    assert frame1["text"] == "hello"

    assert frame2 is None, "duplicate interim text must not re-emit a partial"

    assert frame3 is not None, "expected a partial frame for the changed interim"
    assert set(frame3.keys()) == {"type", "text", "stability"}, frame3
    assert frame3["text"] == "hello there"


def test_segment_accumulator_take_final() -> None:
    acc = SegmentAccumulator()
    r1 = DgResult(transcript="hello", confidence=0.8, is_final=True, speech_final=False, from_finalize=False)
    r2 = DgResult(transcript="world", confidence=0.6, is_final=True, speech_final=True, from_finalize=True)

    assert acc.feed(r1) is None, "is_final results must never be forwarded as partials"
    assert acc.feed(r2) is None

    frame = acc.take_final()
    assert frame is not None
    assert set(frame.keys()) == {"type", "text", "confidence"}, frame
    assert frame["type"] == "final"
    assert frame["text"] == "hello world"
    assert frame["confidence"] == round((0.8 + 0.6) / 2, 4), frame


def test_segment_accumulator_take_final_empty() -> None:
    acc = SegmentAccumulator()
    assert acc.take_final() is None, "take_final on an empty accumulator must return None"


# ---------------------------------------------------------------------------
# Plan 13.2-03: VAD-only mode + engine-selection helpers (stt.py / voice_server.py)
# Also network-free, model-free — driven with stub VAD/whisper objects.
# ---------------------------------------------------------------------------


class _FakeVadResult:
    """Mimics the ``.item()`` surface of a torch scalar tensor."""

    def __init__(self, value: float) -> None:
        self._value = value

    def item(self) -> float:
        return self._value


def _stub_vad(frame_tensor: Any, _sample_rate: int) -> _FakeVadResult:
    """Speech frames carry nonzero amplitude; silence frames are all-zero."""
    import torch  # type: ignore[import]

    is_speech = bool(torch.any(frame_tensor != 0))
    return _FakeVadResult(0.9 if is_speech else 0.0)


class _NeverCalledWhisper:
    """A whisper stub whose ``transcribe`` attribute must never be touched."""

    @property
    def transcribe(self) -> Any:
        raise AssertionError(
            "whisper_model.transcribe must never be accessed when transcribe=False"
        )


class _FakeSegment:
    def __init__(self, text: str, avg_logprob: float) -> None:
        self.text = text
        self.avg_logprob = avg_logprob


class _WorkingWhisper:
    def transcribe(self, _audio: Any, **_kwargs: Any) -> tuple:
        return [_FakeSegment("hello world", -0.1)], None


def test_vad_only_mode_skips_whisper_and_final() -> None:
    import numpy as np  # type: ignore[import]

    from stt import AudioBuffer, FRAME_SAMPLES, MIN_SPEECH_FRAMES, SILENCE_HANGOVER, run_vad_and_transcribe

    speech_frame = np.full(FRAME_SAMPLES, 1000, dtype=np.int16).tobytes()
    silence_frame = np.zeros(FRAME_SAMPLES, dtype=np.int16).tobytes()

    buf = AudioBuffer()
    buf.extend(speech_frame * (MIN_SPEECH_FRAMES + 1))
    buf.extend(silence_frame * (SILENCE_HANGOVER + 2))

    events = run_vad_and_transcribe(
        buf, _stub_vad, _NeverCalledWhisper(), transcribe=False
    )

    types = [e["type"] for e in events]
    assert "speech_start" in types, events
    assert "speech_end" in types, events
    assert "final" not in types, events
    end_event = next(e for e in events if e["type"] == "speech_end")
    assert isinstance(end_event.get("silence_ms"), int), end_event


def test_transcribe_true_default_still_produces_final() -> None:
    import numpy as np  # type: ignore[import]

    from stt import AudioBuffer, FRAME_SAMPLES, MIN_SPEECH_FRAMES, SILENCE_HANGOVER, run_vad_and_transcribe

    speech_frame = np.full(FRAME_SAMPLES, 1000, dtype=np.int16).tobytes()
    silence_frame = np.zeros(FRAME_SAMPLES, dtype=np.int16).tobytes()

    buf = AudioBuffer()
    buf.extend(speech_frame * (MIN_SPEECH_FRAMES + 1))
    buf.extend(silence_frame * (SILENCE_HANGOVER + 2))

    # transcribe defaults to True — regression: every existing call site
    # (which never passes the new kwarg) must keep producing a final.
    events = run_vad_and_transcribe(buf, _stub_vad, _WorkingWhisper())

    final = next((e for e in events if e["type"] == "final"), None)
    assert final is not None, events
    assert set(final.keys()) == {"type", "text", "confidence"}, final
    assert final["text"] == "hello world", final


def test_configured_stt_engine_combinations() -> None:
    import voice_server as vs

    orig_key = vs.DEEPGRAM_API_KEY
    orig_enabled = vs.DEEPGRAM_STT_ENABLED
    try:
        vs.DEEPGRAM_API_KEY = "dgtestkey"
        vs.DEEPGRAM_STT_ENABLED = "1"
        assert vs._configured_stt_engine() == "deepgram"
        assert vs._configured_stt_reason() is None

        vs.DEEPGRAM_API_KEY = None
        vs.DEEPGRAM_STT_ENABLED = "1"
        assert vs._configured_stt_engine() == "faster-whisper"
        assert vs._configured_stt_reason() == "DEEPGRAM_API_KEY not set"

        vs.DEEPGRAM_API_KEY = "dgtestkey"
        vs.DEEPGRAM_STT_ENABLED = "0"
        assert vs._configured_stt_engine() == "faster-whisper"
        assert vs._configured_stt_reason() == "DEEPGRAM_STT_ENABLED=0"

        vs.DEEPGRAM_API_KEY = None
        vs.DEEPGRAM_STT_ENABLED = "0"
        assert vs._configured_stt_engine() == "faster-whisper"
        assert vs._configured_stt_reason() == "DEEPGRAM_API_KEY not set"
    finally:
        vs.DEEPGRAM_API_KEY = orig_key
        vs.DEEPGRAM_STT_ENABLED = orig_enabled


def main() -> None:
    test_build_listen_url()
    test_parse_results_metadata_and_empty_alternatives()
    test_parse_results_well_formed_interim_and_final()
    test_parse_results_missing_channel_does_not_raise()
    test_segment_accumulator_partial_dedup()
    test_segment_accumulator_take_final()
    test_segment_accumulator_take_final_empty()
    test_vad_only_mode_skips_whisper_and_final()
    test_transcribe_true_default_still_produces_final()
    test_configured_stt_engine_combinations()
    print("SIDECAR_SELFTEST_OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"SELFTEST FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
