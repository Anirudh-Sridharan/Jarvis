# Jarvis

A local-first, persistent-memory personal AI assistant (a "second brain") for a single user on a Mac. You talk to it by voice or text, it remembers what you tell it, pulls in your calendar, email, health and work signals, and can act on your behalf behind an approval gate. A small local model handles the fast paths on Apple Silicon; heavy reasoning and nightly memory consolidation go to serverless cloud models.

## What it does

- **Chat and voice.** Wake word, streaming speech-to-text (Deepgram Nova-3), local text-to-speech (Kokoro), and barge-in with an echo gate so the assistant's own voice coming back through the mic is not mistaken for an interruption.
- **Memory.** Every turn, note, document and email is captured into a bi-temporal knowledge-graph store, retrieved with hybrid search, and consolidated in the background into facts, episodes and entities. A profile layer derives user-inspectable facets from those facts, injects the relevant ones into prompts, and lets the user pin or correct a fact so consolidation can never overwrite it. Ingesters exist for a markdown (Obsidian) vault, local PDF and text files, and Gmail message bodies.
- **Integrations.** A connector framework normalises Whoop, Apple Health, Google Calendar, GitHub and Gmail into a metric store; plus a built-in to-do list, a daily briefing, and a SimpleFIN finance slice. Calendar events and daily digests are bridged into memory so external data becomes recallable.
- **Agent.** A validate-and-retry harness around every LLM tool call (parse, schema-validate, retry with feedback, abort), a ReAct loop with a step limit, SQLite checkpoints that survive crashes, an approval gate for outward actions, skills, and a proactive trigger scheduler. Tools cover Gmail and Calendar actions, web extraction, and gated macOS control.
- **iMessage channel.** Optional, off by default: reads the local Messages database for an allow-listed self-chat and replies through Messages.app, so the assistant is reachable from a phone.
- **Dashboard.** A Next.js HUD over the local stores: chat, calendar, metrics, to-dos, profile facets and connector controls.

## Architecture

Two layers, applied everywhere: **TypeScript/Node owns orchestration and is the tested layer; Python is used only for model serving**, in `sidecar/` processes that expose OpenAI-compatible or HTTP+WS APIs the TypeScript layer calls.

```
services/core          @jarvis/core          inference gateway, chat core, voice pipeline, iMessage channel, wiring
services/memory        @jarvis/memory        capture -> knowledge-graph store -> hybrid retrieval -> consolidation -> profile
services/integrations  @jarvis/integrations  connectors, metric store, to-dos, briefing, finance
services/agent         @jarvis/agent         tool harness, ReAct loop, checkpoints, approval gate, skills, scheduler
services/voice         @jarvis/voice         wake word, STT, TTS, echo filtering
sidecar/mlx            Python                MLX model server: local Qwen3-4B chat model + Qwen3 embedding model
sidecar/voice          Python                voice server
apps/dashboard         @jarvis/dashboard     Next.js HUD
config/models.yaml                           model registry and routing thresholds
features/ architecture/ docs/                product specs, system design, per-change design docs
```

**Dependency direction:** `@jarvis/core` depends on the memory, integrations and agent packages; those are leaf packages and never import core. Everything external is an injected interface (`LlmClient`, `Embedder`, `HttpClient`, `ToolRegistry`, `Clock`, `TokenStore`, `ApprovalSink`) with fakes shipped in each package's `src/testing/fakes.ts`. That is why the whole suite, roughly 900 vitest tests across six workspaces, runs green with no credentials, no models and no network.

**Inference routing.** The gateway routes each request by task class: `voice` and `chat` go to the local MLX model, which loads on demand and unloads after about ten minutes idle; `consolidation` goes to Fireworks AI; `reasoning` and `agent` go to Anthropic Claude. Providers and thresholds live in `config/models.yaml`, so the split can be rebalanced without touching code.

## Running it

Requirements: Node 20 or newer, Python 3.11 or newer for the sidecars, Apple Silicon for the local model. API keys are optional until you exercise a cloud lane; see `.env.example`.

```bash
cp .env.example .env
npm install

npm start            # sidecars + core + dashboard, health-gated, then the voice CLI
npm run core         # or run pieces individually
npm run dashboard
npm run chat         # text CLI
npm run mac-doctor   # checks the macOS permission grants the voice and iMessage paths need
```

Per package:

```bash
npm run build --workspace @jarvis/<pkg>     # tsc, strict
npm test  --workspace @jarvis/<pkg>          # vitest
```

## Docs

- `features.md` and `features/`: the priority-ordered feature index and one deep spec per feature.
- `architecture/`: system overview, model serving, auth and integrations, privacy and security, deployment.
- `docs/superpowers/specs/`: design docs for individual changes.
- `CLAUDE.md`: the working conventions used while building this with AI coding tools.

## Privacy

All memory, conversation and integration data lives in a local data directory that is gitignored. This repository contains code, tests and design documents only.
