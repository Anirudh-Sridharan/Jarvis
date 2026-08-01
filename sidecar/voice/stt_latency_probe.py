"""stt_latency_probe.py — objective speech_end→final STT latency measurement.

Overview
--------
A standalone CLI that measures the sidecar's ``speech_end``→``final``
transcript latency by streaming fixture audio through the REAL WS
``/stt/stream`` contract at real-time pace — no human speaking, no mic.

A human cannot produce two byte-identical utterances to compare two STT
engines fairly. This probe removes the human from that half of the SC3
comparison: the same fixture PCM is cached once per run and replayed,
unchanged, at 20 ms/chunk real-time pacing, for every repetition.

NOTE: the fixture is *synthetic* speech — either supplied via ``--wav`` or
synthesized through the sidecar's own ``/tts`` endpoint. This measures
LATENCY, not word-error-rate.

Metric
------
``speech_end_to_final_ms = t(final) - t(speech_end)`` — wall-clock time
(``time.perf_counter()``) between the sidecar's ``speech_end`` WS frame and
the next ``final`` WS frame for the same segment.

Usage::

    ./.venv/bin/python stt_latency_probe.py [--sidecar URL] [--n N]
        [--wav PATH] [--text "..."] [--label NAME] [--out results.json]
    ./.venv/bin/python stt_latency_probe.py --self-check

IMPORTANT: requires Python >= 3.11. Do NOT run with the system python3 3.9.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import json
import logging
import statistics
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Iterator, List, Optional

log = logging.getLogger("stt_latency_probe")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_SIDECAR_URL = "http://127.0.0.1:8089"
DEFAULT_TEXT = "Remind me to call the dentist tomorrow afternoon about the appointment."

# The WS /stt/stream contract expects PCM-16 LE mono 16 kHz (sidecarStt.ts's
# ffmpeg mic format: -ar 16000 -ac 1 -f s16le).
SEND_SAMPLE_RATE = 16000

# 320 samples = 20 ms at 16 kHz — the sidecar's documented recommended chunk size.
CHUNK_BYTES = 640

# Trailing digital silence appended after the fixture so Silero's VAD hangover
# (stt.SILENCE_HANGOVER * stt.FRAME_SAMPLES = 15 * 512 = 7680 samples = 480 ms)
# fires speech_end. 1500 ms gives a wide margin over that 480 ms threshold.
TRAILING_SILENCE_MS = 1500

# Per-repetition hard cap so a broken engine can't hang the whole run.
HARD_CAP_S = 10.0

# Pause between repetitions so the sidecar's VAD state is clean.
INTER_REP_PAUSE_S = 0.5

# WS connect timeout — this is a short-lived per-repetition session, not a
# long-lived reconnecting client.
CONNECT_TIMEOUT_S = 3.0

# Echo-gate settle (WR-01): synthesizing the fixture via the sidecar's own
# /tts registers the fixture TEXT as an active echo-gate synthesis window on
# that same sidecar (echo_gate.py — active until estimated playback end +
# decay). Rep 0 then streams near-identical audio and waits for a final whose
# text fuzzy-matches that window at ~1.0 — the gate would drop it before the
# WebSocket and rep 0 would falsely report "no final frame received". The
# probe therefore waits out the window before the first repetition.
ECHO_GATE_DECAY_S = 3.0        # echo_gate.py's JARVIS_ECHO_DECAY_MS default
ECHO_GATE_SETTLE_MARGIN_S = 1.0  # margin over the playback-end estimate


# ---------------------------------------------------------------------------
# Pure helpers (asserted by --self-check with no network, no key, no sidecar)
# ---------------------------------------------------------------------------


def ws_url_for(sidecar_url: str) -> str:
    """Convert an http(s) sidecar base URL into its ws(s) /stt/stream URL."""
    ws_base = sidecar_url.replace("https://", "wss://").replace("http://", "ws://")
    return ws_base.rstrip("/") + "/stt/stream"


def chunk_pcm(pcm: bytes, chunk_bytes: int) -> Iterator[bytes]:
    """Yield consecutive ``chunk_bytes``-sized slices of ``pcm`` (last may be shorter)."""
    for i in range(0, len(pcm), chunk_bytes):
        yield pcm[i : i + chunk_bytes]


def silence_pcm(ms: int, sample_rate: int) -> bytes:
    """Return ``ms`` milliseconds of zero-filled PCM-16 LE mono silence at ``sample_rate``."""
    n_samples = int(sample_rate * ms / 1000)
    return b"\x00" * (n_samples * 2)  # 2 bytes per int16 sample


def strip_wav_header(data: bytes) -> bytes:
    """Strip a canonical 44-byte WAV header if ``data`` starts with the RIFF magic."""
    if data[:4] == b"RIFF":
        return data[44:]
    return data


def gate_settle_seconds(fixture_ms: float) -> float:
    """Seconds to wait after a /tts-synthesized fixture before streaming rep 0.

    The sidecar's echo gate keeps the fixture's synthesis window active until
    roughly its estimated playback end (~the fixture's own duration past first
    audio) plus the decay; waiting audio duration + decay + margin guarantees
    the window has expired before the first measured repetition.
    """
    return fixture_ms / 1000.0 + ECHO_GATE_DECAY_S + ECHO_GATE_SETTLE_MARGIN_S


def summarize(samples: List[float]) -> Dict[str, float]:
    """Return {min, median, mean, max} for a non-empty list of floats."""
    return {
        "min": min(samples),
        "median": statistics.median(samples),
        "mean": statistics.mean(samples),
        "max": max(samples),
    }


# ---------------------------------------------------------------------------
# Fixture acquisition
# ---------------------------------------------------------------------------


def load_fixture_from_wav(path: str) -> bytes:
    """Load a fixture from ``path`` — a 44-byte-header WAV or headerless raw PCM.

    Requires 16 kHz mono PCM16 when a WAV header is present; raises a clear
    ``ValueError`` otherwise. Headerless raw files are trusted as-is (there is
    no header to validate against).
    """
    with open(path, "rb") as f:
        data = f.read()

    if data[:4] == b"RIFF":
        channels = struct.unpack_from("<H", data, 22)[0]
        sample_rate = struct.unpack_from("<I", data, 24)[0]
        bits_per_sample = struct.unpack_from("<H", data, 34)[0]
        if channels != 1 or sample_rate != SEND_SAMPLE_RATE or bits_per_sample != 16:
            raise ValueError(
                f"{path}: expected 16 kHz mono PCM16 WAV, got "
                f"{sample_rate} Hz, {channels}ch, {bits_per_sample}-bit"
            )
        return strip_wav_header(data)

    log.info("%s has no RIFF header — treating as headerless raw 16 kHz mono PCM16.", path)
    return data


def synthesize_fixture_via_tts(sidecar_url: str, text: str) -> bytes:
    """POST {text, speed: 1.0} to the sidecar's /tts (24 kHz PCM16) and resample to 16 kHz."""
    body = json.dumps({"text": text, "speed": 1.0}).encode("utf-8")
    req = urllib.request.Request(
        sidecar_url.rstrip("/") + "/tts",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        pcm_24k = resp.read()
    return _resample_24k_to_16k(pcm_24k)


def _resample_24k_to_16k(pcm_24k: bytes) -> bytes:
    """Resample raw PCM16 LE mono 24 kHz to 16 kHz mono s16le via ffmpeg."""
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            "24000",
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-f",
            "s16le",
            "-ar",
            "16000",
            "-ac",
            "1",
            "pipe:1",
        ],
        input=pcm_24k,
        capture_output=True,
        check=True,
    )
    return proc.stdout


# ---------------------------------------------------------------------------
# Sidecar HTTP helpers
# ---------------------------------------------------------------------------


def fetch_engine_label(sidecar_url: str) -> str:
    """Read the active STT engine from GET /health.

    Reads ``stt_engine.active`` if present, else ``stt_engine.configured``,
    else the literal ``"unknown"``. Never raises — this file must also work
    against a pre-13.2-03 sidecar that has no ``stt_engine`` key at all, and
    an unreachable sidecar degrades to "unknown" rather than crashing (the
    subsequent WS connect attempt will surface the real error).
    """
    try:
        req = urllib.request.Request(sidecar_url.rstrip("/") + "/health", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            health = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not reach /health (%s) — engine label will be 'unknown'.", exc)
        return "unknown"

    stt_engine = health.get("stt_engine") if isinstance(health, dict) else None
    if not isinstance(stt_engine, dict):
        return "unknown"
    return stt_engine.get("active") or stt_engine.get("configured") or "unknown"


# ---------------------------------------------------------------------------
# Repetition runner
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class RepetitionResult:
    index: int
    ok: bool
    speech_end_to_final_ms: Optional[float]
    silence_ms: Optional[int]
    partials: int
    text: str


async def run_repetition(ws_url: str, fixture_pcm: bytes, rep_index: int) -> RepetitionResult:
    """Stream ``fixture_pcm`` + trailing silence over ``ws_url`` at real-time pace.

    Records the wall-clock gap between the sidecar's speech_end frame and the
    subsequent final frame. Returns ``ok=False`` if no final frame arrives
    within the hard cap.
    """
    from websockets.asyncio.client import connect  # type: ignore[import]

    full_audio = fixture_pcm + silence_pcm(TRAILING_SILENCE_MS, SEND_SAMPLE_RATE)

    state: Dict[str, Any] = {
        "t_speech_end": None,
        "t_final": None,
        "silence_ms": None,
        "partials": 0,
        "text": "",
        "confidence": None,
    }

    async def _sender(ws: Any) -> None:
        for chunk in chunk_pcm(full_audio, CHUNK_BYTES):
            await ws.send(chunk)
            await asyncio.sleep(0.02)  # pace at real time — 20 ms per chunk

    async def _receiver(ws: Any) -> None:
        async for message in ws:
            if not isinstance(message, str):
                continue
            try:
                evt = json.loads(message)
            except (TypeError, ValueError):
                continue
            evt_type = evt.get("type") if isinstance(evt, dict) else None
            if evt_type == "partial":
                state["partials"] += 1
            elif evt_type == "speech_end":
                state["t_speech_end"] = time.perf_counter()
                state["silence_ms"] = evt.get("silence_ms")
            elif evt_type == "final":
                if state["t_speech_end"] is not None and state["t_final"] is None:
                    state["t_final"] = time.perf_counter()
                state["text"] = evt.get("text", "")
                state["confidence"] = evt.get("confidence")
                return  # this segment is complete
            elif evt_type == "error":
                log.warning("Sidecar reported error mid-repetition: %s", evt.get("detail"))

    async with connect(ws_url, open_timeout=CONNECT_TIMEOUT_S) as ws:
        sender_task = asyncio.create_task(_sender(ws))
        try:
            await asyncio.wait_for(_receiver(ws), timeout=HARD_CAP_S)
        except asyncio.TimeoutError:
            log.warning("Repetition %d: hard cap (%.1fs) reached with no final frame.", rep_index, HARD_CAP_S)
        finally:
            sender_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sender_task

    if state["t_speech_end"] is None or state["t_final"] is None:
        return RepetitionResult(
            index=rep_index,
            ok=False,
            speech_end_to_final_ms=None,
            silence_ms=state["silence_ms"],
            partials=state["partials"],
            text=state["text"],
        )

    ms = (state["t_final"] - state["t_speech_end"]) * 1000.0
    return RepetitionResult(
        index=rep_index,
        ok=True,
        speech_end_to_final_ms=ms,
        silence_ms=state["silence_ms"],
        partials=state["partials"],
        text=state["text"],
    )


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------


async def main_async(args: argparse.Namespace) -> int:
    if args.wav:
        fixture_pcm = load_fixture_from_wav(args.wav)
        fixture_source = f"wav:{args.wav}"
    else:
        fixture_pcm = synthesize_fixture_via_tts(args.sidecar, args.text)
        fixture_source = f"tts:{args.text!r}"

    fixture_ms = len(fixture_pcm) / 2 / SEND_SAMPLE_RATE * 1000.0
    engine = fetch_engine_label(args.sidecar)
    ws_url = ws_url_for(args.sidecar)

    print("=" * 70)
    print("STT latency probe — speech_end -> final, real-time-paced fixture audio")
    print("NOTE: fixture is synthetic speech. This measures LATENCY, not WER.")
    print(f"engine:  {engine}")
    print(f"label:   {args.label or '(none)'}")
    print(f"fixture: {fixture_source}  ({fixture_ms:.0f} ms)")
    print(f"n:       {args.n}")
    print("=" * 70)

    if not args.wav:
        # WR-01: the /tts call above registered this exact text as an active
        # echo-gate synthesis window on the target sidecar. Wait the window
        # out (audio duration + decay + margin) so rep 0's final is not
        # suppressed as speaker echo.
        settle_s = gate_settle_seconds(fixture_ms)
        log.info(
            "Fixture came from /tts — waiting %.1fs for the sidecar echo gate "
            "window to expire before rep 0.",
            settle_s,
        )
        await asyncio.sleep(settle_s)

    results: List[RepetitionResult] = []
    for i in range(args.n):
        result = await run_repetition(ws_url, fixture_pcm, i)
        results.append(result)
        if result.ok:
            print(
                f"  rep {i}: speech_end_to_final_ms={result.speech_end_to_final_ms:.1f}  "
                f"silence_ms={result.silence_ms}  partials={result.partials}  text={result.text!r}"
            )
        else:
            print(f"  rep {i}: FAILED — no final frame received")
        if i < args.n - 1:
            await asyncio.sleep(INTER_REP_PAUSE_S)

    ok_results = [r for r in results if r.ok]
    failed_results = [r for r in results if not r.ok]

    if ok_results:
        ms_values = [r.speech_end_to_final_ms for r in ok_results if r.speech_end_to_final_ms is not None]
        agg = summarize(ms_values)
        silence_values = [r.silence_ms for r in ok_results if r.silence_ms is not None]
        mean_silence = statistics.mean(silence_values) if silence_values else None
        mean_partials = statistics.mean([r.partials for r in ok_results])

        print("-" * 70)
        print(
            f"speech_end_to_final_ms: min={agg['min']:.1f}  median={agg['median']:.1f}  "
            f"mean={agg['mean']:.1f}  max={agg['max']:.1f}"
        )
        if mean_silence is not None:
            print(f"mean silence_ms: {mean_silence:.1f}")
        print(f"mean partial frames: {mean_partials:.1f}")
    else:
        agg = {}
        mean_silence = None
        mean_partials = None
        print("-" * 70)
        print("No successful repetitions — no aggregate to report.")

    if failed_results:
        print(f"FAILED repetitions: {[r.index for r in failed_results]}", file=sys.stderr)

    if args.out:
        payload = {
            "engine": engine,
            "label": args.label,
            "n": args.n,
            "fixture_ms": fixture_ms,
            "fixture_source": fixture_source,
            "runs": [dataclasses.asdict(r) for r in results],
            "aggregate": {
                **agg,
                "mean_silence_ms": mean_silence,
                "mean_partials": mean_partials,
            },
        }
        with open(args.out, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"Wrote results to {args.out}")

    return 1 if failed_results else 0


def _self_check() -> int:
    """Assert every pure helper's contract with no network, no key, no sidecar."""
    assert ws_url_for("http://127.0.0.1:8089") == "ws://127.0.0.1:8089/stt/stream"

    s = silence_pcm(1500, 16000)
    assert len(s) == 1500 * 16 * 2 and set(s) == {0}

    c = list(chunk_pcm(b"\x01\x02" * 1000, 640))
    assert all(len(x) <= 640 for x in c) and b"".join(c) == b"\x01\x02" * 1000

    assert strip_wav_header(b"RIFF" + b"\x00" * 40 + b"DATA") == b"DATA"
    assert strip_wav_header(b"\x11\x22") == b"\x11\x22"

    q = summarize([10.0, 20.0, 30.0])
    assert q["min"] == 10 and q["max"] == 30 and q["median"] == 20 and abs(q["mean"] - 20) < 1e-9

    # WR-01 regression: a 4 s /tts fixture must settle 4 + 3 (decay) + 1
    # (margin) = 8 s before rep 0 so the sidecar echo gate cannot suppress
    # the probe's own final.
    assert abs(gate_settle_seconds(4000.0) - 8.0) < 1e-9
    assert gate_settle_seconds(0.0) == ECHO_GATE_DECAY_S + ECHO_GATE_SETTLE_MARGIN_S

    print("STT_LATENCY_PROBE_SELF_CHECK_OK")
    return 0


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="stt_latency_probe.py",
        description=(
            "Measure the sidecar's speech_end->final transcript latency over the real "
            "WS /stt/stream contract, driven by real-time-paced fixture audio. NOTE: the "
            "fixture is SYNTHETIC speech (from --wav, or synthesized via the sidecar's own "
            "/tts) — this measures latency, not word-error-rate."
        ),
    )
    parser.add_argument("--sidecar", default=DEFAULT_SIDECAR_URL, help="Sidecar base URL.")
    parser.add_argument("--n", type=int, default=5, help="Number of repetitions.")
    parser.add_argument(
        "--wav",
        default=None,
        help="Path to a 16 kHz mono PCM16 WAV (or headerless raw) fixture file. "
        "Default: synthesize via the sidecar's own /tts using --text.",
    )
    parser.add_argument("--text", default=DEFAULT_TEXT, help="Text to synthesize when --wav is not given.")
    parser.add_argument("--label", default=None, help="Free-text label recorded in --out JSON.")
    parser.add_argument("--out", default=None, help="Optional path to write results as JSON.")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Run pure-helper assertions and exit (no network, no key, no sidecar).",
    )
    return parser


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
    parser = build_arg_parser()
    args = parser.parse_args()

    if args.self_check:
        return _self_check()

    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
