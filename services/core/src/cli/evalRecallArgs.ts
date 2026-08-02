/**
 * Pure arg-parsing pieces of the SC2 live recall probe CLI — deliberately
 * free of side effects (no `import "../loadEnv.js"`, no I/O, no
 * process.exit) so the test suite can import them without the CLI
 * entrypoint's .env side effect.
 *
 * Repo invariant (see loadEnv.ts): tests must never pick up a developer's
 * local .env. The executable entrypoint (evalRecall.ts) imports loadEnv
 * first, then re-uses everything here; tests import ONLY this module
 * (WR-03).
 */

import { resolve, sep } from "node:path";

export const DEFAULT_OUT_PATH =
  ".planning/phases/13-retrieval-eval-harness-recall-verification-discipline/13-eval-recall-baseline.json";

/** Matches RetrievalService's own DEFAULT_K. */
export const DEFAULT_K = 8;
export const MAX_K = 50;

export const DEFAULT_CANARIES = 3;
/** A real bound, not decoration: each canary drives a heavy-tier LLM
 *  extraction call on a live run, so an unbounded count is a
 *  credit-burn/DoS surface (T-13-17). */
export const MAX_CANARIES = 10;

export interface EvalRecallArgs {
  help: boolean;
  dryRun: boolean;
  k: number;
  canaries: number;
  out: string;
}

/** Pure argv parser — no I/O, no process.exit, so it is unit-testable in isolation. */
export function parseEvalRecallArgs(argv: string[]): EvalRecallArgs {
  const args: EvalRecallArgs = {
    help: false,
    dryRun: false,
    k: DEFAULT_K,
    canaries: DEFAULT_CANARIES,
    out: DEFAULT_OUT_PATH,
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
      case "--k": {
        const value = argv[++i];
        const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_K) {
          throw new Error(`--k must be an integer between 1 and ${MAX_K} — got "${value ?? ""}"`);
        }
        args.k = parsed;
        break;
      }
      case "--canaries": {
        const value = argv[++i];
        const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CANARIES) {
          throw new Error(
            `--canaries must be an integer between 1 and ${MAX_CANARIES} (bounds live-run cloud LLM cost) — got "${value ?? ""}"`,
          );
        }
        args.canaries = parsed;
        break;
      }
      default:
        throw new Error(`Unknown argument: "${arg}". Run with --help for usage.`);
    }
  }

  return args;
}

/**
 * Resolve `--out` against the repo root and ENFORCE containment (T-13-15,
 * code-review WR-02): a resolved path outside `repoRoot` throws, so an
 * absolute `--out /anywhere/file.json` or a relative `--out ../../escape.json`
 * can never direct `mkdirSync`/`writeFileSync` outside the repo. Before this
 * check the "resolve against REPO_ROOT" step was labeled a path-traversal
 * mitigation while enforcing nothing.
 *
 * Pure (node:path only — no I/O, no process.exit) so it is unit-testable
 * from evalRecallArgs.test.ts without the entrypoint's loadEnv side effect.
 * The parser above stays a pure string pass-through; containment is a
 * property of path RESOLUTION, enforced here at the single point both the
 * dry-run and live paths use.
 */
export function resolveOutPathWithinRepo(repoRoot: string, out: string): string {
  const root = resolve(repoRoot);
  const outPath = resolve(root, out);
  if (outPath !== root && !outPath.startsWith(root + sep)) {
    throw new Error(
      `--out must resolve inside the repo (repo root: ${root}) — got "${out}" which resolves to "${outPath}"`,
    );
  }
  return outPath;
}
