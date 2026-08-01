"""tts_ab_eval.py — Kokoro vs Aura-2 TTS A/B: TTFB table + listenable WAVs.

Overview
--------
A standalone CLI that renders a fixed, committed sentence set through the
running sidecar's ``/tts`` endpoint for three candidates — the incumbent
Kokoro default, and both British Deepgram Aura-2 voices — and reports
time-to-first-byte (TTFB) and real-time-factor (RTF) per render, plus
per-candidate mean TTFB. Every render is written to a playable WAV file so
the user can listen back-to-back.

This tool measures LATENCY only. It never listens to the audio itself and
never picks a favorite between voices — per D-05, the subjective keep/switch
decision between Kokoro and Aura-2 belongs to the user. This script presents
numbers and files; it never switches the default and never writes any
configuration.

Metrics
-------
``ttfb_ms``   — milliseconds from just-before-request to the first
                non-empty response body chunk.
``audio_ms``  — milliseconds of audio implied by the byte count at 24 kHz
                mono PCM16 (``audio_ms_for``).
``rtf``       — ``total_ms / audio_ms``, the real-time factor.

Usage::

    ./.venv/bin/python tts_ab_eval.py [--sidecar URL] [--out-dir DIR]
        [--speed 0.95] [--play] [--json results.json]
    ./.venv/bin/python tts_ab_eval.py --self-check

IMPORTANT: requires Python >= 3.11. Do NOT run with the system python3 3.9.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Tuple

log = logging.getLogger("tts_ab_eval")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_SIDECAR_URL = "http://127.0.0.1:8089"
DEFAULT_OUT_DIR = "~/.jarvis/tts-ab"
DEFAULT_SPEED = 0.95  # the live Kokoro default; applied to Kokoro requests only

MAX_ERROR_CHARS = 200
REQUEST_TIMEOUT_S = 30.0

# Candidate order is fixed so the incumbent is always heard first.
CANDIDATES: List[Tuple[str, Optional[str]]] = [
    ("kokoro", None),
    ("aura", "aura-2-draco-en"),
    ("aura", "aura-2-pandora-en"),
]

# Fixed sentence set — committed here, never randomised, so every run is
# comparable: one short conversational line, one with a number and a time,
# one longer multi-clause line.
SENTENCES: List[str] = [
    "Hey, what's on my calendar for this afternoon?",
    "Remind me at 3:15 to send the invoice for twelve hundred dollars.",
    "I read through yesterday's meeting notes, pulled out the three action "
    "items we agreed on, and the first one looks already done since the "
    "pull request merged this morning.",
]


# ---------------------------------------------------------------------------
# Pure helpers (asserted by --self-check with no network, no sidecar)
# ---------------------------------------------------------------------------


def build_tts_body(
    text: str, request_id: str, engine: str, voice: Optional[str], speed: float
) -> Dict[str, Any]:
    """Build the /tts POST body for one (engine, voice) candidate.

    ``voice`` is omitted entirely for the Kokoro default (so the sidecar's
    TTS_VOICE blend is exercised as-is). ``speed`` is sent only for Kokoro —
    Aura-2 runs at its natural rate (unverified for a speed parameter).
    """
    body: Dict[str, Any] = {"text": text, "request_id": request_id, "engine": engine}
    if voice is not None:
        body["voice"] = voice
    if engine == "kokoro":
        body["speed"] = speed
    return body


def audio_ms_for(n_bytes: int, sample_rate: int = 24000) -> float:
    """Milliseconds of audio implied by ``n_bytes`` of PCM-16 mono at ``sample_rate``."""
    samples = n_bytes / 2  # 2 bytes per int16 sample
    return samples / sample_rate * 1000.0


def wav_path_for(out_dir: str, engine: str, voice: Optional[str], index: int) -> str:
    """Return the output WAV path for one (engine, voice, sentence-index) render."""
    voice_label = voice if voice else "default"
    return os.path.join(out_dir, f"{engine}-{voice_label}-{index}.wav")


def render_table(rows: List[Dict[str, Any]]) -> str:
    """Render ``rows`` (engine/voice/i/ttfb_ms/audio_ms/rtf) as a markdown table."""
    headers = ["engine", "voice", "i", "ttfb_ms", "audio_ms", "rtf"]
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        cells: List[str] = []
        for h in headers:
            v = row.get(h, "")
            cells.append(f"{v:.1f}" if isinstance(v, float) else str(v))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Sidecar HTTP call
# ---------------------------------------------------------------------------


def request_tts_audio(sidecar_url: str, body: Dict[str, Any]) -> Tuple[int, bytes, float, float, str]:
    """POST ``body`` to /tts, streaming the response.

    Returns ``(status, pcm_bytes, ttfb_ms, total_ms, error_detail)``.
    ``status`` is 0 (not a real HTTP status) when the connection itself
    fails (e.g. sidecar not running); ``error_detail`` is truncated and
    never includes request/response headers or credentials.
    """
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        sidecar_url.rstrip("/") + "/tts",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            status = resp.status
            chunks: List[bytes] = []
            ttfb_ms: Optional[float] = None
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                if ttfb_ms is None:
                    ttfb_ms = (time.perf_counter() - t0) * 1000.0
                chunks.append(chunk)
            total_ms = (time.perf_counter() - t0) * 1000.0
            pcm = b"".join(chunks)
            return status, pcm, ttfb_ms if ttfb_ms is not None else total_ms, total_ms, ""
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        total_ms = (time.perf_counter() - t0) * 1000.0
        return exc.code, b"", 0.0, total_ms, _truncate(body_text)
    except Exception as exc:  # noqa: BLE001 — connection failure etc.
        total_ms = (time.perf_counter() - t0) * 1000.0
        return 0, b"", 0.0, total_ms, _truncate(str(exc))


def _truncate(text: str, limit: int = MAX_ERROR_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + "…"


# ---------------------------------------------------------------------------
# A/B run
# ---------------------------------------------------------------------------


def run_ab_eval(args: argparse.Namespace) -> int:
    out_dir = os.path.expanduser(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    from tts import pcm_to_wav_header  # reuse — do not hand-roll a WAV writer

    rows: List[Dict[str, Any]] = []
    written_files: Dict[str, List[str]] = {}
    any_ok = False

    for engine, voice in CANDIDATES:
        candidate_key = f"{engine}-{voice or 'default'}"
        written_files[candidate_key] = []

        for i, sentence in enumerate(SENTENCES):
            request_id = str(uuid.uuid4())
            body = build_tts_body(sentence, request_id, engine, voice, args.speed)
            status, pcm, ttfb_ms, total_ms, err = request_tts_audio(args.sidecar, body)

            if status != 200:
                rows.append(
                    {
                        "engine": engine,
                        "voice": voice or "default",
                        "i": i,
                        "ttfb_ms": f"ERROR {status}",
                        "audio_ms": f"ERROR {status}",
                        "rtf": f"ERROR {status}",
                        "error_detail": err,
                    }
                )
                log.warning("Candidate %s sentence %d failed: %s %s", candidate_key, i, status, err)
                continue

            any_ok = True
            audio_ms = audio_ms_for(len(pcm), 24000)
            rtf = (total_ms / audio_ms) if audio_ms > 0 else float("inf")

            wav_path = wav_path_for(out_dir, engine, voice, i)
            with open(wav_path, "wb") as f:
                f.write(pcm_to_wav_header(len(pcm), 24000))
                f.write(pcm)
            written_files[candidate_key].append(wav_path)

            rows.append(
                {
                    "engine": engine,
                    "voice": voice or "default",
                    "i": i,
                    "ttfb_ms": ttfb_ms,
                    "audio_ms": audio_ms,
                    "rtf": rtf,
                }
            )

    print(render_table(rows))

    print("\nPer-candidate mean TTFB:")
    mean_ttfb_by_candidate: Dict[str, Optional[float]] = {}
    for engine, voice in CANDIDATES:
        key = f"{engine}-{voice or 'default'}"
        candidate_ttfbs = [
            r["ttfb_ms"]
            for r in rows
            if r["engine"] == engine and r["voice"] == (voice or "default") and isinstance(r["ttfb_ms"], float)
        ]
        if candidate_ttfbs:
            mean_ttfb = statistics.mean(candidate_ttfbs)
            mean_ttfb_by_candidate[key] = mean_ttfb
            print(f"  {key}: {mean_ttfb:.1f} ms")
        else:
            mean_ttfb_by_candidate[key] = None
            print(f"  {key}: no successful renders")

    print("\nRendered files:")
    for key, files in written_files.items():
        if files:
            print(f"  {key}:")
            for f in files:
                print(f"    {os.path.abspath(f)}")
        else:
            print(f"  {key}: (none — all renders failed)")

    print("\n" + "=" * 70)
    print("Latency is measured above; audio QUALITY is not. Listening and")
    print("deciding between Kokoro and the two Aura-2 voices is entirely up")
    print("to you — this tool does not pick one. The current default stays")
    print("Kokoro (bm_george:0.7,bf_emma:0.3) until you decide otherwise.")
    print("=" * 70)

    if args.play:
        for key, files in written_files.items():
            for f in files:
                try:
                    subprocess.run(["afplay", f], check=False)
                except FileNotFoundError:
                    log.warning("afplay not found — cannot play %s", f)

    if args.json_out:
        payload = {
            "sidecar": args.sidecar,
            "speed": args.speed,
            "sentences": SENTENCES,
            "candidates": [{"engine": e, "voice": v or "default"} for e, v in CANDIDATES],
            "rows": rows,
            "mean_ttfb_ms": mean_ttfb_by_candidate,
        }
        with open(args.json_out, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"\nWrote results to {args.json_out}")

    return 0 if any_ok else 1


def _self_check() -> int:
    """Assert every pure helper's contract with no network, no sidecar."""
    b = build_tts_body("hi", "rid", "kokoro", None, 0.95)
    assert b["engine"] == "kokoro" and "voice" not in b and b["speed"] == 0.95
    assert b["text"] == "hi" and b["request_id"] == "rid"

    a = build_tts_body("hi", "rid", "aura", "aura-2-draco-en", 0.95)
    assert a["engine"] == "aura" and a["voice"] == "aura-2-draco-en" and "speed" not in a

    assert abs(audio_ms_for(48000) - 1000.0) < 1e-6

    assert wav_path_for("/tmp", "aura", "aura-2-draco-en", 1).endswith(".wav")

    assert len(SENTENCES) == 3 and all(isinstance(s, str) and s for s in SENTENCES)

    labels = [c[0] for c in CANDIDATES]
    assert labels == ["kokoro", "aura", "aura"]
    assert [c[1] for c in CANDIDATES][1:] == ["aura-2-draco-en", "aura-2-pandora-en"]

    t = render_table(
        [{"engine": "kokoro", "voice": "default", "i": 0, "ttfb_ms": 120.0, "audio_ms": 900.0, "rtf": 0.3}]
    )
    assert "ttfb_ms" in t and "kokoro" in t

    print("TTS_AB_EVAL_SELF_CHECK_OK")
    return 0


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tts_ab_eval.py",
        description=(
            "Render a fixed sentence set through the running sidecar's /tts for "
            "Kokoro (incumbent) and both British Aura-2 voices, print a TTFB/RTF "
            "table, and leave playable WAV files on disk. Measures latency only — "
            "the keep/switch decision between engines is yours to make by listening."
        ),
    )
    parser.add_argument("--sidecar", default=DEFAULT_SIDECAR_URL, help="Sidecar base URL.")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="Directory to write WAV files into.")
    parser.add_argument(
        "--speed",
        type=float,
        default=DEFAULT_SPEED,
        help="Kokoro playback speed (Kokoro requests only; Aura runs at its natural rate).",
    )
    parser.add_argument("--play", action="store_true", help="Play each rendered file back in order via afplay.")
    parser.add_argument("--json", dest="json_out", default=None, help="Optional path to write results as JSON.")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Run pure-helper assertions and exit (no network, no sidecar).",
    )
    return parser


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
    parser = build_arg_parser()
    args = parser.parse_args()

    if args.self_check:
        return _self_check()

    return run_ab_eval(args)


if __name__ == "__main__":
    sys.exit(main())
