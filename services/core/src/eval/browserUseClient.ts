/**
 * Browser Use Cloud v2 client (SC3) — create+poll a task to a bounded
 * terminal outcome, hermetically testable via injected fetch/sleep/clock.
 *
 * No SDK: raw fetch, matching every other tool/client in this codebase
 * (webResearchTools.ts's makeWebSearchTool). The API key is read from
 * process.env at call time, inside runTask(), never at module scope, and is
 * placed only in the X-Browser-Use-API-Key header — never interpolated into
 * a record, an error string, or a log line (T-13.3-01).
 *
 * Credit-burn bounds (T-13.3-05):
 *   - every created task carries a maxSteps cap (BROWSER_USE_MAX_STEPS)
 *   - polling stops at BROWSER_USE_POLL_CEILING_MS and reports status:"timeout"
 *     rather than hanging
 *   - this client creates and polls exactly one task per runTask() call —
 *     sequential, single-task execution across the eval task list is
 *     enforced by the caller (the CLI in plan 13.3-03 Task 2), not here
 *   - no automatic retries on any failure path
 *
 * Self-report is not trusted (T-13.3-06): the provider's own `isSuccess`
 * flag is preserved verbatim as `providerReportedSuccess`, but `success` is
 * always decided by the shared gradeAnswer() predicate over the free-text
 * answer.
 */

import type { BrowsingEvalTask } from "./browsingTasks.js";
import { gradeAnswer } from "./browsingTasks.js";

export const BROWSER_USE_API_BASE = "https://api.browser-use.com/api/v2";
export const BROWSER_USE_MAX_STEPS = 25;
export const BROWSER_USE_POLL_INTERVAL_MS = 5_000;
export const BROWSER_USE_POLL_CEILING_MS = 300_000;
/** Per-HTTP-call AbortController backstop — not the poll ceiling above. */
export const BROWSER_USE_REQUEST_TIMEOUT_MS = 30_000;

export type BrowserUseTerminalStatus = "finished" | "failed" | "stopped";
export type BrowserUseStatus = "started" | "paused" | BrowserUseTerminalStatus;

/** Record shape both eval sides emit — plan 13.3-04 writes the Playwright
 *  side into this same shape with `path: "playwright-mcp"` and extra
 *  `approvalEvents`/`llmTurns` fields; 13.3-05's verdict table joins on it. */
export interface BrowserUseTaskRecord {
  ok: boolean;
  taskId?: string;
  /** Task lifecycle status, or "timeout" (poll ceiling hit), or "error"
   *  (a client/HTTP-level failure that never reached a lifecycle status). */
  status: BrowserUseStatus | "timeout" | "error";
  /** HTTP status code, present only on a client/HTTP-level failure. */
  httpStatus?: number;
  success: boolean;
  providerReportedSuccess: boolean | null;
  answer: string | null;
  steps: number;
  latencyMs: number;
  costUsd: number | null;
  error?: string;
  path: "browser-use";
  evalTaskId: string;
}

interface BrowserUseCreateResponse {
  id: string;
  sessionId: string;
}

interface BrowserUseGetResponse {
  status: BrowserUseStatus;
  output: string | null;
  isSuccess: boolean | null;
  /** The live API returns this as a JSON *string* (e.g. "0.006") despite the
   *  docs implying a number — confirmed by the 13.3-04 live run. Accept both;
   *  runTask() coerces via coerceCost() so records always carry a number. */
  cost: number | string | null;
  steps: unknown[];
}

export interface BrowserUseClientDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type CreateResult =
  | { ok: true; id: string; sessionId: string }
  | { ok: false; error: string; httpStatus?: number };

type PollResult = { ok: true; data: BrowserUseGetResponse } | { ok: false; error: string; httpStatus?: number };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Coerce the API's `cost` — a number, a numeric JSON string (the live v2
 *  shape, e.g. "0.006"), or anything else — to `number | null`, so
 *  BrowserUseTaskRecord.costUsd always honors its declared number|null
 *  contract and the CLI's `.toFixed()` sum can never throw (CR-01). */
function coerceCost(c: unknown): number | null {
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (typeof c === "string" && c.trim() !== "" && !Number.isNaN(Number(c))) return Number(c);
  return null;
}

function baseRecord(evalTaskId: string): Pick<BrowserUseTaskRecord, "path" | "evalTaskId"> {
  return { path: "browser-use", evalTaskId };
}

/**
 * Build a Browser Use Cloud v2 client. `fetchFn`/`sleep`/`now` are all
 * injectable so the polling state machine, terminal-status handling and
 * credit bounds are proven hermetically before a single paid task runs.
 */
export function makeBrowserUseClient(deps: BrowserUseClientDeps = {}): {
  createTask: (task: BrowsingEvalTask, apiKey: string) => Promise<CreateResult>;
  getTask: (id: string, apiKey: string) => Promise<PollResult>;
  runTask: (task: BrowsingEvalTask) => Promise<BrowserUseTaskRecord>;
} {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  async function createTask(task: BrowsingEvalTask, apiKey: string): Promise<CreateResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROWSER_USE_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${BROWSER_USE_API_BASE}/tasks`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-Browser-Use-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: task.prompt,
          maxSteps: BROWSER_USE_MAX_STEPS,
          allowedDomains: [hostnameOf(task.url)],
        }),
      });

      if (!response.ok) {
        let detail: string | undefined;
        try {
          const body = (await response.json()) as { detail?: string; error?: string };
          detail = body.detail ?? body.error;
        } catch {
          // Non-JSON error body — fall through with a generic message.
        }
        return {
          ok: false,
          httpStatus: response.status,
          error: detail
            ? `Browser Use API error: HTTP ${response.status} — ${detail}`
            : `Browser Use API error: HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as BrowserUseCreateResponse;
      return { ok: true, id: data.id, sessionId: data.sessionId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getTask(id: string, apiKey: string): Promise<PollResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BROWSER_USE_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${BROWSER_USE_API_BASE}/tasks/${id}`, {
        signal: controller.signal,
        headers: { "X-Browser-Use-API-Key": apiKey },
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, httpStatus: response.status, error: `Browser Use API error: HTTP ${response.status}` };
      }

      const data = (await response.json()) as BrowserUseGetResponse;
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runTask(task: BrowsingEvalTask): Promise<BrowserUseTaskRecord> {
    const startedAt = now();

    const apiKey = process.env["BROWSER_USE_API_KEY"];
    if (!apiKey) {
      return {
        ...baseRecord(task.id),
        ok: false,
        status: "error",
        success: false,
        providerReportedSuccess: null,
        answer: null,
        steps: 0,
        latencyMs: now() - startedAt,
        costUsd: null,
        error: "BROWSER_USE_API_KEY not set — cannot create a Browser Use Cloud task.",
      };
    }

    const created = await createTask(task, apiKey);
    if (!created.ok) {
      return {
        ...baseRecord(task.id),
        ok: false,
        status: "error",
        httpStatus: created.httpStatus,
        success: false,
        providerReportedSuccess: null,
        answer: null,
        steps: 0,
        latencyMs: now() - startedAt,
        costUsd: null,
        error: created.error,
      };
    }

    for (;;) {
      const polled = await getTask(created.id, apiKey);
      const elapsed = now() - startedAt;

      if (!polled.ok) {
        return {
          ...baseRecord(task.id),
          ok: false,
          taskId: created.id,
          status: "error",
          httpStatus: polled.httpStatus,
          success: false,
          providerReportedSuccess: null,
          answer: null,
          steps: 0,
          latencyMs: elapsed,
          costUsd: null,
          error: polled.error,
        };
      }

      const { status } = polled.data;
      if (status === "finished" || status === "failed" || status === "stopped") {
        const answer = polled.data.output ?? null;
        const success = status === "finished" ? gradeAnswer(answer, task) : false;
        return {
          ...baseRecord(task.id),
          ok: true,
          taskId: created.id,
          status,
          success,
          providerReportedSuccess: polled.data.isSuccess,
          answer,
          steps: polled.data.steps.length,
          latencyMs: elapsed,
          costUsd: coerceCost(polled.data.cost),
        };
      }

      if (elapsed >= BROWSER_USE_POLL_CEILING_MS) {
        return {
          ...baseRecord(task.id),
          ok: true,
          taskId: created.id,
          status: "timeout",
          success: false,
          providerReportedSuccess: null,
          answer: null,
          steps: 0,
          latencyMs: elapsed,
          costUsd: null,
        };
      }

      await sleep(BROWSER_USE_POLL_INTERVAL_MS);
    }
  }

  return { createTask, getTask, runTask };
}

/** Convenience: run one BROWSING_EVAL_TASKS entry end to end with a fresh client. */
export async function runBrowserUseTask(
  task: BrowsingEvalTask,
  deps: BrowserUseClientDeps = {},
): Promise<BrowserUseTaskRecord> {
  return makeBrowserUseClient(deps).runTask(task);
}
