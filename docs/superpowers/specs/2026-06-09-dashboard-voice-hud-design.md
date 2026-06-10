# Dashboard Voice HUD — hands-free conversation from the dashboard

**Date:** 2026-06-09
**Status:** Approved

## Goal

Iron-Man-style voice interaction controlled from the dashboard: arm voice mode on
the command-center home page, say "Hey Jarvis", speak, and Jarvis replies aloud —
with the live conversation (state, transcript, streamed reply) rendered in the
dashboard. Single-user, same-Mac only: the browser tab and the Jarvis stack run on
the same machine, so all audio I/O stays on the system mic/speakers via the
existing voice pipeline. No audio is captured or played in the browser.

## What already exists (reused untouched)

- `@jarvis/voice` `VoiceOrchestrator` is already wake-word-driven: `WakeWordSource.onWake()`
  → warmup + STT stream → turn detection → core `/chat` SSE → sentence chunker →
  `TtsEngine.speak()`, with barge-in and a typed `OrchestratorEvent` stream
  (`state_change`, `partial_transcript`, `final_transcript`, `token`, `turn_complete`,
  `barge_in`, `error`).
- Live deps in `services/core/src/voice/`: `SidecarSttEngine` (WS `/stt/stream` + ffmpeg mic),
  `SidecarTtsEngine` (POST `/tts` → ffplay), `CoreHttpClient` (loopback `/chat` SSE).
- The Python voice sidecar (8089) has an openWakeWord listener (`POST /wake/enable|disable`)
  that captures the system mic itself and POSTs a `WakeEvent` JSON to
  `VOICE_ORCHESTRATOR_URL` on detection.
- Core (8080) already serves the dashboard browser directly with localhost CORS.

## Architecture decision

**Core hosts the voice session** (rejected alternatives: hosting in the Next.js
server violates the read-only-BFF rule and would spawn ffmpeg/ffplay inside Next;
keeping the CLI as host means the dashboard toggle can't actually start anything).

```
Browser (home page HUD)            Core :8080                      Voice sidecar :8089
  POST /voice/start  ─────────▶  VoiceSessionManager ──POST /wake/enable──▶ openWakeWord (system mic)
  GET  /voice/events (SSE) ◀───  orchestrator events                │
  POST /voice/stop   ─────────▶                                     │ wake detected
                                 POST /voice/wake  ◀────────────────┘
                                 HttpWakeSource.dispatch()
                                 → VoiceOrchestrator turn:
                                   STT (WS, ffmpeg mic) → /chat → TTS (ffplay, Mac speakers)
```

## Backend (`@jarvis/core`)

### `services/core/src/voice/httpWakeSource.ts`
A `WakeWordSource` implementation that is a plain event fan-out. `start()`/`stop()`
toggle an `armed` flag; `dispatch(event)` forwards a validated `WakeEvent` to
registered listeners only while armed (late events after stop are dropped).

### `services/core/src/voice/voiceSessionManager.ts`
Owns the long-lived session:

- `start()` — idempotent (starting an active session returns current status).
  Checks sidecar `/health`, `POST /wake/enable`, builds the orchestrator via a
  shared `buildVoiceDeps()` factored out of `cli/voice.ts` (CLI keeps working,
  no duplicated wiring), starts it, and begins buffering orchestrator events
  into a ring buffer (last ~200) while broadcasting to SSE subscribers.
- `stop()` — `POST /wake/disable`, stop orchestrator, cancel in-flight TTS.
- `status()` — `{ active, state, lastWakeAt }`.
- Registered in core's shutdown hook so wake word is disabled when core exits.

### `server.ts` endpoints
- `POST /voice/start`, `POST /voice/stop`, `GET /voice/status`
- `POST /voice/wake` — sidecar callback; zod-validates the WakeEvent payload,
  calls `wakeSource.dispatch()`.
- `GET /voice/events` — SSE: replays current status, then streams each
  `OrchestratorEvent` as a `data: <json>` frame; periodic comment heartbeats.

### Config
`scripts/start.sh` (and docs) set `VOICE_ORCHESTRATOR_URL=http://127.0.0.1:8080/voice/wake`
for the voice sidecar (replacing the placeholder default pointing at :3000).

## Frontend (`apps/dashboard`)

### `app/components/VoiceHud.tsx`
Compact HUD strip on the home page, matching the locked theme (subtle HUD,
electric-blue monochrome, Share Tech Mono):

- **Arm toggle** (`VOICE`): arm → `POST /voice/start` + open `/voice/events` SSE
  (same fetch-reader pattern as `Chat.tsx`); disarm → `POST /voice/stop` + close.
  If core reports the sidecar offline, show the error inline; do not arm.
- **State indicator**: status ring + label from `state_change` events —
  `STANDBY` / `WAKING` / `LISTENING` (pulsing) / `THINKING` / `SPEAKING`, brief
  flash on `barge_in`. Live `partial_transcript` shown dim/italic while listening.
- **Sync on load**: `GET /voice/status` on mount; the session lives in core, so a
  reloaded tab reattaches to a running session instead of restarting it.

### Chat integration
Chat message state is lifted into a shared `useChatFeed` hook owned by the home
page. `Chat.tsx` consumes it for typed turns (behavior unchanged). `VoiceHud`
appends voice turns: `final_transcript` → user bubble with a mic glyph, `token` →
streams into an assistant bubble, `turn_complete` → finalize. Voice turns use the
orchestrator's own core-side conversation; the dashboard merges only the display.

## Error handling

- SSE drop → HUD shows `RECONNECTING`, retries with backoff.
- Orchestrator `error` events render as a dim error line in the HUD (not a chat bubble).
- `/voice/start` with sidecar down → 503 with a message the HUD displays.
- Core shutdown disables the sidecar wake listener.

## Testing

- `@jarvis/core` vitest: `HttpWakeSource` (armed/disarmed dispatch),
  `VoiceSessionManager` (start/stop idempotency, wake → orchestrator turn using
  `@jarvis/voice` testing fakes, SSE relay, ring-buffer replay, late-wake dropped).
- Endpoints exercised through the existing server test patterns with injected fakes;
  no network, no models, no audio processes in tests.
- Dashboard: `npx tsc --noEmit` (dashboard has no vitest, per project convention).

## Out of scope

- Browser-side audio (mic capture / playback) — same-Mac only by decision.
- Remote-device voice, voice settings UI (voice/speed pickers), persisting voice
  transcripts into dashboard chat history storage.
