/**
 * SC2 live recall probe (MEM-05) — a re-runnable CLI that measures recall@k
 * / MRR of synthetic canaries against the user's REAL captured corpus, using
 * real MLX embeddings through the real RetrievalService, and writes a
 * committed, redacted baseline artifact.
 *
 *   npm run eval:recall -- --dry-run     # offline: prints the run plan, no
 *                                         # MLX sidecar, no network, no writes
 *   npm run eval:recall -- --k 12 --canaries 5
 *   npm run eval:recall --                # k=8, 3 canaries (defaults)
 *
 * Design (locked by 13-RESEARCH.md / 13-04-PLAN.md, follow it exactly):
 *  - The user's REAL corpus is the distractor set — this probe queries ONLY
 *    for its own synthetic canaries. Real content is never queried,
 *    retrieved-into-the-artifact, or logged.
 *  - Canaries are minted fresh (a random per-invocation runToken) on every
 *    run because computeDedupKey() (services/memory/src/capture/experience.ts)
 *    is a content hash — a repeated canary text would return inserted:false
 *    and silently measure an already-vetted fact instead of a fresh one
 *    (Pitfall-2 tripwire).
 *  - Scoring imports evaluateRecall() from @jarvis/memory — the SAME pure
 *    function the hermetic harness (services/memory/test/recallEval.test.ts)
 *    uses, so SC1 and SC2 numbers are directly comparable. Never re-derive
 *    recall@k/MRR here.
 *  - Direct in-process wiring (getMemorySystem(new InferenceGateway(...))),
 *    the exact pattern connect.ts's sync subcommands already use three times
 *    over. No new HTTP endpoint on core's server for an eval-only concern.
 *
 * Concurrency note (pre-existing, documented not fixed): if `npm run core`'s
 * background ConsolidationScheduler is running, it can be mid-pass against
 * the same memory.db when this probe's own consolidation.run("manual")
 * fires. node:sqlite's timeout:5000 busy timeout tolerates concurrent writes
 * but does not prevent two independent runs from reading the same pending
 * set — an exposure identical to what connect.ts's sync subcommands already
 * carry today.
 *
 * Baseline artifact content is redacted by construction (T-13-14): only
 * aggregate recallAtK/mrr/counts plus synthetic canary markers/queries are
 * written. Never RetrievedMemory.text for a real result, never a non-canary
 * memoryId, never run.errors[].message verbatim (those messages can echo up
 * to 4096 chars of a captured record's body — the store already truncates
 * it to 200 chars on the observability surface for exactly this reason).
 */
import "../loadEnv.js"; // MUST be first: populates process.env from .env
// ^ This side effect is why tests import evalRecallArgs.ts, never this
//   module — importing this file loads the developer's real .env (WR-03).

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluateRecall, type RecallJudgment } from "@jarvis/memory";
import { getDataDir } from "../dataDir.js";
import {
  DEFAULT_CANARIES,
  DEFAULT_K,
  DEFAULT_OUT_PATH,
  MAX_CANARIES,
  MAX_K,
  parseEvalRecallArgs,
  type EvalRecallArgs,
} from "./evalRecallArgs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// services/core/src/cli -> src -> core -> services -> <repo root>
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

function usage(): void {
  console.log(
    [
      "Usage: npm run eval:recall -- [options]",
      "",
      `  --k <n>          top-k for retrieval (default: ${DEFAULT_K}, max: ${MAX_K})`,
      `  --canaries <n>   number of synthetic canaries to mint (default: ${DEFAULT_CANARIES}, max: ${MAX_CANARIES})`,
      `  --out <path>     where to write the baseline JSON`,
      `                   (default: ${DEFAULT_OUT_PATH})`,
      "  --dry-run        print the run plan, create nothing (no MLX sidecar, no network required)",
      "  --help           show this message",
    ].join("\n"),
  );
}

interface Canary {
  marker: string;
  noteId: string;
  text: string;
  query: string;
}

/**
 * Mint `count` per-invocation-unique synthetic canaries. Each note text is a
 * single, atomic, explicitly-factual sentence whose subject IS the marker,
 * so a real extraction model produces a fact whose text carries the marker
 * verbatim. The query is the marker plus a couple of literal tokens from
 * that same sentence. `noteId === marker` so the dedup key is unique per run
 * (computeDedupKey() is a content hash — Pitfall-2 tripwire).
 */
function mintCanaries(runToken: string, count: number): Canary[] {
  const canaries: Canary[] = [];
  for (let i = 0; i < count; i++) {
    const marker = `jarvis-eval-canary-${runToken}-${i}`;
    const deadline = `2027-0${(i % 9) + 1}-15`;
    const text = `The project codenamed ${marker} has a synthetic internal deadline of ${deadline}.`;
    const query = `${marker} synthetic internal deadline`;
    canaries.push({ marker, noteId: marker, text, query });
  }
  return canaries;
}

function runDryRun(args: EvalRecallArgs, canaries: Canary[]): void {
  console.log("Dry run — no MLX sidecar, no network, no writes to the real memory store.\n");
  console.log(`Data dir:    ${getDataDir()}`);
  console.log(`Output path: ${resolve(REPO_ROOT, args.out)}`);
  console.log(`k:           ${args.k}`);
  console.log(`Canaries:    ${canaries.length}\n`);
  for (const c of canaries) {
    console.log(`[${c.marker}]`);
    console.log(`  note:  ${c.text}`);
    console.log(`  query: ${c.query}`);
    console.log();
  }
}

interface PerCanaryResult {
  marker: string;
  query: string;
  found: boolean;
  rank: number | null;
  reciprocalRank: number;
  promoted: boolean;
}

async function runLive(args: EvalRecallArgs, canaries: Canary[], runToken: string): Promise<void> {
  const { loadConfig } = await import("../config.js");
  const { InferenceGateway } = await import("../inference/gateway.js");
  const { getMemorySystem } = await import("../memory/memorySystem.js");

  const gateway = new InferenceGateway(loadConfig());

  // Preflight: named, actionable error instead of a stack trace surfacing
  // from inside GatewayEmbedder.embed() mid-probe. health() never throws —
  // it catches internally and returns { ok: false } (mlxProvider.ts:34-47).
  const health = await gateway.mlx.health(AbortSignal.timeout(2_000));
  if (!health.ok) {
    console.error("MLX sidecar unreachable at 127.0.0.1:8088 — run `npm run sidecar` first.");
    process.exit(1);
    return;
  }

  const memory = getMemorySystem(gateway);
  if (!memory) {
    console.error("Memory system unavailable — check config/models.yaml (embedding entry).");
    process.exit(1);
    return;
  }

  const pendingRecordsBefore = memory.store.getPendingExperienceRecords().length;

  // Capture every canary sequentially via the public capture API only — no
  // raw SQL, no direct store mutation (T-13-19).
  const canaryRecordIds: string[] = [];
  for (const c of canaries) {
    const { inserted, record } = await memory.capture.captureNote({ text: c.text, noteId: c.noteId });
    if (!inserted) {
      console.error(
        `Canary "${c.marker}" was not inserted (dedup collision on noteId "${c.noteId}") — ` +
          "this should never happen with a fresh per-invocation marker. Aborting rather than " +
          "silently measuring a stale canary (Pitfall-2 tripwire).",
      );
      process.exit(1);
      return;
    }
    canaryRecordIds.push(record.id);
  }

  // Exactly ONE consolidation pass for all canaries — sequential, single-pass,
  // never a loop of runs (cost bound, T-13-17).
  const { run } = await memory.consolidation.run("manual");

  const canaryErrors = run.errors.filter((e) => e.recordId && canaryRecordIds.includes(e.recordId));
  const canaryConsolidationOk =
    (run.status === "completed" || run.status === "partial") && canaryErrors.length === 0;

  const judgments: RecallJudgment[] = [];
  const promotedByIndex: boolean[] = [];

  for (const c of canaries) {
    const results = await memory.retrieval.retrieve(c.query, { k: args.k });
    const hit = results.find((r) => r.text.includes(c.marker));
    const targetMemoryId = hit?.memoryId ?? "__canary-not-retrieved__";
    const retrieved = results.map((r) => ({ memoryId: r.memoryId, rank: r.rank }));
    judgments.push({ query: c.query, targetMemoryId, retrieved });

    // Wide sweep distinguishes "consolidation dropped the marker" from
    // "ranking failed to surface it in the top k" (T-13-21) — without it a
    // found:false is unattributable.
    const wide = await memory.retrieval.retrieve(c.query, { k: 50 });
    promotedByIndex.push(wide.some((r) => r.text.includes(c.marker)));
  }

  // Single shared scoring implementation (never re-derived here).
  const { recallAtK, mrr, perQuery } = evaluateRecall(judgments);
  console.log(`recallAt${args.k}: ${recallAtK}`);
  console.log(`mrr: ${mrr}`);

  const perCanary: PerCanaryResult[] = canaries.map((c, i) => ({
    marker: c.marker,
    query: c.query,
    found: perQuery[i]?.found ?? false,
    rank: perQuery[i]?.rank ?? null,
    reciprocalRank: perQuery[i]?.reciprocalRank ?? 0,
    promoted: promotedByIndex[i] ?? false,
  }));

  // Redaction is the security control (T-13-14): exactly these fields, and
  // NOTHING that could carry real content — no RetrievedMemory.text for any
  // result, no non-canary memoryId, no run.errors[].message verbatim. This
  // artifact is committed to git against the user's real personal corpus.
  const record = {
    generatedAt: new Date().toISOString(),
    runToken,
    k: args.k,
    canaryCount: canaries.length,
    recallAtK,
    mrr,
    perCanary,
    consolidation: {
      status: run.status,
      recordsProcessed: run.counts.recordsProcessed,
      factsExtracted: run.counts.factsExtracted,
      canaryConsolidationOk,
      canaryErrorCount: canaryErrors.length,
    },
    corpus: {
      pendingRecordsBefore,
    },
    notes:
      "Synthetic canaries only — the user's real corpus is the distractor set and is never " +
      "queried, retrieved-into-this-artifact, or logged. See 13-04-PLAN.md for the field-list contract.",
  };

  try {
    const outPath = resolve(REPO_ROOT, args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    console.log(`Wrote baseline to ${outPath}`);
  } catch (err) {
    console.error(`Failed to write output JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  if (!canaryConsolidationOk) {
    console.error(
      `Canary consolidation failed (status=${run.status}, canaryErrorCount=${canaryErrors.length}) — ` +
        "the baseline was still written with canaryConsolidationOk:false, but this run is a " +
        "FAILURE, never a silently-passing recallAtK.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let args: EvalRecallArgs;
  try {
    args = parseEvalRecallArgs(process.argv.slice(2));
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

  // Per-invocation-unique token — the whole reason a re-run never collides
  // with a prior canary's content hash.
  const runToken = `${randomUUID().slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
  const canaries = mintCanaries(runToken, args.canaries);

  if (args.dryRun) {
    runDryRun(args, canaries);
    return;
  }

  await runLive(args, canaries, runToken);
}

// Only run when this file is the invoked entrypoint (tsx / node), never on import — so the
// test suite can import parseEvalRecallArgs without triggering the CLI's live/dry-run body.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
