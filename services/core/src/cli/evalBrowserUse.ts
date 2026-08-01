/**
 * Browser Use Cloud eval CLI (SC3) — re-runnable, one command, writes JSON.
 *
 *   npm run eval:browser-use -- --dry-run          # offline: prints tasks + request bodies, creates nothing
 *   npm run eval:browser-use -- --task e1-js-extract
 *   npm run eval:browser-use --                     # all three tasks, sequentially
 *
 * Tasks always run one at a time, awaited in order, not batched concurrently
 * — concurrent cloud tasks multiply the credit burn and muddy the latency
 * numbers (13.3-CONTEXT.md D-03/D-09). A task that fails or times out is
 * data, not a CLI error: the process only exits non-zero if the output JSON
 * itself could not be written. Never prints the API key or any header
 * value — --dry-run shows header NAMES only.
 */
import "../loadEnv.js"; // MUST be first: populates process.env from .env
// ^ This side effect is why tests import evalBrowserUseArgs.ts, never this
//   module — importing this file loads the developer's real .env (WR-03).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSING_EVAL_TASKS, type BrowsingEvalTask } from "../eval/browsingTasks.js";
import {
  BROWSER_USE_API_BASE,
  BROWSER_USE_MAX_STEPS,
  runBrowserUseTask,
  type BrowserUseTaskRecord,
} from "../eval/browserUseClient.js";
import { DEFAULT_OUT_PATH, VALID_TASK_IDS, parseEvalArgs, type EvalArgs } from "./evalBrowserUseArgs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// services/core/src/cli -> src -> core -> services -> <repo root>
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

function usage(): void {
  console.log(
    [
      "Usage: npm run eval:browser-use -- [options]",
      "",
      `  --task <id>     run a single task (default: all ${VALID_TASK_IDS.length}, sequentially)`,
      `                  ids: ${VALID_TASK_IDS.join(", ")}`,
      "  --out <path>    where to write the JSON record array",
      `                  (default: ${DEFAULT_OUT_PATH})`,
      "  --dry-run       print task definitions + request bodies, create nothing (no API key required)",
      "  --help          show this message",
    ].join("\n"),
  );
}

/** Header NAMES only — never a value, live key or otherwise. */
function requestPreview(task: BrowsingEvalTask): {
  method: string;
  url: string;
  headerNames: string[];
  body: Record<string, unknown>;
} {
  return {
    method: "POST",
    url: `${BROWSER_USE_API_BASE}/tasks`,
    headerNames: ["X-Browser-Use-API-Key", "Content-Type"],
    body: {
      task: task.prompt,
      maxSteps: BROWSER_USE_MAX_STEPS,
      allowedDomains: [new URL(task.url).hostname],
    },
  };
}

function runDryRun(tasks: BrowsingEvalTask[]): void {
  console.log(`Dry run — ${tasks.length} task(s), nothing will be created.\n`);
  for (const task of tasks) {
    const preview = requestPreview(task);
    console.log(`[${task.id}]`);
    console.log(`  ${preview.method} ${preview.url}`);
    console.log(`  headers: ${preview.headerNames.join(", ")}`);
    console.log(`  body: ${JSON.stringify(preview.body)}`);
    console.log();
  }
}

async function runLive(tasks: BrowsingEvalTask[], outArg: string): Promise<void> {
  const records: BrowserUseTaskRecord[] = [];

  // Sequential on purpose — awaited one at a time, never batched concurrently (credit-burn bound, D-09).
  for (const task of tasks) {
    console.log(`Running ${task.id}…`);
    const record = await runBrowserUseTask(task);
    records.push(record);
    console.log(
      `  ${task.id}: status=${record.status} success=${record.success} steps=${record.steps} ` +
        `latencyMs=${record.latencyMs} costUsd=${record.costUsd ?? "n/a"}`,
    );
  }

  const totalCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  console.log(`\nTotal costUsd: ${totalCostUsd.toFixed(4)}`);

  try {
    const outPath = resolve(REPO_ROOT, outArg);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    console.log(`Wrote ${records.length} record(s) to ${outPath}`);
  } catch (err) {
    console.error(`Failed to write output JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
    process.exit(1);
    return;
  }

  if (args.help) {
    usage();
    return;
  }

  const tasks = BROWSING_EVAL_TASKS.filter((t) => args.taskIds.includes(t.id));

  if (args.dryRun) {
    runDryRun(tasks);
    return;
  }

  await runLive(tasks, args.out);
}

// Only run when this file is the invoked entrypoint (tsx / node), never on import — so the
// test suite can import parseEvalArgs without triggering the CLI's live/dry-run body.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
