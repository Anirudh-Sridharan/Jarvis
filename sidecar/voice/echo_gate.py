"""Sidecar-side echo gate for the ``/stt/stream`` <-> ``/tts`` boundary.

Round-2 live defect (.planning/debug/deepgram-stt-live-defects.md): the live
mic has no acoustic echo cancellation, so during a reply the speaker audio
reaches the mic. The TS orchestrator's confirmed-barge-in filter
(services/voice/src/echoFilter.ts) drops a final only when its tokens are
CONTAINED in the reply text — which assumes the STT transcribes echo
faithfully. True for whisper; structurally false for Deepgram Nova-3 on
far-field echo fragments, which re-hears degraded audio as phonetically
similar but orthographically different words (live: a reply containing
"Alex" produced finals "Thea, Annie Rhodes." and "Thea Alec.";
reproduced on an isolated sidecar: "Good evening, Annie Rudd. Here is" at
confidence 0.98). Those tokens are not in the reply -> not contained ->
treated as a genuine interruption -> every reply self-cancels.

The sidecar uniquely sees BOTH streams: every ``/tts`` request body (the
exact text being spoken, with timing) and every STT frame. This module
tracks active/recent TTS synthesis windows and fuzzy-matches candidate
partial/final transcripts against the recently synthesized text. A match
during an active window is suppressed (the frame is dropped before the
WebSocket — invisible to the TS client, an additive-only change to the
contract: no frame shape changes, no new frame types).

Decision tiers (empirically tuned on live evidence + isolated-sidecar
reproductions; see the debug session file for the sample tables):

1. ``token`` — >= 75% of candidate tokens fuzzy-match a synthesized token
   (per-token difflib ratio >= 0.78). Catches faithful echo ("Your calendar
   is clear this afternoon") and near-faithful hallucinations ("Alec" for
   "Alex" at ratio 0.92). The per-token ratio is deliberately above
   0.75 = ratio("wait", "what") — a genuine "Wait wait wait." must pass.
2. ``char`` — windowed character-level similarity >= JARVIS_ECHO_SIM_THRESHOLD
   (default 0.72) for candidates of >= 8 normalized chars. Catches phonetic
   re-hearings ("Good evening, Annie Rudd. Here is" scores 0.89 against the
   reply; genuine interruptions measured <= 0.60, and the short ones that
   score higher by chance are excluded by the length floor).
3. ``lowconf`` — moderate similarity (>= 0.40) AND mean Deepgram word-level
   confidence <= JARVIS_ECHO_CONF_THRESHOLD (default 0.85). Catches the
   extreme hallucinations tier 2 misses (live "Thea, Annie Rhodes." scores
   only 0.44): hallucinated echo words measure 0.74-0.83 word confidence vs
   0.98-1.0 for clean genuine speech. The AGGREGATE result confidence is NOT
   usable (measured 0.98 on a hallucinated final) — only word-level is.

Tuning bias: a suppressed genuine interruption is recoverable (repeat after
the reply, or the next cleaner final passes); before this gate existed every
reply self-cancelled. Tier thresholds are env-tunable:

    JARVIS_ECHO_GATE            "0" disables the gate entirely (default on)
    JARVIS_ECHO_SIM_THRESHOLD   tier-2 char similarity (default 0.72)
    JARVIS_ECHO_CONF_THRESHOLD  tier-3 word-confidence ceiling (default
                                0.85; "0" disables tier 3)
    JARVIS_ECHO_DECAY_MS        how long after estimated playback end a
                                window still gates (default 3000)

Pure logic + an injected monotonic clock; no I/O, no os.environ (the env is
read once by voice_server.py, mirroring the DEEPGRAM_* config style).
"""

from __future__ import annotations

import difflib
import re
import time
from typing import Callable, Dict, List, Optional

# ---------------------------------------------------------------------------
# Module constants (thresholds that are NOT env-tunable are pinned here with
# the measurement that justifies them — see module docstring / debug session).
# ---------------------------------------------------------------------------

# Tier 1: fraction of candidate tokens that must fuzzy-match.
TOKEN_TIER_THRESHOLD = 0.75
# Per-token difflib ratio for a fuzzy token match. 0.78 sits above
# ratio("wait", "what") == 0.75 (genuine) and below ratio("alec",
# "alex") == 0.92 (echo hallucination of the user's name).
TOKEN_MATCH_RATIO = 0.78

# Tiers 2/3 only apply to candidates with at least this many normalized
# chars — tiny candidates ("Stop.", "Pause.") produce noisy char-window
# scores (measured up to 0.60 by chance) and must rely on tier 1 only.
MIN_CHARS_FOR_CHAR_TIER = 8

# Tier 3 requires at least this much char similarity before low word
# confidence may suppress — low confidence alone is NOT echo evidence (a
# user shouting over playback is also degraded).
LOWCONF_MIN_SIMILARITY = 0.40

# Echo can time-stretch: windows of the source are also tried at this factor
# of the candidate length.
WINDOW_WIDEN_FACTOR = 1.4

# Candidates are truncated to this many normalized chars before the window
# scan (echo finals are short; this bounds SequenceMatcher work).
MAX_CANDIDATE_CHARS = 400

# TTS PCM is 24 kHz mono s16le on both engines -> 48 000 bytes/second.
TTS_BYTES_PER_SECOND = 48000.0

# A registered synthesis whose HTTP generator never ran (client vanished
# before streaming) is dropped after this long.
STALE_ENTRY_S = 120.0

# At most this many concurrent/recent synthesis windows are tracked.
MAX_ENTRIES = 8


_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]")
_NON_ALNUM_NOSPACE_RE = re.compile(r"[^a-z0-9]")


def _tokens(text: str) -> List[str]:
    return [t for t in _NON_ALNUM_RE.sub(" ", text.lower()).split() if t]


def _chars(text: str) -> str:
    return _NON_ALNUM_NOSPACE_RE.sub("", text.lower())


def fuzzy_token_score(candidate: str, source: str) -> float:
    """Fraction of candidate tokens with a fuzzy match among source tokens."""
    cand = _tokens(candidate)
    if not cand:
        return 0.0
    src = _tokens(source)
    if not src:
        return 0.0
    matched = 0
    for tok in cand:
        best = 0.0
        for stok in src:
            ratio = difflib.SequenceMatcher(None, tok, stok).ratio()
            if ratio > best:
                best = ratio
                if best >= 0.999:
                    break
        if best >= TOKEN_MATCH_RATIO:
            matched += 1
    return matched / len(cand)


def char_window_score(candidate: str, source: str) -> float:
    """Best difflib ratio of the candidate against sliding source windows.

    Both inputs are normalized to lowercase alphanumerics (no spaces) so
    punctuation/casing differences in the STT rendering don't dilute the
    score. Windows of the candidate's length (and WINDOW_WIDEN_FACTOR x it)
    slide over the source at a quarter-length stride.
    """
    cand = _chars(candidate)[:MAX_CANDIDATE_CHARS]
    src = _chars(source)
    if not cand or not src:
        return 0.0
    width = len(cand)
    if width >= len(src):
        return difflib.SequenceMatcher(None, cand, src).ratio()
    best = 0.0
    step = max(1, width // 4)
    for wlen in (width, int(width * WINDOW_WIDEN_FACTOR)):
        for i in range(0, max(1, len(src) - wlen + 1), step):
            ratio = difflib.SequenceMatcher(None, cand, src[i : i + wlen]).ratio()
            if ratio > best:
                best = ratio
    return best


class _TtsWindow:
    """Timing + text of one /tts synthesis request."""

    __slots__ = ("request_id", "text", "created", "first_audio", "audio_s", "ended")

    def __init__(self, request_id: str, text: str, created: float) -> None:
        self.request_id = request_id
        self.text = text
        self.created = created
        self.first_audio: Optional[float] = None
        self.audio_s: float = 0.0
        self.ended: Optional[float] = None

    def playback_end_estimate(self) -> float:
        """Estimated wall (monotonic) time the client finishes PLAYING this.

        Synthesis streams ~real-time and the client (ffplay) starts playing
        on the first chunk, so playback ends at roughly first-audio time plus
        the audio's own duration — or at stream end, whichever is later
        (covers faster-than-real-time synthesis bursts).
        """
        start = self.first_audio if self.first_audio is not None else self.created
        end_by_audio = start + self.audio_s
        end_by_stream = self.ended if self.ended is not None else end_by_audio
        return max(end_by_audio, end_by_stream)


class EchoGate:
    """Tracks TTS synthesis windows; classifies STT transcripts as echo.

    Single-event-loop use only (FastAPI): no locking. All timestamps come
    from the injected monotonic ``clock`` so tests are deterministic.
    """

    def __init__(
        self,
        *,
        enabled: bool = True,
        sim_threshold: float = 0.72,
        conf_threshold: float = 0.85,
        decay_s: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.enabled = enabled
        self.sim_threshold = sim_threshold
        self.conf_threshold = conf_threshold
        self.decay_s = decay_s
        self._clock = clock
        self._windows: Dict[str, _TtsWindow] = {}

    # -- /tts wiring --------------------------------------------------------

    def register_start(self, request_id: str, text: str) -> None:
        now = self._clock()
        self._evict(now)
        self._windows[request_id] = _TtsWindow(request_id, text or "", now)
        if len(self._windows) > MAX_ENTRIES:
            oldest = min(self._windows.values(), key=lambda w: w.created)
            del self._windows[oldest.request_id]

    def note_audio_bytes(self, request_id: str, n_bytes: int) -> None:
        window = self._windows.get(request_id)
        if window is None:
            return
        if window.first_audio is None:
            window.first_audio = self._clock()
        window.audio_s += n_bytes / TTS_BYTES_PER_SECOND

    def register_end(self, request_id: str) -> None:
        window = self._windows.get(request_id)
        if window is not None:
            window.ended = self._clock()

    def reset(self) -> None:
        self._windows.clear()

    # -- /stt/stream wiring -------------------------------------------------

    def check(
        self, transcript: str, mean_word_conf: Optional[float] = None
    ) -> Optional[str]:
        """Classify ``transcript``. Returns None (pass) or a reason (suppress).

        Only ever suppresses while at least one synthesis window is active
        (streaming, or within ``decay_s`` of its estimated playback end) —
        outside playback the gate is a no-op regardless of similarity.
        """
        if not self.enabled:
            return None
        now = self._clock()
        self._evict(now)
        source = " ".join(
            w.text
            for w in sorted(self._windows.values(), key=lambda w: w.created)
            if self._is_active(w, now) and w.text
        )
        if not source:
            return None

        token_score = fuzzy_token_score(transcript, source)
        if token_score >= TOKEN_TIER_THRESHOLD:
            return f"token ft={token_score:.2f}"

        if len(_chars(transcript)) >= MIN_CHARS_FOR_CHAR_TIER:
            char_score = char_window_score(transcript, source)
            if char_score >= self.sim_threshold:
                return f"char cw={char_score:.2f}"
            if (
                mean_word_conf is not None
                and self.conf_threshold > 0
                and char_score >= LOWCONF_MIN_SIMILARITY
                and mean_word_conf <= self.conf_threshold
            ):
                return f"lowconf cw={char_score:.2f} conf={mean_word_conf:.2f}"
        return None

    # -- internals ----------------------------------------------------------

    def _is_active(self, window: _TtsWindow, now: float) -> bool:
        if window.ended is None:
            # Still synthesizing/streaming (or generator never ran; the
            # stale eviction below bounds that case).
            return True
        return now <= window.playback_end_estimate() + self.decay_s

    def _evict(self, now: float) -> None:
        dead = [
            rid
            for rid, w in self._windows.items()
            if (w.ended is not None and now > w.playback_end_estimate() + self.decay_s)
            or (w.ended is None and now - w.created > STALE_ENTRY_S)
        ]
        for rid in dead:
            del self._windows[rid]
