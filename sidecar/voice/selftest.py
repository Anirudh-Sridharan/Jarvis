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


def main() -> None:
    test_build_listen_url()
    test_parse_results_metadata_and_empty_alternatives()
    test_parse_results_well_formed_interim_and_final()
    test_parse_results_missing_channel_does_not_raise()
    test_segment_accumulator_partial_dedup()
    test_segment_accumulator_take_final()
    test_segment_accumulator_take_final_empty()
    print("SIDECAR_SELFTEST_OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"SELFTEST FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
