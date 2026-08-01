/**
 * Shared browsing-eval task definitions + Browser Use Cloud v2 client tests.
 *
 * Hermetic: injected fetchFn, injected sleep/now (fake clock) — no network,
 * no real wall-clock waiting, no credentials. The Playwright-MCP side of the
 * eval (plan 13.3-04) reuses BROWSING_EVAL_TASKS and gradeAnswer() from
 * these same task definitions so both sides are graded identically.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BROWSING_EVAL_TASKS, gradeAnswer } from "../src/eval/browsingTasks.js";
import {
  makeBrowserUseClient,
  runBrowserUseTask,
  BROWSER_USE_MAX_STEPS,
} from "../src/eval/browserUseClient.js";
import { parseEvalArgs, DEFAULT_OUT_PATH } from "../src/cli/evalBrowserUse.js";

const ORIGINAL_KEY = process.env["BROWSER_USE_API_KEY"];

beforeEach(() => {
  process.env["BROWSER_USE_API_KEY"] = "test-browser-use-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env["BROWSER_USE_API_KEY"];
  else process.env["BROWSER_USE_API_KEY"] = ORIGINAL_KEY;
});

// ── fakes ────────────────────────────────────────────────────────────────────

interface RequestLog {
  url: string;
  init?: RequestInit;
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function createResponse(id = "task-1", sessionId = "session-1"): Response {
  return new Response(JSON.stringify({ id, sessionId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function pollResponse(body: {
  status: "started" | "paused" | "finished" | "failed" | "stopped";
  output?: string | null;
  isSuccess?: boolean | null;
  cost?: number | string | null;
  steps?: unknown[];
}): Response {
  return new Response(
    JSON.stringify({
      status: body.status,
      output: body.output ?? null,
      isSuccess: body.isSuccess ?? null,
      cost: body.cost ?? null,
      steps: body.steps ?? [],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Fake clock: sleep() advances the shared "now" value; no real wall-clock wait. */
function makeFakeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Routes POST (create) vs GET (poll) calls to different fake responses. */
function fakeFetchRouter(
  onCreate: (url: string, init?: RequestInit) => Response | Promise<Response>,
  onPoll: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return fakeFetch((url, init) => {
    const method = init?.method ?? "GET";
    return method === "POST" ? onCreate(url, init) : onPoll(url, init);
  });
}

const TASK_E1 = BROWSING_EVAL_TASKS.find((t) => t.id === "e1-js-extract")!;
const TASK_E2 = BROWSING_EVAL_TASKS.find((t) => t.id === "e2-multi-step-nav")!;
const TASK_E3 = BROWSING_EVAL_TASKS.find((t) => t.id === "e3-interaction")!;

// ── BROWSING_EVAL_TASKS + gradeAnswer ───────────────────────────────────────

describe("BROWSING_EVAL_TASKS", () => {
  it("has exactly 3 entries with the required ids", () => {
    expect(BROWSING_EVAL_TASKS).toHaveLength(3);
    expect(BROWSING_EVAL_TASKS.map((t) => t.id).sort()).toEqual(
      ["e1-js-extract", "e2-multi-step-nav", "e3-interaction"].sort(),
    );
  });

  it("every task has a non-empty prompt, url and expectedContains", () => {
    for (const task of BROWSING_EVAL_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(task.url.length).toBeGreaterThan(0);
      expect(task.expectedContains.length).toBeGreaterThan(0);
    }
  });

  it("requiresInteraction is true only for e3-interaction", () => {
    for (const task of BROWSING_EVAL_TASKS) {
      expect(task.requiresInteraction).toBe(task.id === "e3-interaction");
    }
  });
});

describe("gradeAnswer", () => {
  it("is case-insensitive and whitespace-tolerant with surrounding prose", () => {
    expect(gradeAnswer("The author is ALBERT   Einstein, apparently.", TASK_E1)).toBe(true);
    expect(gradeAnswer("albert einstein", TASK_E1)).toBe(true);
  });

  it("returns false for an empty or null/undefined answer", () => {
    expect(gradeAnswer("", TASK_E1)).toBe(false);
    expect(gradeAnswer(null, TASK_E1)).toBe(false);
    expect(gradeAnswer(undefined, TASK_E1)).toBe(false);
  });

  it("returns false for an answer that omits the expected string", () => {
    expect(gradeAnswer("The author is Mark Twain.", TASK_E1)).toBe(false);
  });
});

// ── runBrowserUseTask / makeBrowserUseClient ────────────────────────────────

describe("runBrowserUseTask — create", () => {
  it("POSTs with the API key header, prompt, numeric maxSteps and allowedDomains hostname; no secret-bearing field", async () => {
    const calls: RequestLog[] = [];
    const fetchFn = fakeFetchRouter(
      (url, init) => {
        calls.push({ url, init });
        return createResponse();
      },
      () =>
        pollResponse({ status: "finished", output: "Albert Einstein", isSuccess: true, cost: 0.01, steps: [{}] }),
    );

    await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.browser-use.com/api/v2/tasks");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Browser-Use-API-Key"]).toBe("test-browser-use-key");
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body["task"]).toBe(TASK_E1.prompt);
    expect(typeof body["maxSteps"]).toBe("number");
    expect(body["allowedDomains"]).toEqual([new URL(TASK_E1.url).hostname]);
    expect(Object.prototype.hasOwnProperty.call(body, "secrets")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "structuredOutput")).toBe(false);
  });
});

describe("runBrowserUseTask — poll to terminal", () => {
  it("polls started, started, finished and returns a graded success record", async () => {
    let pollCount = 0;
    const fetchFn = fakeFetchRouter(
      () => createResponse("task-abc", "session-abc"),
      () => {
        pollCount++;
        if (pollCount < 3) return pollResponse({ status: "started" });
        return pollResponse({
          status: "finished",
          output: "The author is Albert Einstein.",
          isSuccess: true,
          cost: 0.043,
          steps: [{}, {}, {}],
        });
      },
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(true);
    expect(record.status).toBe("finished");
    expect(record.success).toBe(true);
    expect(record.steps).toBe(3);
    expect(record.costUsd).toBe(0.043);
    expect(typeof record.latencyMs).toBe("number");
    expect(record.answer).toBe("The author is Albert Einstein.");
    expect(record.taskId).toBe("task-abc");
  });

  it.each(["failed", "stopped"] as const)(
    "terminal status %s yields ok:true, success:false, no throw",
    async (status) => {
      const fetchFn = fakeFetchRouter(
        () => createResponse(),
        () => pollResponse({ status }),
      );

      const record = await runBrowserUseTask(TASK_E2, { fetchFn, sleep: async () => {} });

      expect(record.ok).toBe(true);
      expect(record.status).toBe(status);
      expect(record.success).toBe(false);
    },
  );

  it("coerces a string cost from the live API (CR-01 regression) to a number in costUsd", async () => {
    // The live Browser Use v2 API returns cost as a JSON STRING (e.g. "0.006")
    // — confirmed by the committed 13.3-eval-browseruse.json artifact. A string
    // costUsd string-concatenates in the CLI's reduce() and then crashes
    // `.toFixed()` AFTER paid tasks complete, losing every record.
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () =>
        pollResponse({
          status: "finished",
          output: "The author is Albert Einstein.",
          isSuccess: true,
          cost: "0.043",
          steps: [{}],
        }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.costUsd).toBe(0.043);
    expect(typeof record.costUsd).toBe("number");
  });

  it("degrades a non-numeric string cost to null rather than NaN or a string", async () => {
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () => pollResponse({ status: "finished", output: "x", isSuccess: false, cost: "free??", steps: [] }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.costUsd).toBeNull();
  });

  it("grading beats self-report: isSuccess true but output lacks the expected string yields success:false", async () => {
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () =>
        pollResponse({
          status: "finished",
          output: "I looked at the page but found nothing relevant.",
          isSuccess: true,
          cost: 0.02,
          steps: [{}],
        }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.success).toBe(false);
    expect(record.providerReportedSuccess).toBe(true);
  });
});

describe("runBrowserUseTask — poll shape drift (WR-02)", () => {
  it("tolerates a terminal poll response missing steps/output/isSuccess/cost without throwing", async () => {
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () =>
        new Response(JSON.stringify({ status: "finished" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(true);
    expect(record.status).toBe("finished");
    expect(record.steps).toBe(0);
    expect(record.answer).toBeNull();
    expect(record.providerReportedSuccess).toBeNull();
    expect(record.costUsd).toBeNull();
    expect(record.success).toBe(false);
  });

  it("tolerates steps arriving as a non-array", async () => {
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () =>
        new Response(JSON.stringify({ status: "finished", output: "x", steps: 7 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(true);
    expect(record.steps).toBe(0);
  });

  it("a poll body of JSON null becomes a structured error record, never a rejection (degrade-never-throw backstop)", async () => {
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(false);
    expect(record.status).toBe("error");
    expect(record.error).toContain("Unexpected client error");
  });
});

describe("runBrowserUseTask — poll bound (timeout)", () => {
  it("stops at the poll ceiling and returns status:timeout without hanging or throwing", async () => {
    const clock = makeFakeClock();
    const fetchFn = fakeFetchRouter(
      () => createResponse(),
      () => pollResponse({ status: "started" }),
    );

    const record = await runBrowserUseTask(TASK_E3, {
      fetchFn,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(record.ok).toBe(true);
    expect(record.status).toBe("timeout");
    expect(record.success).toBe(false);
  });
});

describe("runBrowserUseTask — step bound", () => {
  it("caps maxSteps at the exported BROWSER_USE_MAX_STEPS constant, which is at most 25", async () => {
    expect(BROWSER_USE_MAX_STEPS).toBeGreaterThan(0);
    expect(BROWSER_USE_MAX_STEPS).toBeLessThanOrEqual(25);

    let sentMaxSteps: number | undefined;
    const fetchFn = fakeFetchRouter(
      (_url, init) => {
        sentMaxSteps = (JSON.parse(String(init?.body)) as { maxSteps: number }).maxSteps;
        return createResponse();
      },
      () => pollResponse({ status: "finished", output: "x", isSuccess: false, cost: 0, steps: [] }),
    );

    await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(sentMaxSteps).toBe(BROWSER_USE_MAX_STEPS);
  });
});

describe("runBrowserUseTask — missing key", () => {
  it("returns ok:false without calling fetch when BROWSER_USE_API_KEY is unset", async () => {
    delete process.env["BROWSER_USE_API_KEY"];
    let called = false;
    const fetchFn = fakeFetch(() => {
      called = true;
      return createResponse();
    });

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(false);
    expect(record.error).toContain("BROWSER_USE_API_KEY");
    expect(called).toBe(false);
  });
});

describe("runBrowserUseTask — HTTP errors", () => {
  it("401 with the live-verified detail body yields ok:false with the HTTP status echoed, no throw", async () => {
    const fetchFn = fakeFetchRouter(
      () =>
        new Response(JSON.stringify({ detail: "X-Browser-Use-API-Key header is required" }), { status: 401 }),
      () => pollResponse({ status: "started" }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(false);
    expect(record.httpStatus).toBe(401);
  });

  it("429 yields ok:false with the HTTP status echoed, no throw", async () => {
    const fetchFn = fakeFetchRouter(
      () => new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }),
      () => pollResponse({ status: "started" }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(false);
    expect(record.httpStatus).toBe(429);
  });
});

describe("runBrowserUseTask — network/parse failures", () => {
  it("network throw on create yields ok:false rather than rejecting", async () => {
    const fetchFn = fakeFetch(() => {
      throw new Error("network down");
    });

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(false);
    expect(record.error).toContain("network down");
  });

  it("non-JSON create response body yields ok:false rather than rejecting", async () => {
    const fetchFn = fakeFetchRouter(
      () => new Response("not json", { status: 200 }),
      () => pollResponse({ status: "started" }),
    );

    const record = await runBrowserUseTask(TASK_E1, { fetchFn, sleep: async () => {} });

    expect(record.ok).toBe(false);
  });
});

describe("runBrowserUseTask — key never leaks", () => {
  it("the sentinel key never appears in the record across 401, 429, network-throw and timeout paths", async () => {
    process.env["BROWSER_USE_API_KEY"] = "bu-SENTINEL-must-not-leak";
    const clock = makeFakeClock();

    const cases: Array<() => Promise<unknown>> = [
      () =>
        runBrowserUseTask(TASK_E1, {
          fetchFn: fakeFetchRouter(
            () => new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 }),
            () => pollResponse({ status: "started" }),
          ),
          sleep: async () => {},
        }),
      () =>
        runBrowserUseTask(TASK_E1, {
          fetchFn: fakeFetchRouter(
            () => new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }),
            () => pollResponse({ status: "started" }),
          ),
          sleep: async () => {},
        }),
      () =>
        runBrowserUseTask(TASK_E1, {
          fetchFn: fakeFetch(() => {
            throw new Error("network down");
          }),
          sleep: async () => {},
        }),
      () =>
        runBrowserUseTask(TASK_E1, {
          fetchFn: fakeFetchRouter(
            () => createResponse(),
            () => pollResponse({ status: "started" }),
          ),
          sleep: clock.sleep,
          now: clock.now,
        }),
    ];

    for (const run of cases) {
      const record = await run();
      expect(JSON.stringify(record)).not.toContain("bu-SENTINEL-must-not-leak");
    }
  });
});

// ── makeBrowserUseClient primitives ─────────────────────────────────────────

describe("makeBrowserUseClient", () => {
  it("exposes createTask/getTask/runTask", () => {
    const client = makeBrowserUseClient();
    expect(typeof client.createTask).toBe("function");
    expect(typeof client.getTask).toBe("function");
    expect(typeof client.runTask).toBe("function");
  });
});

// ── evalBrowserUse.ts CLI arg parsing (Task 2) ──────────────────────────────
// Only parseEvalArgs is exercised here — the CLI's main body (dry-run/live
// run) is guarded behind an entrypoint check and is never invoked on import.

describe("parseEvalArgs", () => {
  it("defaults to all three task ids, no dry-run, no help, the default --out path", () => {
    const args = parseEvalArgs([]);
    expect(args.taskIds).toEqual(BROWSING_EVAL_TASKS.map((t) => t.id));
    expect(args.dryRun).toBe(false);
    expect(args.help).toBe(false);
    expect(args.out).toBe(DEFAULT_OUT_PATH);
  });

  it("--task e2-multi-step-nav selects exactly that one task", () => {
    const args = parseEvalArgs(["--task", "e2-multi-step-nav"]);
    expect(args.taskIds).toEqual(["e2-multi-step-nav"]);
  });

  it("rejects an unknown --task id with a message naming the valid ids", () => {
    expect(() => parseEvalArgs(["--task", "does-not-exist"])).toThrow(/e1-js-extract/);
    expect(() => parseEvalArgs(["--task", "does-not-exist"])).toThrow(/e2-multi-step-nav/);
    expect(() => parseEvalArgs(["--task", "does-not-exist"])).toThrow(/e3-interaction/);
  });

  it("--dry-run sets the flag", () => {
    expect(parseEvalArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("--out overrides the default output path", () => {
    expect(parseEvalArgs(["--out", "/tmp/custom-eval.json"]).out).toBe("/tmp/custom-eval.json");
  });

  it("--help sets the flag", () => {
    expect(parseEvalArgs(["--help"]).help).toBe(true);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseEvalArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});
