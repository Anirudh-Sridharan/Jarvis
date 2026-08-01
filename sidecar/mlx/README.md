# Jarvis MLX Sidecar

The local model server for **Feature 1 — Local Qwen Inference Core**. A thin
FastAPI wrapper around [`mlx-lm`](https://github.com/ml-explore/mlx-lm) that
serves an **OpenAI-compatible** chat + embeddings API on Apple Silicon, plus
**explicit load/unload lifecycle** control so the TypeScript core can reclaim
unified RAM when the model goes idle.

The TS `mlxProvider` / `supervisor` talks to this over
`http://127.0.0.1:<port>/...` exactly as it talks to a cloud provider —
routing local↔remote is a URL swap, not a code fork.

---

## ⚠️ Requires Python 3.11+ (the system `python3` is too old)

Current `mlx-lm` requires **Python ≥ 3.11**. The target machine (MacBook Air
M3, macOS) ships `python3` **3.9.6**, which **cannot** install or run this
server. You must install a newer Python and run via `run.sh`, which builds an
isolated `.venv` from a 3.11+ interpreter.

Install one of:

```bash
# Homebrew
brew install python@3.12

# or uv (fast, self-contained)
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.12
```

`run.sh` probes for `python3.13 / python3.12 / python3.11` (newest first) and
**errors clearly** if none is found.

---

## Run

```bash
chmod +x run.sh           # first time only
MLX_SIDECAR_PORT=8088 ./run.sh
```

`run.sh`:
1. Finds a Python ≥ 3.11 (errors loudly if absent).
2. Creates `.venv` if missing and installs `requirements.txt`.
3. `exec uvicorn mlx_server:app --host 127.0.0.1 --port ${MLX_SIDECAR_PORT:-8088}`.

Binds to **127.0.0.1 only** (loopback; never exposed off-box).

### Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `MLX_SIDECAR_PORT` | `8088` | Listen port (loopback). |
| `MLX_EMBEDDING_MODEL` | `mlx-community/Qwen3-Embedding-0.6B` | Default model for `/v1/embeddings`. |

---

## Endpoints

### Lifecycle

- **`GET /health`** → `{ "state": "unloaded|loading|ready|error", "model": <id|null>, "loaded": bool }`.
  Liveness + state for the TS `ModelManager`.

- **`POST /load`** body `{ "model": "<mlx repo id>" }` → loads the chat model
  into memory. **Lazy, idempotent, and concurrency-safe**: concurrent callers
  for the same model share ONE in-flight load task (never two copies of the
  weights). Returns the status object. On failure returns **503** with state
  `"error"` so the core can fall back to the cloud provider.

- **`POST /unload`** → drops the chat model + tokenizer, runs `gc.collect()`,
  and calls `mlx.core.clear_cache()` (when available) to release Metal buffers.
  This is how the core reclaims RAM after the idle timer fires. Returns status.

### OpenAI-compatible

- **`POST /v1/chat/completions`** body `{ model, messages, stream, max_tokens, temperature }`.
  - The model's **chat template** is applied to `messages` via the tokenizer.
  - **Auto-loads on demand** if the requested model isn't resident — nothing is
    emitted to the client until the model is `ready`.
  - `stream: true` → SSE: `data: {OpenAI chunk}\n\n` per token (via
    `mlx_lm.stream_generate`), terminated by `data: [DONE]\n\n`.
  - `stream: false` → a normal `chat.completion` object with `usage` counts.

- **`POST /v1/embeddings`** body `{ model, input }` → OpenAI embeddings list.
  Uses the **embedding model** (Qwen3-Embedding-0.6B by default), loaded
  **separately** from the chat model and kept resident (it's ~0.6 GB). `input`
  may be a string or a list of strings. Vectors are mean-pooled + L2-normalized.

---

## Load-on-demand / unload-for-RAM design

The M3 Air has **16 GB unified memory** and is **fanless**. RAM is the binding
budget — the chat model, voice models, embeddings, and the OS all share one
pool (see `architecture/model-serving.md` §4). So the chat model is treated as
a **managed cache, not a static resident**:

- The TS core calls `POST /load` on the "Hey Jarvis" wake signal (or on the
  first local-routed request) to warm the model.
- Each completed request resets the core's idle timer.
- After ~10 min idle, the core calls `POST /unload` to free the weights + KV
  cache and reclaim RAM for STT/TTS and embeddings.

The state machine (`unloaded → loading → ready → error`, `ready → unloaded`)
mirrors the TS `ModelManager`. The **embedding model has its own lifecycle**
and may stay resident independent of chat idle-unload.

`mlx_lm.server` (the built-in OpenAI server) does **not** expose an unload
operation, which is the whole reason this wrapper exists.

---

## Model repo IDs

The MLX repo IDs are verified on the HF Hub (2026-06) and live in the TS core's
registry (`config/models.yaml`), which is the source of truth. The chat model id
is supplied by the caller (`/load` body / the `model` field); the embedding model
defaults to `MLX_EMBEDDING_MODEL` (`mlx-community/Qwen3-Embedding-0.6B-8bit`) but
is normally passed per request too. Current IDs: chat
`mlx-community/Qwen3-4B-Instruct-2507-4bit`, embed
`mlx-community/Qwen3-Embedding-0.6B-8bit`.

**Embeddings correctness:** `/v1/embeddings` pools the transformer body's hidden
states with **last-token pooling** (`model.model(tokens)`), then L2-normalizes.
It must NOT call `model(tokens)` — that applies the LM head and returns
vocab-sized logits (~151k-dim), not a sentence embedding.

---

## Files

| File | Purpose |
|------|---------|
| `mlx_server.py` | FastAPI app: endpoints, `ModelManager` (load/unload/gen), `EmbeddingManager`. |
| `requirements.txt` | `mlx`, `mlx-lm`, `fastapi`, `uvicorn[standard]`, `pydantic`. |
| `run.sh` | Builds 3.11+ venv, installs deps, execs uvicorn. |
| `README.md` | This file. |
