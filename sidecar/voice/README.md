# Jarvis Voice Sidecar

Phase 3 audio model server for **Feature 7 — Low-Latency Voice Interface** and
**Feature 8 — Wake Word & Hands-Free**. A FastAPI service that exposes STT,
TTS, VAD, and wake word detection over HTTP/WebSocket so the TypeScript voice
orchestrator (`@jarvis/voice`) can drive all audio models without Python
knowledge.

---

## ⚠️  Python 3.11+ REQUIRED — the system `python3` is TOO OLD

> **The system `python3` on the target MacBook Air M3 (macOS) is version 3.9.6.
> This is NOT supported.** All packages in this sidecar (`faster-whisper`,
> `kokoro`, `openwakeword`, `silero-vad`) require **Python 3.11 or newer.**

**Install a suitable Python first:**

```bash
# Homebrew (recommended)
brew install python@3.12

# or with uv (fast, self-contained)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.12
```

`run.sh` probes for `python3.13 / python3.12 / python3.11` (newest first) and
**errors loudly** if none is found.

---

## ⚠️  Models must be downloaded before first use

> Models are **NOT bundled** in this repo.  They are downloaded on first use
> (or pre-downloaded for lower cold-start).  The downloads happen automatically
> when the relevant endpoint is first called, but this can take 1–5 minutes on
> a slow connection.
>
> **For production, pre-download all models before starting the sidecar.**

| Component | Model | Download method | Approx. size |
|-----------|-------|-----------------|-------------|
| STT | faster-whisper `small` (int8) | Auto on first `/stt/stream` call | ~150 MB |
| VAD | Silero VAD | Auto via `torch.hub` | ~5 MB |
| TTS | Kokoro (British blend `bm_george:0.7,bf_emma:0.3`) | Auto on first `/tts` call (or `POST /warmup`) | ~350 MB |
| Wake word | openWakeWord `hey_jarvis` | Auto on `POST /wake/enable` | ~5 MB |

Also install `portaudio` (needed by PyAudio for the wake word mic):

```bash
brew install portaudio
```

---

## Run

```bash
chmod +x run.sh      # first time only
./run.sh
```

`run.sh`:
1. Finds Python ≥ 3.11 (errors loudly if absent).
2. Creates `.venv` if missing, installs `requirements.txt`.
3. `exec uvicorn voice_server:app --host 127.0.0.1 --port ${VOICE_SIDECAR_PORT:-8089}`.

Binds to **127.0.0.1 only** (loopback; never exposed off-box).

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VOICE_SIDECAR_PORT` | `8089` | Listen port (loopback). |
| `VOICE_ORCHESTRATOR_URL` | `http://127.0.0.1:8080/voice/wake` | Where wake events are POSTed. |
| `STT_MODEL_SIZE` | `small` | faster-whisper model size (`tiny`, `base`, `small`, `medium`). |
| `TTS_VOICE` | `bm_george:0.7,bf_emma:0.3` | Kokoro voice ID or weighted blend `name:weight,...` (all voices must share the language). |
| `TTS_LANG` | `en-gb` | Kokoro language (`en-gb` British / `en-us` American — must match voice prefix). |
| `VAD_THRESHOLD` | `0.5` | Silero VAD speech probability threshold. |
| `WAKE_WORD_MODEL` | `hey_jarvis` | openWakeWord model name or file path. |
| `WAKE_THRESHOLD` | `0.35` | openWakeWord detection confidence threshold (lower = more sensitive). |
| `WAKE_DEBOUNCE_SECS` | `1.5` | Seconds to suppress duplicate wake fires. |
| `DEEPGRAM_API_KEY` | unset | Enables Deepgram streaming STT and Aura-2 TTS. Read from the repo-root `.env` by `load_env.sh` (see below) and never logged, printed, or returned by any endpoint. Unset = both engines stay on their local default. |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram streaming-STT model. |
| `DEEPGRAM_STT_ENABLED` | `1` | Set to `0` to force faster-whisper even with a key present, without removing the key. |
| `DEEPGRAM_CONNECT_TIMEOUT_MS` | `2000` | Deepgram STT WS connect timeout before falling back to faster-whisper. |
| `DEEPGRAM_FINALIZE_TIMEOUT_MS` | `600` | How long to wait for Deepgram's `Finalize` response before giving up on that segment's text. |
| `TTS_ENGINE` | `aura` | `aura` (Deepgram Aura-2 streaming TTS) is the default by explicit user decision in the phase 13.2 listening checkpoint (2026-08-01; measured mean TTFB: Aura ~542ms vs Kokoro ~2370ms). `kokoro` selects the local engine. Kokoro is always the automatic fallback when the key is absent or Aura fails. |
| `DEEPGRAM_TTS_MODEL` | `aura-2-draco-en` | Aura-2 voice model id (chosen 2026-08-01: `aura-2-draco-en`, the deeper baritone; used only when the Aura engine is selected). |
| `JARVIS_ECHO_GATE` | `1` | Sidecar-side echo gate: during an active/recent TTS synthesis window, STT partial/final frames whose text fuzzy-matches the synthesized text are dropped (no-AEC speaker echo — Nova-3 re-hears it as *different* words the TS echo filter can't catch). `0` disables. See `echo_gate.py`. |
| `JARVIS_ECHO_SIM_THRESHOLD` | `0.72` | Char-similarity tier threshold: windowed similarity ≥ this against recently synthesized text (candidates ≥ 8 chars) suppresses. Measured: hallucinated echo ≥ 0.80, genuine interruptions ≤ 0.60. |
| `JARVIS_ECHO_CONF_THRESHOLD` | `0.85` | Word-confidence tier: moderate similarity (≥ 0.40) **and** mean Deepgram word confidence ≤ this suppresses (hallucinated echo words measure 0.74–0.83; clean genuine speech 0.98–1.0). `0` disables this tier. |
| `JARVIS_ECHO_DECAY_MS` | `3000` | How long after estimated playback end a synthesis window still gates (covers ffplay buffering + Silero hangover + finalize latency). |

### STT engine design

Silero VAD always owns `speech_start`/`speech_end`/`silence_ms` — the segment
boundary never changes regardless of which engine transcribes the text.  When
`DEEPGRAM_API_KEY` is configured, Deepgram's streaming `/v1/listen` supplies
the transcript, finalized by a `Finalize` message sent on Silero's own
`speech_end` cue.  A missing key, a failed connect, or a mid-session socket
death all fall back to faster-whisper for the rest of that session — never an
`error` frame, never an abnormal close.  The active engine and the reason for
any fallback are always visible on `GET /health`'s `stt_engine` key.

### `load_env.sh` — allowlisted `.env` loading

`run.sh` sources `load_env.sh` before starting the sidecar, which loads *only*
`DEEPGRAM_*`/`TTS_ENGINE`/`JARVIS_ECHO_*` keys from the repo-root `.env` (an
explicit anchored allowlist — every other secret in `.env`, e.g.
`FIREWORKS_API_KEY`, is never read into this process).  A variable already set
in the shell environment is left untouched; values are never echoed or logged.
A malformed matching key (e.g. `DEEPGRAM_API KEY=…`) is skipped with a
key-only warning — it never aborts the `set -euo pipefail` launcher.

---

## Endpoint contract

The TypeScript `voiceClient` calls exactly these endpoints.

### `GET /health`

```json
{
  "state": "ready | degraded | error",
  "components": {
    "stt":  "unloaded | loading | ready | error",
    "tts":  "unloaded | loading | ready | error",
    "vad":  "unloaded | loading | ready | error",
    "wake": "unloaded | loading | ready | error | disabled"
  },
  "stt_engine": {
    "configured": "deepgram | faster-whisper",
    "active": "deepgram | faster-whisper | null",
    "reason": "<short, key-free degradation reason> | null"
  },
  "tts_engine": {
    "configured": "aura | kokoro",
    "active": "aura | kokoro | null",
    "reason": "<short, key-free degradation reason> | null"
  }
}
```

`stt_engine` and `tts_engine` are **additive top-level keys** — `components`
deliberately still holds only the four original component states, because the
overall `state` computation is derived from `components.values()` alone; an
engine name inside `components` would permanently pin `state` to `"degraded"`.

### `WS /stt/stream` — streaming STT

**Client → server:** binary WebSocket frames containing raw **PCM-16 LE mono
16 kHz** audio samples (any chunk size; 320 bytes / 20 ms recommended).

**Server → client:** text WebSocket frames containing JSON:

| Frame | Description |
|-------|-------------|
| `{"type":"speech_start"}` | Silero VAD rising edge (silence → speech). |
| `{"type":"partial","text":"…","stability":0.7}` | Interim hypothesis mid-speech. |
| `{"type":"speech_end","silence_ms":780}` | Silero VAD falling edge + hangover; `silence_ms` is the honest time since the last voiced frame (hangover + transcription), counted toward end-of-turn upstream. |
| `{"type":"final","text":"…","confidence":0.92}` | Final transcript from faster-whisper after the segment ends. |
| `{"type":"error","detail":"…"}` | Non-fatal error; stream continues. |

**Close the WebSocket** to cancel (barge-in: the TS orchestrator closes and
re-opens on `speech_start` during TTS playback).

**Engine note:** `faster-whisper small int8` is the default.  For sub-100 ms
streaming partials on Apple Silicon, use Parakeet-TDT/MLX (see `stt.py` →
`make_parakeet_transcriber`).

### `POST /tts` — streaming TTS

**Request body:**
```json
{
  "text": "The text to synthesize.",
  "request_id": "<optional uuid>",
  "voice": "bm_fable",
  "speed": 1.0,
  "engine": "kokoro | aura"
}
```

`engine` is optional and defaults to the `TTS_ENGINE` env value — the live
voice conversation client never sends it, so which engine actually serves a
turn is governed entirely by the sidecar's own environment. Aura-2 output is
`linear16` at 24 kHz — **identical** to Kokoro's format — so the response
headers and the client's playback pipeline never need to change based on
engine. An Aura failure (no key, failed connect, or a zero-byte stream)
falls back to Kokoro **within the same request**, so the caller always gets
audio, never a 4xx/5xx or silence.

`voice` is **engine-scoped**: on the Aura path only Aura-shaped ids
(`aura-…`, e.g. `aura-2-draco-en`) are honored — a Kokoro voice id or blend
spec (such as a set `JARVIS_TTS_VOICE`, which predates Aura and always means
"Kokoro voice") is never forwarded to Deepgram as a bogus Aura model; the
Aura voice stays `DEEPGRAM_TTS_MODEL`. A Kokoro-shaped `voice` applies only
when the request resolves to the kokoro engine.

**Response:** chunked binary stream of raw **PCM-16 LE mono 24 kHz** audio.

Headers:
```
Content-Type: audio/pcm; rate=24000; channels=1; bits=16
X-TTS-Request-Id: <uuid>
```

**Cancellation:** call `POST /tts/cancel { "request_id": "…" }` while the
response is streaming, or close the HTTP connection. Cancellation works
identically for both engines.

### `POST /tts/cancel`

```json
{ "request_id": "<uuid>" }
```
Response: `{ "cancelled": true | false }`.

Used for barge-in: the TS orchestrator fires this the instant Silero VAD
detects speech during TTS playback.

### Wake word endpoints

| Endpoint | Effect |
|----------|--------|
| `POST /wake/enable` | Start openWakeWord listener background task. |
| `POST /wake/disable` | Stop the listener. |

When a "Hey Jarvis" detection is confirmed, the sidecar POSTs:
```json
{
  "event": "wake",
  "id": "<uuid>",
  "source": "wakeword",
  "phrase": "Hey Jarvis",
  "confidence": 0.87,
  "ts": 1718000000123,
  "device_id": "0"
}
```
to `VOICE_ORCHESTRATOR_URL` (default `http://127.0.0.1:8080/voice/wake`).

### `POST /unload`

```json
{ "components": ["stt", "tts", "vad", "wake"] }
```
Unloads the specified components to reclaim RAM. Omit `components` to unload
all.  VAD is an alias for STT (they share the same manager).

---

## A/B and latency tooling

Two standalone CLI scripts run against a live sidecar (`npm run sidecar:voice`
or `./run.sh`) to produce objective numbers for the Deepgram/Aura evaluation:

- `./.venv/bin/python stt_latency_probe.py` — streams a cached, byte-identical
  fixture PCM through the real WS `/stt/stream` contract at real-time pace and
  prints `speech_end_to_final_ms` per repetition, labelled with whichever STT
  engine `GET /health` reports as active.
- `./.venv/bin/python tts_ab_eval.py` — renders a fixed, non-random sentence
  set through Kokoro and both British Aura-2 voices via `POST /tts`, printing
  a `ttfb_ms`/`rtf` table and writing listenable WAV files per candidate.

Both scripts only ever *measure and report* — the default voice/engine
changes only by an explicit user decision, never automatically.

---

## Wake → orchestrator flow

```
Mic (16 kHz continuous)
  │
  └─▶ openWakeWord (frame inference, <5 ms/frame)
           │  score ≥ threshold (default 0.35)
           ▼
       Debounce (1.5 s cooldown)
           │
           ▼
       POST /api/voice/wake → TS orchestrator
           │
           ├─▶ feature 1: warmUp() — Qwen/MLX model load starts
           └─▶ feature 7: voiceSession.start() — begin capturing command audio
```

The TS orchestrator fans the WakeEvent to both consumers in parallel so the
model warm-up overlaps with the user finishing their command sentence.

---

## Model choices and latency notes

| Stage | Model | Latency (post-warmup) | Notes |
|-------|-------|----------------------|-------|
| VAD | Silero VAD | <1 ms / frame | Acoustic gate; drives speech_start/end events. |
| STT (default) | faster-whisper small int8 | 200–400 ms / 5 s utterance | Segment-based. No streaming partials. |
| STT (preferred) | Parakeet-TDT/MLX | 50–120 ms TTFT + streaming partials | Apple Silicon only. See `stt.py`. |
| TTS | Kokoro (torch) | 200–400 ms TTFA | Sub-300 ms with MLX variant. |
| TTS (preferred) | Kokoro-MLX (mlx-audio) | 150–250 ms TTFA | Apple Silicon, install `mlx-audio`. |
| Wake | openWakeWord hey_jarvis | <5 ms / frame | Always-on, <10 MB RAM. |

**Perceived first-audio latency** (end-of-speech → audio out) target: **700–1500 ms**
post-warmup.  The LLM TTFT (300–700 ms, Qwen/MLX) dominates; STT and TTS are
not on the critical path with streaming.

**RAM budget:** STT + TTS together ~1.5–2 GB.  These are **unloaded** when the
voice session goes idle (default 10 min) to reclaim unified memory for the chat
model (see `architecture/model-serving.md` §4).

---

## Pipecat pipeline (recommended production path)

`pipeline_pipecat.py` wires the full `VAD → STT → LLM → TTS` loop as a single
Pipecat pipeline, giving lower per-frame overhead and native barge-in support:

```bash
pip install "pipecat-ai[silero,local,openai]"
python pipeline_pipecat.py
```

This is the **recommended approach** once the codebase matures.  For now the
HTTP/WS sidecar (`voice_server.py`) is the default integration path because it
fits the existing Node/TS architecture without extra Pipecat knowledge.

---

## Mic / speaker note

All audio I/O (mic capture for wake word and STT, speaker output for TTS
playback) runs **live on the Mac only** via CoreAudio / PyAudio.  There is no
remote audio stream; no audio leaves the device.  Remote clients (e.g. a web
UI) receive only the text events and the PCM bytes from `/tts`.

---

## Files

| File | Purpose |
|------|---------|
| `voice_server.py` | FastAPI app: `/health`, `/stt/stream` (WS), `/tts`, `/tts/cancel`, `/wake/*`, `/unload`, `/warmup` (pre-loads + JIT-warms STT/TTS); `ModelManager` classes for STT/TTS/VAD/Wake with lazy load; weighted voice-blend resolution; Deepgram STT/Aura-TTS engine selection + fallback. |
| `wakeword.py` | openWakeWord listener loop → POST WakeEvent to orchestrator. |
| `stt.py` | faster-whisper + Silero VAD streaming wrapper; Parakeet-MLX alternative stub; VAD-only mode for the Deepgram STT path. |
| `tts.py` | Kokoro TTS streaming wrapper; MLX variant note; WAV header utility. |
| `deepgram_stt.py` | Deepgram streaming-STT WS client (`DeepgramSttSession`) — connect/send_audio/drain_partials/finalize_segment/close. |
| `deepgram_tts.py` | Deepgram Aura-2 streaming-TTS WS client (`synthesize_streaming_aura`) — Kokoro-compatible PCM16 LE 24 kHz output. |
| `echo_gate.py` | Sidecar-side echo gate: tracks `/tts` synthesis windows and drops STT partial/final frames that fuzzy-match recently synthesized text (no-AEC speaker echo that Nova-3 re-hears as different words). Pure logic + injected clock. |
| `stt_latency_probe.py` | CLI: objective `speech_end→final` STT latency measurement over the real WS contract. |
| `tts_ab_eval.py` | CLI: Kokoro vs Aura-2 TTFB/RTF A/B, writes listenable WAV files. |
| `load_env.sh` | Allowlisted, non-overriding loader of `DEEPGRAM_*`/`TTS_ENGINE` from the repo-root `.env`; sourced by `run.sh`. |
| `selftest.py` | Hermetic assert script: STT/TTS manager shape, VAD-only mode, engine-status helpers — no network, no models. |
| `stt_stream_selftest.py` | Hermetic `TestClient` WS selftest for `/stt/stream`'s Deepgram branch and its fallback paths. |
| `tts_selftest.py` | Hermetic `TestClient` selftest for `/tts`'s Aura/Kokoro engine branch, fallback, headers, and cancellation. |
| `pipeline_pipecat.py` | OPTIONAL Pipecat all-in-one pipeline (VAD→STT→LLM→TTS); importable, lazy imports, documented. |
| `requirements.txt` | All Python dependencies with comments on MLX alternatives. |
| `run.sh` | Venv bootstrap (Python 3.11+), allowlisted `.env` load, dep install, uvicorn launch. |
| `README.md` | This file. |
