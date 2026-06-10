# @jarvis/core

The Jarvis core service. Phase 1 implements two features:

- **Feature 1 — Local Qwen inference core**: model registry, deterministic local-vs-cloud routing, the load/unload state machine, MLX sidecar + HF endpoint providers, RAM-headroom guard, telemetry, and a unified SSE stream.
- **Feature 2 — Conversational chat core**: persona, deterministic context budgeting + history truncation, fixed-order prompt assembly with lost-in-the-middle edge placement, an in-memory conversation store, and the turn pipeline.

TypeScript, ESM, Node ≥ 20. HTTP via [Hono](https://hono.dev). Config via `yaml` + `zod`.

## Run

```bash
# from repo root (npm workspaces)
npm install

# start the core server (default port 8080)
npm run dev            # = tsx watch src/server.ts
# or from repo root:  npm run core

# build (must pass cleanly: strict + noUncheckedIndexedAccess)
npm run build          # = tsc -> dist/
npm run start          # = node dist/server.js

# interactive REPL against the running server
npm run chat           # = tsx src/cli/chat.ts   (or `npm run chat` from root)
```

### Environment (see repo root `.env.example`)

| Var | Default | Purpose |
| --- | --- | --- |
| `CORE_PORT` | `8080` | Core HTTP port |
| `MLX_SIDECAR_URL` | `http://127.0.0.1:8088` | Local MLX OpenAI-compatible sidecar |
| `HF_ENDPOINT_URL` | _(unset)_ | HF Inference Providers router (`https://router.huggingface.co/v1/chat/completions`), OpenAI-compatible |
| `HF_TOKEN` | _(unset)_ | HF token with "Make calls to Inference Providers" permission (Bearer) |
| `JARVIS_MODELS_CONFIG` | `../../config/models.yaml` | Override path to the registry/routing config |

## HTTP contract

- `GET /healthz` → `{ ok: true }`
- `GET /status` → `{ ok: true, model: { id, state, target, ramHeadroomGB, fallbackActive } }`
  where `state ∈ unloaded | loading | ready | generating | error`.
- `POST /chat` body `{ message: string, conversationId?: string }` → **SSE stream**:
  - `data: {"type":"status","state":"loading"}\n\n` (e.g. waking)
  - `data: {"type":"token","text":"…"}\n\n` (repeated)
  - `data: {"type":"done","conversationId":"…","messageId":"…"}\n\n`
  - `data: {"type":"error","message":"…"}\n\n`

## Sidecar / endpoint contracts this service calls

- **MLX sidecar** (separate Python package, `MLX_SIDECAR_URL`): OpenAI-compatible
  `POST /v1/chat/completions` (supports `stream:true`), `POST /v1/embeddings`, plus
  lifecycle `POST /load`, `POST /unload`, `GET /health`. The `ModelManager` uses
  `/load`,`/unload`,`/health` to drive the state machine; cold start may take a few seconds.
- **HF endpoint** (`HF_ENDPOINT_URL`): OpenAI/TGI-compatible `POST /v1/chat/completions`
  with `Authorization: Bearer ${HF_TOKEN}`.

## Routing rules (deterministic, feature 1)

1. `forceTarget` set → honor it (`forced`).
2. `estPromptTokens > localCtxSafe` (24k) → HF (`token-overflow`). _Hard ceiling._
3. `consolidation | reasoning` → HF (`task-cloud`).
4. `voice | chat` → local (`task-local`).
5. `agent` → local; escalate to HF on token cap (12k) / latency budget (`token-overflow`).
6. `embedding | rerank` → local (`task-local`).
- Pre-flight RAM guard: a local pick with headroom < `ramFloorGB` downgrades to HF (`local-unavailable-fallback`).
- Fallbacks: local load failure → HF (`local-unavailable-fallback`); local runtime error before first token → retry once on HF (`oom-fallback`).

## What is REAL vs stubbed in Phase 1

**Real and compiling:**
- Config load + validation (`config.ts`), registry (`registry.ts`), router rules (`router.ts`).
- Load/unload state machine with shared load promise + idle timer (`modelManager.ts`).
- MLX + HF providers: real `fetch` + OpenAI SSE parsing, lifecycle calls (`providers/`).
- Inference gateway: normalize → route → ensureReady → dispatch → unified SSE + fallback (`gateway.ts`).
- Chat core: persona, context budget + truncation, prompt assembly, conversation store, turn pipeline.
- Hono SSE server (`server.ts`) and the REPL CLI (`cli/chat.ts`).

**Unavailable by design (the model itself):** if the MLX sidecar isn't running, `/load`
fails and the request falls back to HF; if HF isn't configured either, the stream emits a
clear `error` event. The "waking up…" status is surfaced during cold start.

## Cross-phase seams (`TODO(phaseN: feature X)`)

- `chat/promptAssembler.ts`, `chat/chatCore.ts` — **feature 5** memory retrieval injection (empty in Phase 1).
- `chat/chatCore.ts` — **feature 6** procedural "how I work" block loader (empty placeholder).
- `chat/chatCore.ts` — **feature 3** capture-queue enqueue + **feature 2** rolling-summary of overflow.
- `chat/conversationStore.ts` — swap the in-memory Map for a SQLite store.
- `inference/tokens.ts`, `chat/contextBudget.ts` — swap the chars/4 estimator for the real tokenizer.
- `inference/ram.ts` — unified-memory-aware headroom probe.
- `inference/router.ts` — real agent loop-latency telemetry.
- `inference/events.ts` / `telemetry.ts` — bridge status/metrics to the dashboard + menu-bar.
