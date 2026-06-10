/**
 * POST /api/connectors/connect { source } — start an OAuth consent flow.
 *
 * Delegates to the connect CLI (`npm run connect -- <source>`), which owns the
 * loopback listener on the registered redirect port, the provider client creds
 * (.env), and Keychain persistence — the BFF never touches tokens. The CLI
 * opens the system browser itself and prints the consent URL; this route
 * parses that URL from its stdout and returns it so the UI can surface a
 * fallback link. The CLI keeps running in the background until consent lands
 * (or its 5-minute timeout) — the client polls GET /api/connectors to see the
 * token state flip.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, ConnectStartResult } from "@/app/lib/contracts";

const OAUTH_SOURCES = new Set(["whoop", "gcal", "gmail"]);
const URL_WAIT_MS = 10_000;

/** Monorepo root = nearest ancestor package.json declaring workspaces. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      if (pkg.workspaces) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Spawn the consent flow and resolve as soon as its stdout prints the
 * authorize URL. The child keeps running after we resolve — it is the
 * callback listener. An early exit (missing creds, port in use) rejects
 * with the collected output.
 */
function startConsentFlow(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "connect", "--", source], {
      cwd: findRepoRoot(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Consent flow produced no URL within ${URL_WAIT_MS / 1000}s.\n${output}`));
    }, URL_WAIT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/https:\/\/\S{20,}/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[0]);
        // Child stays alive as the callback listener; stop holding it back.
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.unref();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(output.trim() || `connect CLI exited with code ${code} before printing a URL`));
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { source?: string };
    const source = body.source ?? "";
    if (!OAUTH_SOURCES.has(source)) {
      const envelope: WidgetEnvelope<ConnectStartResult> = {
        data: null,
        state: "error",
        error: {
          code: "BAD_SOURCE",
          message: `source must be one of: ${[...OAUTH_SOURCES].join(", ")}`,
        },
        meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
      };
      return NextResponse.json(envelope, { status: 400 });
    }

    const authorizeUrl = await startConsentFlow(source);
    const envelope: WidgetEnvelope<ConnectStartResult> = {
      data: { source, authorizeUrl },
      state: "ok",
      meta: { source: "connect-cli", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<ConnectStartResult> = {
      data: null,
      state: "error",
      error: { code: "CONNECT_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}
