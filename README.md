# Jarvis

A local-first, persistent-memory personal AI assistant ("second brain") for a single user.
Talk to it with low latency, it remembers everything, learns with you each day, shows a
dashboard of your life metrics, and acts as an agent to do tasks for you.

**Full plan:** see [`features.md`](./features.md) (priority-ordered feature index) and
[`architecture/`](./architecture/) (system design, model serving, auth, deployment, security).

## Status

Phase 1 scaffold — the foundation: **local Qwen inference core** (feature 1) +
**conversational chat core** (feature 2). Later phases add memory, voice, the metrics
dashboard, and the agent.

## Layout

```
features.md            # approved feature index + locked decisions
features/              # one deep spec per feature (1–20)
architecture/          # architecture, model-serving, auth, deployment, security
config/models.yaml     # model registry + routing config
services/core/         # TS/Node core: inference gateway + chat core  (feature 1, 2)
sidecar/mlx/           # Python MLX model server (mlx-lm OpenAI-compatible)  (feature 1)
apps/dashboard/        # Next.js local web app (minimal chat UI for now)
packages/              # shared packages (added as needed)
```

## Hardware target

MacBook Air M3, 16GB, fanless. The local model is **on-demand**: loaded on demand,
auto-unloaded after ~10 min idle. Heavy reasoning + nightly consolidation route to
Hugging Face Inference Providers (serverless router). See [`architecture/model-serving.md`](./architecture/model-serving.md).

## Prerequisites

- **Node ≥ 20** (you have v25 ✓) — uses npm workspaces.
- **Python ≥ 3.11** for the MLX sidecar (your system `python3` is 3.9 — install a newer one,
  e.g. `brew install python@3.12` or use `uv`). See [`sidecar/mlx/README.md`](./sidecar/mlx/README.md).
- A Hugging Face account + a fine-grained token with **"Make calls to Inference Providers"**
  for heavy tasks — serverless, no endpoint to provision (optional until you exercise the
  cloud path). Copy `.env.example` → `.env` and fill in.

## Quick start (after scaffolding)

```bash
cp .env.example .env          # then fill HF_ENDPOINT_URL / HF_TOKEN when ready
npm install                   # install workspace deps

# terminal 1 — start the MLX model server (loads model on demand)
npm run sidecar

# terminal 2 — start the core service (inference gateway + chat)
npm run core

# talk to it from the CLI
npm run chat

# or run the minimal web chat UI
npm run dashboard
```
