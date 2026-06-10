# @jarvis/dashboard

The Jarvis web dashboard. **Phase 1** ships only a working **chat UI** that talks
to the Jarvis core service. The full life-metrics dashboard (Health / Calendar /
Work / Memory, KPI cards, charts) is **feature 14** and is intentionally *not*
built here — only placeholders and links are left in place.

## Run

This is part of the npm-workspaces monorepo at the repo root. Install once from
the root, then start the dev server:

```bash
# from the repo root (~/Jarvis)
npm install

# start the dashboard (port 3000)
npm run dashboard
# └─ equivalent to: npm --workspace @jarvis/dashboard run dev
```

Then open http://localhost:3000.

The core service must be running (default `http://127.0.0.1:8080`) for chat and
the status badge to work. Without it, the badge shows **"core offline"** and
sending a message surfaces a "could not reach Jarvis core" error — the UI itself
still loads fine.

### Scripts

| Script  | Action                          |
| ------- | ------------------------------- |
| `dev`   | `next dev -p 3000` (App Router) |
| `build` | `next build`                    |
| `start` | `next start -p 3000`            |

### Configuration

| Env var               | Default                  | Purpose                              |
| --------------------- | ------------------------ | ------------------------------------ |
| `NEXT_PUBLIC_CORE_URL`| `http://127.0.0.1:8080`  | Base URL of the Jarvis core service. |

It is a `NEXT_PUBLIC_*` var because the browser calls the core directly in
Phase 1 (no BFF yet). To override, create `apps/dashboard/.env.local`:

```
NEXT_PUBLIC_CORE_URL=http://127.0.0.1:8080
```

## Core service contract (fixed)

The dashboard speaks to two endpoints on the core.

### `GET /status`

```jsonc
{
  "ok": true,
  "model": {
    "id": "qwen3-...",
    "state": "ready",          // unloaded | loading | ready | generating | error
    "target": "...",
    "ramHeadroomGB": 4.2,
    "fallbackActive": false
  }
}
```

Polled every ~4s by `ModelStatusBadge`. When `state === "loading"` the badge
reads **"waking up…"**. When the core is unreachable it shows **"core offline"**.

### `POST /chat`

Request body:

```json
{ "message": "hello", "conversationId": "optional-existing-id" }
```

Response: an **SSE stream** of `data: <json>` lines. Each JSON payload is one of:

```jsonc
{ "type": "status", "state": "loading" }                     // model warming up
{ "type": "token",  "text": "partial " }                     // one streamed delta
{ "type": "done",   "conversationId": "c1", "messageId": "m1" } // turn finished
{ "type": "error",  "message": "..." }                       // turn failed
```

The client (`app/components/Chat.tsx`) consumes the stream by:

1. Reading `res.body.getReader()` and decoding chunks with `TextDecoder`.
2. Buffering and splitting on the SSE delimiter `\n\n`.
3. Stripping the `data: ` prefix from each line, `JSON.parse`-ing the payload.
4. Dispatching by `type`: `status` → toggle "Waking Jarvis…"; `token` → append
   live into the latest assistant bubble; `done` → store `conversationId` for
   reuse on the next turn; `error` → render an error bubble.

The **Stop** button aborts the in-flight stream via `AbortController`; any tokens
received so far are kept.

## What is a Phase-1 stub

Built and functional now:

- Top bar with live `ModelStatusBadge` (`GET /status` polling).
- Full chat panel: empty / streaming / model-waking / error states, streamed
  tokens, conversation-id reuse, Enter-to-send / Shift+Enter newline, Stop.

Placeholders only (NOT built — feature 14):

- Left-nav items **Health / Calendar / Work / Memory** are disabled "soon" stubs.
- No `/health`, `/calendar`, `/work`, `/memory`, `/finance`, `/briefing`,
  `/settings/*` routes, no BFF `/app/api/*` route handlers, no Tremor / Recharts /
  Tailwind / shadcn. Those land with feature 14 (`// TODO(phase4: feature 14)`
  markers are left in `next.config.mjs`, `globals.css`, and `app/page.tsx`).
