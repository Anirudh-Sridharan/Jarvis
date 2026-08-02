/**
 * OpenRunner — Tier 1 native launch capability: `/usr/bin/open` wraps Launch
 * Services to open an app, a URL, or a file (optionally with a specific app).
 *
 * Unlike `browser_navigate` (isolated Playwright profile, no cookies/logins),
 * `open -u <url>` reaches the user's REAL, logged-in default browser — there
 * is no `--isolated` equivalent here (15-RESEARCH.md Anti-Patterns). This is
 * why `mac_open` (the tool built on top of this runner) is gated, not
 * readOnly, and why every target string is validated before any spawn:
 *
 *   - exactly one of `url` / `path` / `bundleId` / a bare `app` may be the
 *     primary target (`app` may additionally accompany `path` to mean
 *     "open this file with that app")
 *   - every string value beginning with `-` is refused (option injection
 *     into `/usr/bin/open` — only `-a`/`-b` are ever emitted by this module,
 *     `--args` is never passed)
 *   - `url` must be `http(s)` — every other scheme (`file:`, `javascript:`,
 *     `x-apple-*`, `shortcuts:`, ...) is refused with an explicit error
 *   - `path` must be absolute
 */

import type { MacCommandRunner } from "./commandRunner.js";
import { execFileMacRunner } from "./commandRunner.js";
import { macFailure, type TccFailureKind } from "./tccErrors.js";

const OPEN_BIN = "/usr/bin/open";

export interface OpenTarget {
  app?: string;
  bundleId?: string;
  url?: string;
  path?: string;
}

export type OpenResult =
  | { ok: true; opened: string }
  | { ok: false; error: string; kind: TccFailureKind };

function beginsWithDash(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("-");
}

/** Pre-spawn validation refusal — never invokes the runner. */
function refusal(error: string): { ok: false; error: string; kind: TccFailureKind } {
  return { ok: false, error, kind: "unknown" };
}

export class OpenRunner {
  constructor(private readonly run: MacCommandRunner = execFileMacRunner) {}

  async open(target: OpenTarget): Promise<OpenResult> {
    const { app, bundleId, url, path } = target;

    // Option-injection guard: every string value is rejected when it begins
    // with "-", before any other validation or spawn.
    if (beginsWithDash(app) || beginsWithDash(bundleId) || beginsWithDash(url) || beginsWithDash(path)) {
      return refusal("target values must not begin with \"-\" (option injection guard)");
    }

    const provided = {
      app: app !== undefined,
      bundleId: bundleId !== undefined,
      url: url !== undefined,
      path: path !== undefined,
    };
    const providedCount = Object.values(provided).filter(Boolean).length;

    if (providedCount === 0) {
      return refusal("exactly one of app, bundleId, url, or path is required");
    }

    let argv: string[];
    let opened: string;

    if (providedCount === 1 && provided.app) {
      argv = ["-a", app!];
      opened = app!;
    } else if (providedCount === 1 && provided.bundleId) {
      argv = ["-b", bundleId!];
      opened = bundleId!;
    } else if (providedCount === 1 && provided.url) {
      if (!/^https?:\/\//i.test(url!)) {
        return refusal("only http(s) URLs are allowed");
      }
      argv = [url!];
      opened = url!;
    } else if (providedCount === 1 && provided.path) {
      if (!path!.startsWith("/")) {
        return refusal("path must be absolute");
      }
      argv = [path!];
      opened = path!;
    } else if (providedCount === 2 && provided.app && provided.path) {
      if (!path!.startsWith("/")) {
        return refusal("path must be absolute");
      }
      argv = ["-a", app!, path!];
      opened = path!;
    } else {
      return refusal(
        "invalid target combination — exactly one of app, bundleId, url, or path " +
          "may be the primary target (app may additionally accompany path)",
      );
    }

    const result = await this.run(OPEN_BIN, argv);
    if (result.exitCode !== 0 || result.timedOut) {
      return macFailure(result, { command: "open", target: opened });
    }
    return { ok: true, opened };
  }
}
