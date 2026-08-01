/**
 * Pure arg-parsing pieces of the Browser Use eval CLI — deliberately free of
 * side effects (no `import "../loadEnv.js"`, no I/O, no process.exit) so the
 * test suite can import them without the CLI entrypoint's .env side effect.
 *
 * Repo invariant (see loadEnv.ts): tests must never pick up a developer's
 * local .env. The executable entrypoint (evalBrowserUse.ts) imports loadEnv
 * first, then re-uses everything here; tests import ONLY this module (WR-03).
 */

import { BROWSING_EVAL_TASKS } from "../eval/browsingTasks.js";

export const DEFAULT_OUT_PATH =
  ".planning/phases/13.3-agent-web-tools-firecrawl-extraction-browser-use-eval/13.3-eval-browseruse.json";

export const VALID_TASK_IDS = BROWSING_EVAL_TASKS.map((t) => t.id);

export interface EvalArgs {
  help: boolean;
  dryRun: boolean;
  out: string;
  taskIds: string[];
}

/** Pure argv parser — no I/O, no process.exit, so it is unit-testable in isolation. */
export function parseEvalArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {
    help: false,
    dryRun: false,
    out: DEFAULT_OUT_PATH,
    taskIds: VALID_TASK_IDS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--out": {
        const value = argv[++i];
        if (!value) throw new Error("--out requires a path argument");
        args.out = value;
        break;
      }
      case "--task": {
        const value = argv[++i];
        if (!value || !VALID_TASK_IDS.includes(value)) {
          throw new Error(`--task expects one of: ${VALID_TASK_IDS.join(", ")} — got "${value ?? ""}"`);
        }
        args.taskIds = [value];
        break;
      }
      default:
        throw new Error(`Unknown argument: "${arg}". Run with --help for usage.`);
    }
  }

  return args;
}
