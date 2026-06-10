/**
 * POST /api/connectors/sync { source } — run one manual sync now.
 *
 * Delegates to the existing connect CLI (`npm run connect -- sync <source>`)
 * so live credentials stay on core's path (Keychain token store, real fetch);
 * the dashboard BFF itself remains read-only against the SQLite stores.
 * Source is allowlisted; output is the CLI's stdout/stderr tail.
 */

import { execFile } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { findRepoRoot } from "@/app/lib/repoRoot";
import type { WidgetEnvelope, SyncNowResult } from "@/app/lib/contracts";

const SYNCABLE = new Set(["whoop", "gcal", "gmail", "github", "simplefin"]);
const SYNC_TIMEOUT_MS = 180_000;

function runConnectSync(source: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["run", "connect", "--", "sync", source],
      { cwd: findRepoRoot(), timeout: SYNC_TIMEOUT_MS, encoding: "utf8" },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(-2_000);
        resolve({ ok: !err, output: output || (err ? String(err) : "") });
      },
    );
  });
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { source?: string };
    const source = body.source ?? "";
    if (!SYNCABLE.has(source)) {
      const envelope: WidgetEnvelope<SyncNowResult> = {
        data: null,
        state: "error",
        error: { code: "BAD_SOURCE", message: `source must be one of: ${[...SYNCABLE].join(", ")}` },
        meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
      };
      return NextResponse.json(envelope, { status: 400 });
    }

    const result = await runConnectSync(source);
    const envelope: WidgetEnvelope<SyncNowResult> = {
      data: { source, ok: result.ok, output: result.output },
      state: result.ok ? "ok" : "error",
      ...(result.ok ? {} : { error: { code: "SYNC_FAILED", message: result.output } }),
      meta: { source: "connect-cli", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<SyncNowResult> = {
      data: null,
      state: "error",
      error: { code: "SYNC_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}
