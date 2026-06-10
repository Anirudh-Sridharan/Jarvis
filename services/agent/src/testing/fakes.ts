/**
 * Deterministic test fakes for @jarvis/agent.
 *
 * Exported from `@jarvis/agent/testing`.
 *
 * FakeLlm:
 *   - Scripted tool-call sequence. Each call pops the next response.
 *   - Supports: invalid JSON (to exercise harness retry), valid tool call,
 *     final __done__ answer.
 *   - Configurable via addResponse() or setScript().
 *
 * FakeTool (read-only `search`):
 *   - Returns deterministic search results. readOnly: true → auto-allow.
 *
 * FakeSendEmailTool (side-effecting `send_email`):
 *   - Records calls. readOnly: false → approval required.
 *
 * FixedClock:
 *   - Deterministic wall-clock for tests.
 *
 * makeApprovalSink:
 *   - Returns an ApprovalSink that auto-approves or auto-rejects based on config.
 *   - Also records all requests received.
 */

import { z } from "zod";
import type {
  LlmClient,
  Tool,
  ToolRegistry,
  Clock,
  ApprovalSink,
  ApprovalRequest,
  ApprovalDecision,
} from "../types.js";

// ── FakeLlm ──────────────────────────────────────────────────────────────────

export class FakeLlm implements LlmClient {
  private responses: string[] = [];
  private defaultResponse = '{"tool": "__done__", "args": {"result": "done"}}';
  callLog: string[] = [];

  /** Add responses in order; they are consumed FIFO. */
  addResponse(r: string): this {
    this.responses.push(r);
    return this;
  }

  /** Set a full script (replaces existing queue). */
  setScript(responses: string[]): this {
    this.responses = [...responses];
    return this;
  }

  setDefault(r: string): this {
    this.defaultResponse = r;
    return this;
  }

  async complete(opts: { prompt: string; system?: string; json?: boolean }): Promise<string> {
    this.callLog.push(opts.prompt);
    const response = this.responses.shift() ?? this.defaultResponse;
    return response;
  }
}

// ── FakeTool: read-only search ────────────────────────────────────────────────

const SearchSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().min(1).max(20).optional().default(5),
});

export class FakeSearchTool implements Tool {
  readonly name = "search";
  readonly description = "Search for information (read-only)";
  readonly schema = SearchSchema;
  readonly readOnly = true;
  callLog: Array<{ query: string; maxResults?: number }> = [];

  async run(args: unknown): Promise<unknown> {
    const { query, maxResults } = SearchSchema.parse(args);
    this.callLog.push({ query, maxResults });
    return [
      { title: "Result 1", url: "https://example.com/1", snippet: `About ${query}` },
      { title: "Result 2", url: "https://example.com/2", snippet: `More about ${query}` },
    ].slice(0, maxResults ?? 5);
  }
}

// ── FakeTool: side-effecting send_email ──────────────────────────────────────

const SendEmailSchema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  body: z.string(),
  threadId: z.string().optional(),
});

export class FakeSendEmailTool implements Tool {
  readonly name = "send_email";
  readonly description = "Send an email (side-effecting, requires approval)";
  readonly schema = SendEmailSchema;
  readonly readOnly = false;
  sentEmails: Array<z.infer<typeof SendEmailSchema>> = [];

  async run(args: unknown): Promise<unknown> {
    const parsed = SendEmailSchema.parse(args);
    this.sentEmails.push(parsed);
    return { messageId: `msg-${Date.now()}`, status: "sent" };
  }
}

// ── FakeTools: search + label_thread + get_thread + search_threads + send_email

const SearchThreadsSchema = z.object({
  q: z.string(),
});

export class FakeSearchThreadsTool implements Tool {
  readonly name = "search_threads";
  readonly description = "Search email threads";
  readonly schema = SearchThreadsSchema;
  readonly readOnly = true;
  callLog: string[] = [];
  returnIds: string[] = ["thread-1", "thread-2", "thread-3"];

  async run(args: unknown): Promise<unknown> {
    const { q } = SearchThreadsSchema.parse(args);
    this.callLog.push(q);
    return this.returnIds;
  }
}

const GetThreadSchema = z.object({ id: z.string() });

export class FakeGetThreadTool implements Tool {
  readonly name = "get_thread";
  readonly description = "Get email thread content";
  readonly schema = GetThreadSchema;
  readonly readOnly = true;

  async run(args: unknown): Promise<unknown> {
    const { id } = GetThreadSchema.parse(args);
    return {
      id,
      subject: `Subject for ${id}`,
      from: "sender@example.com",
      body: `Body of thread ${id}. Please reply.`,
    };
  }
}

const LabelThreadSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export class FakeLabelThreadTool implements Tool {
  readonly name = "label_thread";
  readonly description = "Apply a label to an email thread";
  readonly schema = LabelThreadSchema;
  readonly readOnly = true;
  labelLog: Array<{ id: string; label: string }> = [];

  async run(args: unknown): Promise<unknown> {
    const parsed = LabelThreadSchema.parse(args);
    this.labelLog.push(parsed);
    return { ok: true };
  }
}

// ── Fake calendar tools ───────────────────────────────────────────────────────

const FreeBusySchema = z.object({
  window_start: z.string(),
  window_end: z.string(),
  duration_minutes: z.number(),
  attendees: z.array(z.string()).optional(),
  timezone: z.string().optional(),
});

export class FakeCalendarFreeBusyTool implements Tool {
  readonly name = "calendar_free_busy";
  readonly description = "Query free/busy calendar slots";
  readonly schema = FreeBusySchema;
  readonly readOnly = true;

  async run(args: unknown): Promise<unknown> {
    const { window_start, duration_minutes } = FreeBusySchema.parse(args);
    return [
      {
        start: new Date(window_start).toISOString(),
        end: new Date(new Date(window_start).getTime() + duration_minutes * 60000).toISOString(),
        available: true,
      },
    ];
  }
}

const CreateEventSchema = z.object({
  title: z.string(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.string()).optional(),
});

export class FakeCalendarCreateTool implements Tool {
  readonly name = "calendar_create_event";
  readonly description = "Create a calendar event";
  readonly schema = CreateEventSchema;
  readonly readOnly = false;
  createdEvents: z.infer<typeof CreateEventSchema>[] = [];

  async run(args: unknown): Promise<unknown> {
    const parsed = CreateEventSchema.parse(args);
    this.createdEvents.push(parsed);
    return { eventId: `evt-${Date.now()}`, status: "created" };
  }
}

const DeleteEventSchema = z.object({ eventId: z.string() });

export class FakeCalendarDeleteTool implements Tool {
  readonly name = "calendar_delete_event";
  readonly description = "Delete a calendar event";
  readonly schema = DeleteEventSchema;
  readonly readOnly = false;
  deletedIds: string[] = [];

  async run(args: unknown): Promise<unknown> {
    const { eventId } = DeleteEventSchema.parse(args);
    this.deletedIds.push(eventId);
    return { ok: true };
  }
}

// ── Fake todo tools ───────────────────────────────────────────────────────────

const TodoCreateSchema = z.object({
  title: z.string(),
  due: z.string().optional(),
  recurrence: z.string().optional(),
  createdAt: z.string().optional(),
});

export class FakeTodoCreateTool implements Tool {
  readonly name = "todo_create";
  readonly description = "Create a todo item";
  readonly schema = TodoCreateSchema;
  readonly readOnly = false;
  todos: z.infer<typeof TodoCreateSchema>[] = [];

  async run(args: unknown): Promise<unknown> {
    const parsed = TodoCreateSchema.parse(args);
    this.todos.push(parsed);
    return { id: `todo-${Date.now()}`, ...parsed };
  }
}

const TodoListSchema = z.object({
  filter: z.enum(["all", "overdue", "today"]).optional(),
});

export class FakeTodoListTool implements Tool {
  readonly name = "todo_list";
  readonly description = "List todos";
  readonly schema = TodoListSchema;
  readonly readOnly = true;
  todos: Array<{ id: string; title: string; due?: string }> = [];

  async run(args: unknown): Promise<unknown> {
    TodoListSchema.parse(args);
    return this.todos;
  }
}

const TodoCompleteSchema = z.object({ id: z.string() });

export class FakeTodoCompleteTool implements Tool {
  readonly name = "todo_complete";
  readonly description = "Mark a todo complete";
  readonly schema = TodoCompleteSchema;
  readonly readOnly = false;
  completedIds: string[] = [];

  async run(args: unknown): Promise<unknown> {
    const { id } = TodoCompleteSchema.parse(args);
    this.completedIds.push(id);
    return { ok: true };
  }
}

// ── Fake web tools ─────────────────────────────────────────────────────────────

const WebSearchSchema = z.object({
  query: z.string(),
  maxResults: z.number().optional(),
});

export class FakeWebSearchTool implements Tool {
  readonly name = "web_search";
  readonly description = "Search the web";
  readonly schema = WebSearchSchema;
  readonly readOnly = true;

  async run(args: unknown): Promise<unknown> {
    const { query } = WebSearchSchema.parse(args);
    return [
      { url: "https://example.com/a", title: "Source A", snippet: `Info about ${query}` },
      { url: "https://example.com/b", title: "Source B", snippet: `More about ${query}` },
    ];
  }
}

const WebFetchSchema = z.object({ url: z.string().url() });

export class FakeWebFetchTool implements Tool {
  readonly name = "web_fetch";
  readonly description = "Fetch a web page";
  readonly schema = WebFetchSchema;
  readonly readOnly = true;

  async run(args: unknown): Promise<unknown> {
    const { url } = WebFetchSchema.parse(args);
    return `Content from ${url}: Some relevant information about the topic [1].`;
  }
}

// ── FixedClock ────────────────────────────────────────────────────────────────

export class FixedClock implements Clock {
  private ms: number;

  constructor(epochMs: number = Date.now()) {
    this.ms = epochMs;
  }

  now(): number {
    return this.ms;
  }

  isoNow(): string {
    return new Date(this.ms).toISOString();
  }

  /** Advance clock by delta ms. */
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }

  /** Set clock to a specific time. */
  set(epochMs: number): void {
    this.ms = epochMs;
  }
}

// ── ApprovalSink factories ─────────────────────────────────────────────────────

export interface ApprovalSinkRecorder {
  sink: ApprovalSink;
  requests: ApprovalRequest[];
  decisions: ApprovalDecision[];
}

/**
 * Auto-approving sink. Records all requests and immediately resolves them approved.
 */
export function makeAutoApproveSink(
  byUser = "test-user",
): ApprovalSinkRecorder {
  const requests: ApprovalRequest[] = [];
  const decisions: ApprovalDecision[] = [];

  const sink: ApprovalSink = async (request) => {
    requests.push(request);
    const decision: ApprovalDecision = {
      requestId: request.id,
      status: "approved",
      byUser,
    };
    decisions.push(decision);
    return decision;
  };

  return { sink, requests, decisions };
}

/**
 * Auto-rejecting sink.
 */
export function makeAutoRejectSink(
  byUser = "test-user",
): ApprovalSinkRecorder {
  const requests: ApprovalRequest[] = [];
  const decisions: ApprovalDecision[] = [];

  const sink: ApprovalSink = async (request) => {
    requests.push(request);
    const decision: ApprovalDecision = {
      requestId: request.id,
      status: "rejected",
      byUser,
    };
    decisions.push(decision);
    return decision;
  };

  return { sink, requests, decisions };
}

/**
 * Manual sink: records requests but doesn't auto-resolve.
 * Tests can call resolve(requestId, decision) to unblock.
 */
export class ManualApprovalSink {
  requests: ApprovalRequest[] = [];
  private pending = new Map<
    string,
    (d: ApprovalDecision) => void
  >();

  readonly sink: ApprovalSink = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.pending.set(request.id, resolve);
    });
  };

  resolve(requestId: string, decision: ApprovalDecision): void {
    const resolve = this.pending.get(requestId);
    if (resolve) {
      this.pending.delete(requestId);
      resolve(decision);
    }
  }

  approve(requestId: string, byUser = "test-user"): void {
    this.resolve(requestId, { requestId, status: "approved", byUser });
  }

  reject(requestId: string, byUser = "test-user"): void {
    this.resolve(requestId, { requestId, status: "rejected", byUser });
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// ── makeToolRegistry helper ─────────────────────────────────────────────────

export function makeToolRegistry(tools: Tool[]): ToolRegistry {
  return new Map(tools.map((t) => [t.name, t]));
}
