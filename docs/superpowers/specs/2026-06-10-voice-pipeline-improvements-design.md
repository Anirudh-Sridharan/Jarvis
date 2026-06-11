# Voice Pipeline Improvements — Design

**Date:** 2026-06-10
**Feature specs:** `features/7-low-latency-voice-interface.md`, `features/8-wake-word-and-hands-free.md`

## Problems (as reported + diagnosed)

1. **Wake word too hard to trigger.** openWakeWord threshold defaults to 0.5 everywhere
   (`voice_server.py`, `wakeword.py`); no env override is set in `.env`/`start.sh`.
2. **Jarvis cuts out mid-reply.** The mic stays open during TTS playback and there is no
   acoustic echo cancellation (ffmpeg/avfoundation has none). Silero VAD hears Jarvis's own
   speaker audio, fires `speech_start`, and `BargeInPolicy` cancels TTS + the LLM stream after
   only a 150 ms debounce — self-barge-in. Secondary effect: the echo's Whisper transcript can
   arrive ~1 s after a reply finishes and be treated as a new user turn.
3. **High response latency.** End-of-turn silence is double-counted: the sidecar VAD waits
   640 ms (`SILENCE_HANGOVER` 20 × 32 ms), runs Whisper (~300 ms), then reports `silenceMs: 0`,
   so the orchestrator waits *another* 900 ms wall-clock. ≈1.8 s dead air before the LLM starts.
   Plus: per-sentence ffplay spawns (startup buffering + audible gaps), lazy model loads on the
   first turn, Whisper `beam_size=3`.
4. **Voice sounds robotic.** `bm_fable` is an officially C-grade Kokoro voice (minutes of
   training data); Kokoro has no A/B-grade British male voice. Per-sentence synthesis resets
   prosody and per-sentence player spawns add gaps. (`lang_code` correctly matches the voice —
   that known trap was checked and ruled out.)

## Decision (user-approved)

Stay on Kokoro (no engine swap): **voice blend + prosody fixes**. Engine upgrades
(NeuTTS-Air / Qwen3-TTS cloning) noted as future work, not in scope.

## Changes

### 1. Wake word sensitivity
- Default threshold 0.5 → **0.35** in `voice_server.py` (`WakeManager.enable`) and
  `wakeword.py` (ctor default + `__main__`). `WAKE_THRESHOLD` env still overrides.
- `run.sh` startup echo and `start.sh` header document the knob.

### 2. Echo-resistant ("confirmed") barge-in — `@jarvis/voice`
New orchestrator config `bargeInMode: "immediate" | "confirmed"`, **default `confirmed`**
(both live entry points share `VOICE_TURN_CONFIG`; `immediate` preserves today's behavior
for tests/opt-in).

Confirmed mode:
- `speech_start` during `thinking`/`speaking` does **not** cancel anything.
- A `final` transcript arriving during `thinking`/`speaking` is checked against the
  assistant's text for the current turn (normalized: lowercase, strip non-alphanumerics):
  - **Echo** (token-containment ratio ≥ 0.8 against recent assistant text) → dropped entirely.
  - **Real speech** → confirmed barge-in: cancel TTS + LLM via `BargeInPolicy` hooks,
    transition to listening, commit the final as the next turn's transcript, normal
    end-of-turn evaluation proceeds.
- **Trailing echo guard:** finals arriving within a ~5 s grace window after a reply finishes
  are echo-checked against the last assistant reply text and dropped if matching, so Jarvis
  never replies to himself.
- Trade-off accepted: intentional interruptions now take effect at end-of-utterance
  (~1 s later than today) — correctness over speed; false self-interruption is eliminated.

### 3. Latency
- `stt.py`: `SILENCE_HANGOVER` 20 → **15 frames (480 ms)**; `AudioBuffer` tracks the
  wall-clock time of the last voiced frame; the `speech_end` event gains an honest
  `silence_ms` (computed when the event batch is returned, so it includes Whisper time).
  Whisper `beam_size` 3 → **1**.
- `sidecarStt.ts`: pass `silence_ms` through (`silenceMs` was hardcoded 0).
- `buildVoiceDeps.ts`: `silenceThresholdMs` 900 → **800** (spec default). Net effect: turn
  ends ≈800 ms after the user stops speaking instead of ≈1.8 s.
- `sidecarTts.ts`: **one persistent ffplay player per turn** (spawned on first sentence,
  all sentences' PCM piped into the same stdin, ended after the loop) — removes
  inter-sentence gaps and respawn cost. Low-latency flags:
  `-probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay`.
- `voice_server.py`: new **`POST /warmup`** — ensures STT+TTS loaded, runs a tiny Whisper
  transcribe and a tiny Kokoro synth so the first real turn is warm. Wired in:
  `buildVoiceDeps` wraps core warmup to also fire sidecar warmup in parallel (sidecar
  failure does not fail the wake), and `start.sh` fires it once after health gates.

### 4. Voice naturalness (Kokoro, no engine change)
- **Voice blending** in the sidecar: `TTS_VOICE` accepts `"name:weight,name:weight"`.
  `voice_server.py` resolves blends to a weighted average of Kokoro voicepack tensors
  (KPipeline accepts a tensor as `voice=`). New default:
  **`bm_george:0.7,bf_emma:0.3`** — male timbre borrowing the only B-grade British voice's
  prosody. `JARVIS_TTS_VOICE` still overrides end-to-end (plain names keep working).
- **Speed 0.95** default (TS side, `JARVIS_TTS_SPEED` override).
- **Bigger chunks for prosody:** `minCharsPerChunk` 12 → **60**, `maxCharsPerChunk`
  200 → **240** in `VOICE_TURN_CONFIG`. First chunk still flushes at the first sentence
  terminator (fast first audio); later chunks merge short sentences (~2-sentence prosody).
- **Speech sanitation:** strip markdown (code fences/backticks, `*`/`_` emphasis, headings,
  list markers, links) from sentences before TTS in `sidecarTts.ts`.

## Testing
- `@jarvis/voice`: orchestrator tests for confirmed/immediate barge-in, echo-final dropping,
  trailing-echo guard, silenceMs passthrough effect on turn timing; chunker tests for new sizes.
- `@jarvis/core`: sidecarTts persistent-player + sanitize tests (fake playerFactory/fetch);
  sidecarStt translateFrame silence_ms test; buildVoiceDeps warmup composition test.
- Python sidecar: `py_compile` + a live blend-resolution synth check (assert non-empty PCM)
  against the existing `.venv`; no Python test harness exists (deliberate — TS is the tested layer).
- Live verification: run the stack, confirm wake fires at lower confidence, replies play to
  completion next to the open mic, and measure eos→first-audio.

## Out of scope / future
- NeuTTS-Air or Qwen3-TTS cloned British male voice (engine swap behind `TTS_ENGINE`).
- Real AEC capture path (macOS VoiceProcessingIO) enabling instant interruption again.
- Parakeet-TDT streaming STT (existing `TODO` path in `stt.py`).
