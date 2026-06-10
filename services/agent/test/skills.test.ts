/**
 * Tests for skills (feature 18).
 *
 * Covers:
 *   - emailTriage: drafts + requires approval before send; skips on reject
 *   - webResearch: read-only, no approval needed; citation verification
 *   - reminders: creates todos, deduplicates
 *   - calendarSkill: find-time is read-only; schedule requires approval
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emailTriageSkill } from "../src/skills/emailTriage.js";
import { webResearchSkill, verifyCitations } from "../src/skills/webResearch.js";
import { remindersSkill } from "../src/skills/reminders.js";
import { calendarSkill } from "../src/skills/calendarSkill.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { ApprovalService } from "../src/safety/approval.js";
import { AuditLog } from "../src/safety/audit.js";
import { registerToolMeta } from "../src/safety/policy.js";
import {
  FakeLlm,
  FakeSearchThreadsTool,
  FakeGetThreadTool,
  FakeLabelThreadTool,
  FakeSendEmailTool,
  FakeCalendarFreeBusyTool,
  FakeCalendarCreateTool,
  FakeWebSearchTool,
  FakeWebFetchTool,
  FakeTodoCreateTool,
  FakeTodoListTool,
  FakeTodoCompleteTool,
  makeToolRegistry,
  makeAutoApproveSink,
  makeAutoRejectSink,
  ManualApprovalSink,
  FixedClock,
} from "../src/testing/fakes.js";
import type { SkillCtx } from "../src/skills/registry.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "skills-test-"));
}

function makeCtx(
  tools: ReturnType<typeof makeToolRegistry>,
  llm: FakeLlm,
  approvalService: ApprovalService,
  auditLog: AuditLog,
  clock: FixedClock,
): SkillCtx {
  const registry = new SkillRegistry();
  return registry.makeCtx(tools, llm, approvalService, auditLog, clock);
}

describe("emailTriage skill", () => {
  let tmpDir: string;
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("triages threads, labels them, and requests approval before send", async () => {
    tmpDir = makeTempDir();
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const searchThreads = new FakeSearchThreadsTool();
    searchThreads.returnIds = ["t-1", "t-2"];
    const getThread = new FakeGetThreadTool();
    const labelThread = new FakeLabelThreadTool();
    const sendEmail = new FakeSendEmailTool();

    const tools = makeToolRegistry([searchThreads, getThread, labelThread, sendEmail]);

    const llm = new FakeLlm();
    // Return needs_reply with draft for t-1, fyi for t-2
    llm.addResponse(
      JSON.stringify({
        category: "needs_reply",
        summary: "Alice wants a meeting",
        draft: { to: ["alice@test.com"], subject: "Re: Meeting", body: "Hi Alice, works for me!" },
      }),
    );
    llm.addResponse(
      JSON.stringify({
        category: "fyi",
        summary: "Newsletter",
        draft: null,
      }),
    );

    const { sink, requests } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await emailTriageSkill.run({ window: "newer_than:1d" }, ctx);

    expect(result.status).toBe("ok");
    expect(result.artifacts.length).toBe(2);
    // The send requires approval
    expect(requests.length).toBeGreaterThan(0);
  });

  it("skips send when approval is rejected", async () => {
    tmpDir = makeTempDir();
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const searchThreads = new FakeSearchThreadsTool();
    searchThreads.returnIds = ["t-1"];
    const tools = makeToolRegistry([
      searchThreads,
      new FakeGetThreadTool(),
      new FakeLabelThreadTool(),
      new FakeSendEmailTool(),
    ]);

    const llm = new FakeLlm();
    llm.addResponse(
      JSON.stringify({
        category: "needs_reply",
        summary: "Needs a reply",
        draft: { to: ["bob@test.com"], subject: "Re: Topic", body: "Reply body" },
      }),
    );

    const { sink } = makeAutoRejectSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await emailTriageSkill.run({ window: "newer_than:1d" }, ctx);

    expect(result.status).toBe("ok");
    const sendAction = result.actions.find((a) => a.type === "email.send");
    expect(sendAction?.status).toBe("skipped");
  });
});

describe("webResearch skill", () => {
  let tmpDir: string;
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("is read-only: no approval requests", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([
      new FakeWebSearchTool(),
      new FakeWebFetchTool(),
    ]);

    const llm = new FakeLlm();
    // Synthesis with valid citation [1]
    llm.addResponse("TypeScript is a superset of JavaScript. [1]");

    const { sink, requests } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await webResearchSkill.run({ query: "TypeScript" }, ctx);

    expect(result.status).toBe("ok");
    expect(requests.length).toBe(0); // read-only, no approval
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it("flags unresolved citations", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([
      new FakeWebSearchTool(),
      new FakeWebFetchTool(),
    ]);

    const llm = new FakeLlm();
    // Citation [99] doesn't map to any source
    llm.addResponse("Some fact according to [99].");

    const { sink } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await webResearchSkill.run({ query: "something", maxSources: 2 }, ctx);

    // Should flag unresolved
    const research = result.artifacts[0] as { unresolved?: boolean };
    expect(research.unresolved).toBe(true);
  });

  it("verifyCitations unit test", () => {
    const sources = [
      { url: "a.com", title: "A", text: "text", fetchedAt: "2024" },
      { url: "b.com", title: "B", text: "text", fetchedAt: "2024" },
    ];

    expect(verifyCitations("Fact [1] and [2] are true.", sources)).toEqual([]);
    expect(verifyCitations("Fact [1] and [3] are true.", sources)).toEqual([3]);
    expect(verifyCitations("No citations here.", sources)).toEqual([]);
  });
});

describe("reminders skill", () => {
  let tmpDir: string;
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("creates a todo (no approval needed)", async () => {
    tmpDir = makeTempDir();
    registerToolMeta("todo_create", { sideEffects: "internal_write", reversible: true });

    const createTool = new FakeTodoCreateTool();
    const listTool = new FakeTodoListTool();
    listTool.todos = []; // empty → no duplicates

    const tools = makeToolRegistry([createTool, listTool]);
    const llm = new FakeLlm();
    const { sink, requests } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await remindersSkill.run(
      { action: "create", text: "Renew car insurance", due: "2024-06-01" },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(createTool.todos.length).toBe(1);
    expect(createTool.todos[0]!.title).toBe("Renew car insurance");
    expect(requests.length).toBe(0); // no approval needed for local store
  });

  it("deduplicates: skips if similar reminder exists", async () => {
    tmpDir = makeTempDir();

    const createTool = new FakeTodoCreateTool();
    const listTool = new FakeTodoListTool();
    listTool.todos = [
      { id: "existing-1", title: "Renew car insurance", due: "2024-06-01" },
    ];

    const tools = makeToolRegistry([createTool, listTool]);
    const llm = new FakeLlm();
    const { sink } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await remindersSkill.run(
      { action: "create", text: "Renew car insurance" },
      ctx,
    );

    expect(result.status).toBe("ok");
    // Duplicate detected: no new todo created
    expect(createTool.todos.length).toBe(0);
    const action = result.actions.find((a) => a.type === "todo.create");
    expect(action?.status).toBe("skipped");
    expect(action?.reason).toBe("duplicate");
  });
});

describe("calendar skill", () => {
  let tmpDir: string;
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("find_time is read-only, no approval needed", async () => {
    tmpDir = makeTempDir();
    registerToolMeta("calendar_free_busy", { sideEffects: "read_only", reversible: true });

    const tools = makeToolRegistry([new FakeCalendarFreeBusyTool()]);
    const llm = new FakeLlm();
    const { sink, requests } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await calendarSkill.run(
      {
        action: "find_time",
        duration_minutes: 30,
        window_start: new Date(Date.now()).toISOString(),
        window_end: new Date(Date.now() + 86400000).toISOString(),
      },
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(requests.length).toBe(0);
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it("schedule requires approval", async () => {
    tmpDir = makeTempDir();
    registerToolMeta("calendar_create_event", {
      sideEffects: "calendar_write",
      reversible: true,
    });

    const createTool = new FakeCalendarCreateTool();
    const tools = makeToolRegistry([createTool]);

    const llm = new FakeLlm();
    const { sink, requests } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const approvalService = new ApprovalService(sink, clock);
    const ctx = makeCtx(tools, llm, approvalService, auditLog, clock);

    const result = await calendarSkill.run(
      {
        action: "schedule",
        title: "Team standup",
        start: new Date(Date.now() + 3600000).toISOString(),
        end: new Date(Date.now() + 5400000).toISOString(),
      },
      ctx,
    );

    expect(result.status).toBe("ok");
    // An approval request was created
    expect(requests.length).toBeGreaterThan(0);
    expect(createTool.createdEvents.length).toBe(1);
  });
});
