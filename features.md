# Jarvis — Personal Second Brain & AI Assistant

> A local-first, persistent-memory AI assistant ("Jarvis") that you talk to with low
> latency, that remembers everything about you, learns with you each day, shows a
> dashboard of your life metrics, and acts as an agent to do tasks for you.
>
> Runs on a local Qwen model (Apple Silicon / optional HF cloud), memory stays on your
> machine, and continually consolidates each night.

**Status:** Feature list APPROVED (Gate 1 ✓). Numbers = priority / build order.
Tier = doc depth (Deep = full spec, Light = mostly-UI spec).

Cross-cutting concerns (model serving, auth/secrets, privacy, deployment) live in
`architecture/`, not here.

### Locked decisions (from interview)

- **Hardware:** MacBook Air M3, 16GB RAM, macOS Tahoe 26.5 (fanless → short bursts local, heavy work to cloud).
- **Model strategy (hybrid):** small local Qwen (~4B/9B, MLX) for chat + voice, loaded on "Hey Jarvis" and unloaded after ~10 min idle; **Hugging Face Inference Providers (serverless router) for heavy reasoning + nightly consolidation** — cost is not a constraint. Model layer swappable.
- **Memory:** capture-everything by default (privacy not a concern). Build the memory core from primitives; use free/OSS where solved.
- **Tooling principle:** prefer free/open-source tools; build from scratch otherwise (or ask). All planned frameworks (Pipecat, LangGraph, Graphiti/mem0, faster-whisper, Kokoro, openWakeWord) are free/OSS.
- **Interface:** macOS menu-bar voice daemon ("Hey Jarvis") **+** local web dashboard.
- **Data sources (v1):** Apple Health (push-from-device) + Whoop; Google Calendar; GitHub + Gmail. **Finance deferred to v2.** No external task tool → **built-in to-do list.**
- **Agent v1 tasks:** email triage/drafting, calendar management, web research/browsing, reminders & to-dos — all behind approval for outward actions.

---

## Phase 1 — Foundation (the brain can think & talk by text)

### 1. Local Qwen Inference Core  · _Deep_
- Serve the latest Qwen model locally on Apple Silicon (MLX) with an OpenAI-compatible API; serverless Hugging Face Inference Providers (router) fallback for heavier requests.
- **On-demand lifecycle:** model loads on wake ("Hey Jarvis"), then auto-unloads after ~10 min of inactivity to free memory — not kept warm 24/7. A few-seconds cold-start on first request after wake is acceptable (no always-resident ack model needed); just give clear "waking up…" feedback.
- Streaming tokens, prompt/prefix caching; model registry so the chat/agent/embedding models can be swapped independently.

### 2. Conversational Chat Core  · _Deep_
- Text chat interface (the primary way you interact before voice lands).
- Working-memory / context-window management: what gets loaded per turn, history truncation, system-prompt assembly.
- Persona ("Jarvis" voice/tone) and per-turn injection of relevant long-term memories.

---

## Phase 2 — Memory (the "second brain")

### 3. Memory Capture & Ingestion  · _Deep_
- **Capture-everything by default** (single-user, privacy not a constraint): conversations, notes/quick-capture, and ingested data (email, calendar, docs, work activity). Per-source toggles exist but default ON; a global pause remains for convenience. Implemented capture-breadth sources now include the **Obsidian/markdown vault** and **local documents** (PDF/text/markdown), chunked into retrievable passages — see `docs/superpowers/specs/2026-06-20-local-documents-pdf-ingest-design.md`.
- Normalizes every source into a common "experience" record for the memory store.
- Higher capture volume → consolidation (feature 6) does more aggressive extraction/dedup/forgetting to keep the store useful rather than bloated.

### 4. Long-Term Memory Store  · _Deep_
- Local temporal knowledge graph (entities, relationships, **fact validity over time**) + embedded vector store for fuzzy semantic recall.
- Episodic (events), semantic (facts/preferences), and procedural (how-you-work) memory tiers.
- Explicit temporal validity + conflict resolution so stale-but-well-phrased facts don't beat fresh ones (the #1 unsolved memory problem).

### 5. Hybrid Memory Retrieval  · _Deep_
- Multi-signal retrieval: semantic + keyword (BM25) + entity match, with recency × importance × relevance scoring (Generative Agents pattern) and a reranker.
- Sub-second recall budget so memory never breaks conversational flow.
- Surfaces the right memories into the chat/agent context at the prompt edges (lost-in-the-middle aware).

### 6. Nightly Memory Consolidation ("Sleep-Time")  · _Deep_
- Scheduled nightly job: extract discrete facts from the day, reflect/synthesize higher-level insights, resolve contradictions, expire stale facts, forget low-value noise.
- Updates the procedural "how I like to work" block — this is how Jarvis "learns with you" without fine-tuning.
- Produces the raw material for the morning briefing (feature 15).

---

## Phase 3 — Voice (talk to it, low latency)

### 7. Low-Latency Voice Interface  · _Deep_
- Full-duplex speech: streaming STT → streaming LLM → streaming TTS, all local on Apple Silicon (MLX), targeting ~sub-second perceived first-audio.
- Turn-taking: acoustic VAD (Silero) + semantic turn detection, with barge-in / interruption.
- Pipecat-style orchestrator gluing the stages; sentence-chunked LLM→TTS streaming.

### 8. Wake Word & Hands-Free  · _Light_
- Always-listening wake word ("Hey Jarvis") with push-to-talk fallback — this is also the **trigger that warms up the inference core** (feature 1).
- Local, low-power wake detection that runs continuously while the heavy model stays unloaded; off the latency-critical path.

---

## Phase 4 — Life Metrics & Dashboard

### 9. Data Integration Framework  · _Deep_
- Adapter/connector framework (HPI-style): per-source pullers on a schedule, normalize to a common schema, store in a local time-series/SQL DB.
- Handles the operational hazards: OAuth token lifecycle/refresh, daily-batch vs webhook freshness, secret storage.
- The shared substrate that features 10–13 plug into.

### 10. Health & Sleep Metrics  · _Deep_
- Sleep, HRV, readiness, activity, heart rate from wearables (Oura / Whoop OAuth) and Apple Health (push-from-device via Health Auto Export → local endpoint).
- Daily-batch sync (data lands T+1 morning); normalized into the metrics store.

### 11. Finance Metrics  · _Deep_  · **(v2 — deferred)**
- Accounts, balances, transactions, net worth, spending via SimpleFIN (read-only, ~$15/yr) and/or self-hosted Actual Budget / Firefly III.
- Optional AI auto-categorization. Deferred past v1 per interview; spec written but not built first.

### 12. Calendar Integration  · _Deep_
- Read/write calendar via Google Calendar API (and/or CalDAV for iCloud); upcoming events, conflicts, free/busy.
- Feeds both the dashboard and the agent (scheduling tasks) and the daily briefing.

### 13. Work & Productivity Metrics  · _Deep_
- **GitHub** (commits/PRs/issues — what you shipped) + **Gmail** (volume, follow-ups) — no external task tool (you use none); Jarvis has a built-in to-do list instead.
- Optional local time tracking (ActivityWatch) later. Normalized into the metrics store + surfaced to memory so Jarvis knows what you're working on.

### 14. Metrics Dashboard UI  · _Deep_
- Web dashboard (Next.js + Tremor/Recharts) aggregating sleep, finances, calendar, and work into KPI cards + charts.
- Single pane of glass; also the home/settings surface for Jarvis (capture toggles, integrations, approvals log).

### 15. Daily Briefing & Digest  · _Light_
- Morning summary (text + optional voice): last night's sleep, today's calendar, finances flagged, work priorities, and any insights from nightly consolidation.
- Proactive "here's your day" — the first taste of proactivity.

---

## Phase 5 — Agent (it does tasks for you)

### 16. Agent / Tool Execution Core  · _Deep_
- Orchestration (LangGraph or Pydantic AI) over MCP tools, with Qwen function-calling wrapped in a validate-and-retry harness (raw local tool-calls are unreliable without it).
- ReAct + reflection loop; plan-and-execute for multi-step tasks; durable/resumable state (SQLite checkpointer) for long or overnight tasks.

### 17. Action Approval & Safety Gate  · _Deep_
- Human-in-the-loop approval for irreversible / outward-facing actions (send email, spend money, delete) — default every new capability to read-only.
- Immutable audit log of every action + reasoning; sandboxing for code/browser; prompt-injection / confused-deputy guards.

### 18. Task Automation & Skills  · _Deep_
- The actual things Jarvis does: send/draft email, schedule events, manage to-dos, web research, bookings, file/note operations — via MCP servers (Google Workspace, filesystem, browser).
- Browser automation (Playwright MCP + browser-use) for tasks without an API.

### 19. Proactive Scheduling & Triggers  · _Deep_
- Cron / event / condition triggers that wake the agent as a reasoner (not a dumb script): nightly consolidation, morning briefing, "remind me when…", recurring chores.
- Persistent episodic state between runs so proactive actions have context.

---

## Phase 6 — Personalization

### 20. Personal Profile & Preference Learning  · _Light_
- An evolving, user-inspectable model of you: preferences, people, projects, routines, communication style — built from memory + consolidation.
- Optional later: a periodic persona/style LoRA (style only, never facts) if memory-based persona proves insufficient.

---

## Architecture layer (separate docs in `architecture/`)

- **architecture.md** — system overview, component diagram, tech stack, data model, latency budget.
- **model-serving.md** — Qwen models (chat/embedding/reranker), MLX vs vLLM vs HF endpoints, quantization, hardware.
- **privacy-and-security.md** — local-first stance, secret storage, capture/retention/deletion, approval/audit, threat model.
- **auth-and-integrations.md** — OAuth token lifecycle for all data sources, secret management.
- **deployment.md** — local daemon + dashboard, optional HF cloud fallback, backups.
