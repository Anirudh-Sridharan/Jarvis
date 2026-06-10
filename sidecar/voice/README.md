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
| TTS | Kokoro (`bm_fable` British voice) | Auto on first `/tts` call | ~350 MB |
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
| `TTS_VOICE` | `bm_fable` | Kokoro voice ID (British male; see also `bm_george`, `bf_emma`). |
| `TTS_LANG` | `en-gb` | Kokoro language (`en-gb` British / `en-us` American — must match voice prefix). |
| `VAD_THRESHOLD` | `0.5` | Silero VAD speech probability threshold. |
| `WAKE_WORD_MODEL` | `hey_jarvis` | openWakeWord model name or file path. |
| `WAKE_THRESHOLD` | `0.5` | openWakeWord detection confidence threshold. |
| `WAKE_DEBOUNCE_SECS` | `1.5` | Seconds to suppress duplicate wake fires. |

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
  }
}
```

### `WS /stt/stream` — streaming STT

**Client → server:** binary WebSocket frames containing raw **PCM-16 LE mono
16 kHz** audio samples (any chunk size; 320 bytes / 20 ms recommended).

**Server → client:** text WebSocket frames containing JSON:

| Frame | Description |
|-------|-------------|
| `{"type":"speech_start"}` | Silero VAD rising edge (silence → speech). |
| `{"type":"partial","text":"…","stability":0.7}` | Interim hypothesis mid-speech. |
| `{"type":"speech_end"}` | Silero VAD falling edge + hangover (speech → silence). |
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
  "speed": 1.0
}
```

**Response:** chunked binary stream of raw **PCM-16 LE mono 24 kHz** audio.

Headers:
```
Content-Type: audio/pcm; rate=24000; channels=1; bits=16
X-TTS-Request-Id: <uuid>
```

**Cancellation:** call `POST /tts/cancel { "request_id": "…" }` while the
response is streaming, or close the HTTP connection.

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

## Wake → orchestrator flow

```
Mic (16 kHz continuous)
  │
  └─▶ openWakeWord (frame inference, <5 ms/frame)
           │  score ≥ threshold (default 0.5)
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
| `voice_server.py` | FastAPI app: `/health`, `/stt/stream` (WS), `/tts`, `/tts/cancel`, `/wake/*`, `/unload`; `ModelManager` classes for STT/TTS/VAD/Wake with lazy load. |
| `wakeword.py` | openWakeWord listener loop → POST WakeEvent to orchestrator. |
| `stt.py` | faster-whisper + Silero VAD streaming wrapper; Parakeet-MLX alternative stub. |
| `tts.py` | Kokoro TTS streaming wrapper; MLX variant note; WAV header utility. |
| `pipeline_pipecat.py` | OPTIONAL Pipecat all-in-one pipeline (VAD→STT→LLM→TTS); importable, lazy imports, documented. |
| `requirements.txt` | All Python dependencies with comments on MLX alternatives. |
| `run.sh` | Venv bootstrap (Python 3.11+), dep install, uvicorn launch. |
| `README.md` | This file. |
