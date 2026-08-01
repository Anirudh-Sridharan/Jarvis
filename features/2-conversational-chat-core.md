# Conversational Chat Core

> Priority/build order: 2  ·  Tier: deep

## Summary

The conversational chat core is Jarvis's text-chat brain: the layer that turns a raw user message into a memory-aware, persona-consistent, streamed reply. It is the primary interaction surface before/under voice (feature 7) and the integration point that wires the inference core (feature 1) to the memory subsystem (features 3–6).

Its single hardest job is **working-memory management**: the model's context window is finite (~8k–16k tokens for the small local Qwen running via MLX on a 16GB M3 Air), so every turn must *assemble* — not accumulate — the prompt. The core retrieves a small, scored set of long-term memories (feature 5), loads the procedural "how I work" block (written nightly by feature 6, read-only here), truncates recent history, and lays everything out so the most important context sits at the **edges** of the prompt to dodge the lost-in-the-middle attention dip (the U-shaped attention curve where mid-context tokens are systematically under-attended). It streams tokens out for low perceived latency and, after the turn closes, enqueues the exchange for capture (feature 3).

Persona is fixed and concise: "Jarvis" — capable, slightly witty, never verbose. The core is deterministic about *structure* (budgets, ordering, truncation) and only AI-driven about *content* (the reply, and optional history summarization). This split is the central design invariant: which tokens occupy the window is code-controlled and unit-testable; only what the model says with them is probabilistic.

## Turn sequence  *(deep tier)*

A single turn fans out across four subsystems. The diagram below traces the happy path: user message → memory retrieve (feature 5) → prompt assembly → streamed generation (feature 1) → fire-and-forget capture (feature 3). Note the **parallelism**: the cold-model load (feature 1) and memory retrieval (feature 5) run concurrently with assembly so neither is on the critical path when avoidable.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant FE as Frontend (web/menu-bar)
    participant Orch as Chat Orchestrator
    participant Store as Conversation Store
    participant Inf as Inference Core (F1, MLX/cloud)
    participant Ret as Retrieval (F5)
    participant Proc as Procedural Block (F6, RO)
    participant Asm as Prompt Assembler
    participant Cap as Capture Queue (F3)

    User->>FE: type message, send
    FE->>Orch: sendMessage(userMessage, conversationId)
    Orch->>Store: append Message{role:'user'}; emit turn:start
    Orch->>Inf: getStatus()
    alt model unloaded
        Inf-->>Orch: 'unloaded'
        Orch->>Inf: load() (async)
        Orch-->>FE: state = model-waking ("Waking Jarvis…")
    else loaded
        Inf-->>Orch: 'loaded'
    end

    par retrieval + procedural (concurrent with warm-up)
        Orch->>Ret: retrieve(query, last 1-2 turns) [budget < 1s]
        Ret-->>Orch: RetrievedMemory[] (scored) or [] on timeout
    and
        Orch->>Proc: read() (in-process cache)
        Proc-->>Orch: proceduralBlock: string
    end

    Orch->>Store: load recent history + rollingSummary
    Orch->>Asm: assemble(persona, procedural, memories, history, userMsg)
    Note over Asm: token-count each segment,<br/>place top memory at history edge,<br/>assert total ≤ ctx − replyHeadroom
    Asm-->>Orch: AssembledPrompt

    Orch->>Inf: /chat/completions {stream:true}
    loop token deltas
        Inf-->>Orch: delta
        Orch-->>FE: forward delta (voice path: flush per sentence → TTS)
    end
    Inf-->>Orch: [DONE] (or user stop → abort)

    Orch->>Store: persist Message{role:'assistant'}; emit turn:end
    Orch-)Cap: enqueue (user, assistant) pair (fire-and-forget)
    Orch-->>FE: memoryInjectionInfo (optional "Recalled N" chip)
```

## Data flow  *(REQUIRED)*

- **Inputs:**
  - `userMessage: string` (from web chat panel or menu-bar popover; on voice path, the ASR transcript from feature 7).
  - `conversationId: string` — active conversation; new one if none.
  - Conversation history (recent `Message[]`) from local store.
  - Retrieved memories (`RetrievedMemory[]`) from feature 5, scored by recency × importance × relevance.
    > **Recall depends on consolidation.** Retrieval (feature 5) searches the **consolidated** memory graph (episodes/facts/entities). Turns captured this session live in `experience_records` (`consolidation_pending`) and are **not** retrievable until [feature 6](./6-nightly-memory-consolidation.md) `consolidation.run()` has promoted them into the graph. So "tell it your name → restart → ask" only recalls after a consolidation pass has run. `server.ts` wires the memory system in via `getMemorySystem(gateway)` and runs a background `ConsolidationScheduler` that triggers a pass when capture goes quiet (or on a `POST /consolidate` call), so recall becomes automatic. Capture additionally requires the MLX sidecar's `/v1/embeddings` returning real sentence vectors.
  - Procedural memory block (`string`) — the self-updated "how I like to work" block, owned/written by feature 6, read-only here.
  - Static persona system prompt (versioned constant).
  - Model status from feature 1 (`loaded | loading | unloaded`).

- **Processing / pipeline:** (numbered)
  1. **Receive & persist user turn.** Append `Message{role:'user'}` to the conversation; assign ids/timestamps. Emit `turn:start` to the frontend.
  2. **Check model.** Query feature 1. If `unloaded`, fire load and surface `model-waking` state; continue assembling in parallel so the prompt is ready when weights land.
  3. **Trigger retrieval (selective).** If the message warrants it (see Logic), call feature 5 with the query + recent-turn context. Budget: **sub-second**; on timeout, proceed with zero memories rather than block the turn.
  4. **Load procedural block.** Read the current procedural-memory string (cached in-process, invalidated when feature 6 rewrites it).
  5. **Truncate / summarize history.** Apply the budget algorithm: keep newest turns verbatim within budget; older overflow is replaced by a rolling summary (AI-generated, cached on the conversation).
  6. **Assemble prompt** (see fixed order below) into an `AssembledPrompt`, computing a token-budget breakdown and asserting total ≤ context window minus reply headroom.
  7. **Stream generation.** Call feature 1's OpenAI-compatible `/chat/completions` with `stream:true`. Forward token deltas to the frontend; on voice path, flush **sentence-by-sentence** into TTS.
  8. **Finalize.** On completion (or user `stop`), persist `Message{role:'assistant'}`, attach `assembledPromptRef` for debugging, emit `turn:end`.
  9. **Enqueue for capture.** Hand the (user, assistant) pair to feature 3's ingestion queue (fire-and-forget; never blocks the reply).

  **Prompt-assembly ORDER (top → bottom of the context):**
  1. **System + persona** (top edge — strongest attention): identity, tone rules, capabilities, current date/time, model/cloud-mode note.
  2. **Procedural "how I work" block**: the user's working preferences, near the top so they steer the whole turn.
  2.5. **Connected-app agenda block (calendar-shaped messages only):** a deterministic agenda rendered from the local Google Calendar mirror (feature 12) in LOCAL time — enumerating a day's events is a lookup, not a similarity search, so it never rides on top-k retrieval. Gated by a cheap calendar-intent regex (the block costs tokens); ends with an explicit "these are ALL the events — do not invent others" line. Injected via the `AgendaSource` seam (core wires the live mirror; tests inject a fake).
  3. **Retrieved long-term memories**: rendered as compact bullet facts/events with timestamps; *highest-scored memory placed last in this block* so it abuts the recent history.
  4. **Truncated recent history**: rolling summary (if any) first, then the newest verbatim turns.
  5. **Current user message** (bottom edge — strongest attention).

  **Token budget breakdown** (target for a 16k-token context window; scale proportionally for 8k):
  | Segment | Budget (16k) | Notes |
  |---|---|---|
  | System + persona | ~600 | static, version-pinned |
  | Procedural block | ~800 | hard-capped; feature 6 keeps it lean |
  | Retrieved memories | ~2,500 | ~6–12 items, scored & truncated |
  | Recent history (verbatim + summary) | ~9,000 | summary ≤ ~600 of this |
  | **Reply headroom (max_tokens)** | ~2,000 | reserved, never consumed by input |
  | Safety slack | ~100 | rounding / tokenizer drift |

- **Outputs:**
  - Streamed assistant tokens to the active client (SSE/WebSocket).
  - Persisted `Message` (assistant) on the `Conversation`.
  - A capture job enqueued to feature 3.
  - Optional `memoryInjectionInfo` to the UI (what was remembered, for the "it remembered…" affordance).

- **Schemas:**
  ```ts
  type Role = 'system' | 'user' | 'assistant';

  interface Message {
    id: string;
    conversationId: string;
    role: Role;
    content: string;
    createdAt: string;            // ISO 8601
    tokenCount?: number;
    assembledPromptRef?: string;  // assistant turns: debug link to the prompt used
    captureStatus?: 'pending' | 'ingested' | 'skipped';
  }

  interface Conversation {
    id: string;
    title: string;                // auto-derived from first user turn
    createdAt: string;
    updatedAt: string;
    messages: Message[];          // newest last
    rollingSummary?: string;      // AI summary of truncated-out history
    summaryThroughMessageId?: string;
    mode: 'local' | 'cloud';      // current inference backend (feature 1)
  }

  interface RetrievedMemory {
    id: string;
    tier: 'episodic' | 'semantic';   // procedural handled separately
    text: string;                    // rendered fact/event
    timestamp?: string;              // event time (episodic)
    score: number;                   // recency × importance × relevance
    sourceRef: string;               // node/edge id in Graphiti or vector id
  }

  interface AssembledPrompt {
    messages: { role: Role; content: string }[]; // ready for /chat/completions
    budget: {
      system: number; procedural: number; memories: number;
      history: number; total: number; replyHeadroom: number;
      contextWindow: number;
    };
    injected: RetrievedMemory[];     // for UI surfacing + debugging
    truncated: boolean;
    summarized: boolean;
  }
  ```

## Reference implementation  *(deep tier)*

Two functions carry the load-bearing logic: the **prompt assembler** (fixed-order layout with edge placement) and the **context-budget / truncation algorithm** (deterministic fitting). Both are pure and unit-tested; neither calls the model except where explicitly noted (rolling summary).

### 1. Prompt assembly — edge placement + token-budget math

```ts
// promptAssembler.ts
import { countTokens } from './contextBudget';
import { PERSONA_SYSTEM_PROMPT } from './persona';

interface AssembleArgs {
  procedural: string;                 // feature 6 block (read-only)
  agenda?: string;                    // deterministic calendar block (feature 12 mirror); "" unless calendar-shaped
  memories: RetrievedMemory[];        // pre-scored, descending, already capped by F5
  history: Message[];                 // newest verbatim turns (post-truncation)
  rollingSummary?: string;            // recap of truncated-out turns
  userMessage: string;
  contextWindow: number;              // 16k local Qwen; larger for the cloud provider
  mode: 'local' | 'cloud';
  now: Date;
  memoryAvailable?: boolean;          // memory system wired this turn (grounding note on empty recall)
}

const REPLY_HEADROOM = 2_000;
const SAFETY_SLACK = 100;

export function assemblePrompt(a: AssembleArgs): AssembledPrompt {
  // --- TOP EDGE: system + persona (strongest attention) ---------------------
  const systemBlock = [
    PERSONA_SYSTEM_PROMPT,                                  // versioned "Jarvis"
    `Current time: ${a.now.toISOString()}.`,
    a.mode === 'cloud' ? 'Note: answering via cloud model this turn.' : '',
    // Procedural "how I work" block sits near the top so it steers the turn.
    a.procedural ? `## How I work\n${a.procedural}` : '',
  ].filter(Boolean).join('\n\n');

  // --- Retrieved memories: lost-in-the-middle aware -------------------------
  // Render compact, timestamped bullets. The TOP-scored memory is emitted
  // LAST so it abuts the recent history (a prompt edge); weakest memories sit
  // in the attention-dead middle where their loss costs least.
  let memoryBlock = '';
  const injected: RetrievedMemory[] = [];
  if (a.memories.length > 0) {
    const ascending = [...a.memories].sort((x, y) => x.score - y.score); // weak→strong
    const lines = ascending.map((m) => {
      injected.push(m);
      const ts = m.timestamp ? ` (${m.timestamp.slice(0, 10)})` : '';
      return `- ${m.text}${ts}`;
    });
    memoryBlock = `## Relevant memories\n${lines.join('\n')}`;
  } else if (a.memoryAvailable) {
    // Grounding: recall ran and found nothing — say so explicitly so the model
    // answers "not stored" instead of inventing personal details.
    memoryBlock =
      '## Relevant memories\nNone found for this message. Do not state personal ' +
      "facts about the user that are not in this conversation — say the information " +
      "isn't stored and offer to look it up.";
  } // no memory system wired: omit scaffolding; persona grounding rules still apply

  // --- History: rolling summary first, then newest verbatim turns ----------
  const historyMsgs: { role: Role; content: string }[] = [];
  if (a.rollingSummary) {
    historyMsgs.push({
      role: 'system',
      content: `## Earlier conversation (summary)\n${a.rollingSummary}`,
    });
  }
  for (const m of a.history) historyMsgs.push({ role: m.role, content: m.content });

  // --- BOTTOM EDGE: current user message (strongest attention) -------------
  const messages: { role: Role; content: string }[] = [
    { role: 'system', content: systemBlock },
    ...(memoryBlock ? [{ role: 'system' as Role, content: memoryBlock }] : []),
    ...historyMsgs,
    { role: 'user', content: a.userMessage },
  ];

  // --- Budget math + hard assert -------------------------------------------
  const system = countTokens(systemBlock);
  const memTok = countTokens(memoryBlock);
  const histTok = historyMsgs.reduce((s, m) => s + countTokens(m.content), 0);
  const userTok = countTokens(a.userMessage);
  const total = system + memTok + histTok + userTok;
  const ceiling = a.contextWindow - REPLY_HEADROOM - SAFETY_SLACK;

  if (total > ceiling) {
    // Should be impossible: history was pre-trimmed by fitContextBudget().
    // Tokenizer drift is the only legitimate cause — log + signal a retry.
    throw new ContextOverflowError(total, ceiling);
  }

  return {
    messages,
    budget: {
      system,
      procedural: countTokens(a.procedural),
      memories: memTok,
      history: histTok,
      total,
      replyHeadroom: REPLY_HEADROOM,
      contextWindow: a.contextWindow,
    },
    injected,
    truncated: false, // set by the caller if history was trimmed
    summarized: Boolean(a.rollingSummary),
  };
}
```

### 2. Context-budget / truncation algorithm

```ts
// contextBudget.ts
const REPLY_HEADROOM = 2_000;
const SAFETY_SLACK = 100;
const PROCEDURAL_CAP = 800;
const MEMORY_CAP = 2_500;

export function countTokens(s: string): number {
  // Backed by the active model's tokenizer (MLX Qwen locally; the cloud
  // provider's tokenizer when in cloud mode). Approx fallback: chars/4 if
  // tokenizer unavailable.
  return tokenizer.encode(s).length;
}

interface FitResult {
  history: Message[];        // newest verbatim turns that fit
  overflow: Message[];       // older turns to fold into the rolling summary
  cappedMemories: RetrievedMemory[];
  truncated: boolean;
}

/**
 * Deterministic fitting. Fill in priority order; trim by the cheapest loss:
 * memories by LOWEST score first, history by OLDEST turn first.
 */
export function fitContextBudget(args: {
  contextWindow: number;
  systemTokens: number;      // persona + date + procedural (already capped)
  summaryTokens: number;     // existing rolling summary, if any
  memories: RetrievedMemory[];
  history: Message[];        // newest last
}): FitResult {
  const { contextWindow, systemTokens, summaryTokens } = args;

  // 1. Establish the input ceiling.
  const ceiling = contextWindow - REPLY_HEADROOM - SAFETY_SLACK;

  // 2. Cap memories to their segment budget, dropping lowest score first.
  let memUsed = 0;
  const cappedMemories: RetrievedMemory[] = [];
  for (const m of [...args.memories].sort((a, b) => b.score - a.score)) {
    const t = countTokens(m.text);
    if (memUsed + t > MEMORY_CAP) continue; // skip; keep scanning lower items
    memUsed += t;
    cappedMemories.push(m);
  }

  // 3. Remaining room for history (verbatim turns).
  const fixed = systemTokens + summaryTokens + memUsed;
  const historyBudget = ceiling - fixed;

  // 4. Walk history newest → oldest, keeping turns that fit.
  const kept: Message[] = [];
  const overflow: Message[] = [];
  let used = 0;
  for (let i = args.history.length - 1; i >= 0; i--) {
    const msg = args.history[i];
    const t = msg.tokenCount ?? countTokens(msg.content);
    if (used + t <= historyBudget) {
      kept.unshift(msg);
      used += t;
    } else {
      // Everything from here back is older → overflow into the summary.
      overflow.unshift(...args.history.slice(0, i + 1));
      break;
    }
  }

  return {
    history: kept,
    overflow,                       // caller folds these into rollingSummary
    cappedMemories,
    truncated: overflow.length > 0,
  };
}
```

The `overflow` turns are handed to `history/summarize.ts`, which produces (or extends) the AI-generated `rollingSummary` (≤ ~600 tokens) and advances `summaryThroughMessageId`. This is the only place in the budget path that calls the model.

## Frontend flow  *(REQUIRED)*

- **Screens / states:**
  - **Empty** — fresh conversation; persona greeting, prompt suggestions, focused input.
  - **Streaming** — assistant tokens render live; a stop control replaces send.
  - **Memory-injected** — subtle chip/expander on the assistant bubble ("Recalled 4 memories") that, when opened, lists the `injected` items with timestamps and scores. Off by default, toggled in settings.
  - **Model-waking** — shown when feature 1 reports `loading`; a "Waking Jarvis…" indicator; input stays enabled so the message queues.
  - **Error** — retrieval timeout (degrades silently with a tiny "no memory this turn" note), generation failure (retry), or backend down (clear message + retry).
  - **Cloud-mode banner** — when a turn falls back to a cloud provider (feature 1), a non-blocking "Answered via cloud" badge.

- **Key controls:**
  - **Send** (Enter) / multiline (Shift+Enter).
  - **Stop / interrupt** — aborts the stream; partial reply is kept and persisted.
  - **New conversation** — opens a fresh `Conversation`.
  - **"What do you know about X" memory peek** — a side query to feature 5 that previews retrievable memories *without* sending a chat turn; renders ranked `RetrievedMemory[]`.
  - Conversation list / switcher; per-message copy; toggle for the memory-injection chip.

- **User journey:**
  1. User opens the dashboard chat panel (or clicks the menu-bar popover) → **empty** state.
  2. Types a message, hits send → bubble appears; if the model is cold, **model-waking** shows briefly.
  3. Behind the scenes memory is retrieved and the prompt assembled; reply **streams** in token-by-token.
  4. If memories were used, a "Recalled N" chip appears; the user can expand it to see exactly what Jarvis pulled.
  5. User can **stop** mid-reply, start a **new conversation**, or run a **memory peek** to inspect what Jarvis knows about a topic.
  6. The menu-bar popover mirrors the same engine for quick one-off questions and is the visual counterpart to the voice daemon (feature 7).

## Logic / rules  *(deep tier)*

- **Context-budget algorithm (deterministic):** Start from `contextWindow`, subtract `replyHeadroom` and safety slack. Fill segments in priority order — system+persona (fixed) → procedural (hard cap) → memories → history. Each segment is token-counted with the model's tokenizer; if a segment exceeds its cap it is trimmed (memories by lowest score first; history by oldest turn first). The assembler **asserts** the final total fits before calling the model — overflow is a bug, not a runtime gamble. See `fitContextBudget` above.
- **History truncation / summarization rule:** Keep the newest turns verbatim while they fit the history budget. When older turns would overflow, fold them into `rollingSummary` (an AI-generated recap, ≤ ~600 tokens) and advance `summaryThroughMessageId`. The summary lives at the *top* of the history block (older = mid-context, lower attention is acceptable for a recap). Verbatim newest turns sit nearest the user message.
- **When to trigger retrieval (selective):** Run retrieval for substantive messages; skip for trivial chit-chat / pure acknowledgements ("ok", "thanks") via a cheap heuristic (length + content classifier) to save the latency budget. Retrieval is **scoped** by the query plus the last 1–2 turns for context. Never dump everything — feature 5 returns a ranked set; this core caps it to the memory token budget, placing the top-scored item adjacent to the history (prompt edge).
- **Edge-placement rationale (lost-in-the-middle):** Decoder attention follows a U-shape — tokens at the start and end of the window are attended far more reliably than the middle. The assembler exploits this deliberately: persona/procedural at the top edge, the *single highest-scored* memory at the boundary abutting recent history, and the user message at the bottom edge. Low-value content (weak memories, the rolling summary) is parked in the middle where attention loss is least costly.
- **Procedural block (read-only here):** Loaded as a single string and inlined near the top of the system context. The chat core never writes it — feature 6's nightly consolidation owns it. The core only invalidates its in-process cache when notified of a rewrite. This is how Jarvis "learns with you" without fine-tuning.
- **Persona system prompt:** A versioned constant defining the "Jarvis" voice — concise, capable, slightly witty; no filler, no over-apologizing; uses memory naturally without announcing it unless asked. Versioned so persona changes are traceable across conversations. **v2 adds grounding rules:** everything Jarvis knows about the user comes only from the prompt's memory/context blocks (connected-app data surfaces through the same blocks via the ingest bridge) and the conversation itself; personal facts are never invented — unknown means "not stored", with an offer to look it up.
- **Deterministic vs AI-driven boundary:** Deterministic — segment ordering, token budgeting, truncation, retrieval gating heuristic, edge-placement of top memory. AI-driven — the reply itself and the rolling-summary text. Everything that affects *which* tokens occupy the window is code-controlled and testable.

## Edge cases & safety

| Case | Trigger | Behavior |
|---|---|---|
| **Model unloaded** | Feature 1 reports `unloaded` on first turn | Fire load (trigger wake), show **model-waking**, assemble prompt + retrieve memories in parallel, queue the user message, then generate when weights land. Nothing is lost during warm-up. |
| **Context overflow** | Post-assert total > ceiling (tokenizer drift) | `assemblePrompt` throws `ContextOverflowError`; caller drops lowest-scored memories then oldest verbatim turns, re-fits, logs the event, and retries. Never send an over-budget prompt. |
| **No relevant memories** | Feature 5 returns `[]` (or all below threshold) | With a memory system wired, the block is replaced by a short **"nothing stored" grounding note** so the model says it doesn't have the fact instead of hallucinating one. With no memory system at all, omit the block entirely (no empty scaffolding). |
| **Calendar question, empty window** | Calendar-intent message; mirror returns no events in the agenda window | Agenda block still emitted with an explicit "No events in this window" line — silence invites the model to invent events. Mirror unavailable/throws → block omitted, turn proceeds (memory-only). |
| **Contradictory memories** | Conflicting facts surfaced for the same entity | Pass both through; rely on feature 5's temporal scoring to favor the most recent/valid; persona flags uncertainty ("Last I noted X, though that may have changed") rather than asserting blindly. |
| **Very long conversation** | History exceeds the verbatim budget repeatedly | Rolling summarization keeps the live window bounded indefinitely; full transcript stays in the local store and stays searchable via memory after it leaves the window. |
| **Cloud fallback mid-conversation** | Feature 1 routes a turn to a cloud provider | Re-budget against that model's larger `contextWindow`, keep the same assembly order, show the cloud badge, set per-turn `mode='cloud'`. Subsequent turns may revert to local. |
| **Retrieval timeout / memory down** | Feature 5 exceeds the sub-second budget or is offline | Proceed with zero memories so chat flow is never blocked; surface a quiet "no memory this turn" note. |
| **Streaming abort** | User hits stop, or socket/connection drops mid-stream | Abort the `/chat/completions` stream; persist the partial assistant message; still enqueue it for capture (partial context > none). Emit `turn:end`. |
| **Generation failure** | Feature 1 errors after assembly (OOM, crash) | Surface a retry; the assembled prompt is cached so retry skips re-retrieval/re-assembly. If local repeatedly fails, offer cloud fallback. |
| **Procedural cache stale** | Feature 6 rewrites the block mid-session | Feature 6 signals invalidation; the in-process cache reloads on the next turn. A turn already in flight uses the prior block (acceptable — eventual consistency). |
| **Empty / trivial message** | "ok", "thanks", whitespace | Retrieval gate skips F5 (saves latency); turn still streams a short reply; still captured. |
| **New conversation, no history** | First turn of a fresh `Conversation` | No history/summary segments; prompt = persona + procedural + memories (if any) + user message. Title auto-derived from this first turn. |
| **Privacy / silent action** | Any turn that injects memories | Injected memories are user-inspectable via the "Recalled N" chip; all data stays local-first so Jarvis never silently acts on stale or wrong beliefs. |

## Dependencies  *(REQUIRED)*

- [features/1-local-qwen-inference-core.md](./1-local-qwen-inference-core.md) — local Qwen via MLX + cloud fallback (Fireworks/Anthropic); OpenAI-compatible streaming API; load/unload status.
- [features/3-memory-capture-and-ingestion.md](./3-memory-capture-and-ingestion.md) — receives the closed turn for ingestion into long-term memory.
- [features/4-long-term-memory-store.md](./4-long-term-memory-store.md) — Graphiti temporal graph + LanceDB/Chroma vectors backing retrieval.
- [features/5-hybrid-memory-retrieval.md](./5-hybrid-memory-retrieval.md) — per-turn scored memory retrieval (recency × importance × relevance) and the memory-peek query.
- [features/6-nightly-memory-consolidation.md](./6-nightly-memory-consolidation.md) — writer/owner of the procedural "how I work" block consumed read-only here.
- [features/7-low-latency-voice-interface.md](./7-low-latency-voice-interface.md) — reuses this engine; consumes sentence-by-sentence streaming for TTS.
- [architecture/architecture.md](../architecture/architecture.md) — overall component wiring, data stores, and process boundaries.

## File structure  *(deep tier)*

```
src/chat/
  index.ts                 # public API: sendMessage(), streamTurn(), newConversation()
  orchestrator.ts          # the 9-step turn pipeline (receive → assemble → stream → capture)
  promptAssembler.ts       # fixed-order assembly + edge placement → AssembledPrompt
  contextBudget.ts         # token counting, per-segment caps, overflow trimming, assert
  history/
    truncate.ts            # verbatim-window selection within budget
    summarize.ts           # rolling-summary generation + cache management
  persona.ts               # versioned "Jarvis" system prompt constant
  procedural.ts            # read-only loader + cache for feature 6's block
  retrievalGate.ts         # selective-retrieval heuristic (skip trivial turns)
  errors.ts                # ContextOverflowError + retry classification
  types.ts                 # Message, Conversation, RetrievedMemory, AssembledPrompt
  store/
    conversations.ts       # local persistence (load/append/update, rolling summary)
  clients/
    inference.ts           # feature 1 OpenAI-compatible streaming client + status
    retrieval.ts           # feature 5 client (per-turn + memory peek)
    capture.ts             # feature 3 enqueue (fire-and-forget)
  __tests__/
    contextBudget.test.ts  # budgets fit; trimming order is correct
    promptAssembler.test.ts# segment order + top-memory edge placement
    truncate.test.ts       # verbatim/summary boundary behavior
    retrievalGate.test.ts  # trivial-vs-substantive gating

web/dashboard/chat/        # web chat panel (states, controls, memory-peek, injection chip)
menubar/popover/chat.ts    # menu-bar popover view bound to the same engine
```
