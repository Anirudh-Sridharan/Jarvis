/**
 * ScreenshotRunner — Tier 3 plumbing (phase 15): window-scoped screen capture
 * with a deterministic resize and a known coordinate-mapping scale factor.
 *
 * Two pitfalls this file exists to close (15-RESEARCH.md):
 *
 * - Pitfall 3 (over-capture): a full-display `screencapture` exposes whatever
 *   else is on screen — notification banners, other windows, unrelated app
 *   content. Window-scoped `-R <rect>` capture is therefore the DEFAULT; a
 *   full-display grab requires an explicit `fullDisplay: true`, and if the
 *   capture rectangle cannot be resolved at all this returns a structured
 *   failure rather than silently falling back to an unbounded full-screen
 *   capture (an unknown rect means unknown coordinates).
 * - Pitfall 5 (coordinate drift): if the image sent to a vision model is
 *   resized — by us, or silently by the API if oversized — and the tool
 *   naively applies model-returned [x,y] coordinates to the real screen,
 *   clicks land in the wrong place. This file ALWAYS resizes deterministically
 *   via `sips` to a size it chooses itself (never relying on server-side
 *   downscaling) and returns the exact `pointsPerImagePixel` factor needed to
 *   map an image-space point back to a real screen point.
 *
 * D-07: every native call goes through the injected MacCommandRunner, never
 * `node:child_process` directly. The bounds lookup reuses 15-02's
 * ScriptRunner.runJxa (fixed script body, app name as trailing argv — never
 * string-concatenated) rather than re-implementing an osascript call.
 */

import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MacCommandRunner } from "./commandRunner.js";
import { execFileMacRunner } from "./commandRunner.js";
import { ScriptRunner } from "./scriptRunner.js";
import { macFailure, type TccFailureKind } from "./tccErrors.js";

const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const SIPS_BIN = "/usr/bin/sips";

/**
 * Comfortably under Claude Sonnet 5's 2576px long-edge image limit
 * (15-RESEARCH.md, fetched live) so the API never silently downscales the
 * image and destroys the `pointsPerImagePixel` scale factor computed here.
 */
export const SCREENSHOT_MAX_DIM = 1400;

export interface ScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotCapture {
  /** Base64-encoded PNG bytes. */
  pngBase64: string;
  /** Pixel dimensions of the (possibly resized) image actually returned. */
  imageWidth: number;
  imageHeight: number;
  /** The captured rectangle, in real screen points (not pixels). */
  rect: ScreenshotRect;
  /** Multiply an image-pixel coordinate by this to get a screen-point offset from rect.x/rect.y. */
  pointsPerImagePixel: number;
  source: "window" | "display";
}

export type ScreenshotResult =
  | (ScreenshotCapture & { ok: true })
  | { ok: false; error: string; kind: TccFailureKind };

export interface ScreenshotCaptureOptions {
  /** App name to capture the front window of. Omitted -> frontmost process. Ignored when fullDisplay is true. */
  app?: string;
  /** Capture the entire display instead of a single window (Pitfall 3: opt-in only). */
  fullDisplay?: boolean;
  /** Override SCREENSHOT_MAX_DIM for this capture. */
  maxDim?: number;
}

/** Minimal injectable filesystem seam — tests must stay hermetic (no real disk I/O). */
export interface ScreenshotFs {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface ScreenshotRunnerOptions {
  run?: MacCommandRunner;
  script?: ScriptRunner;
  fs?: ScreenshotFs;
}

const liveFs: ScreenshotFs = {
  mkdtemp: (prefix) => fsMkdtemp(prefix),
  readFile: (p) => fsReadFile(p),
  rm: (p, opts) => fsRm(p, opts),
};

// ── Fixed JXA script bodies (never string-concatenated with untrusted data) ───
// Variable data (the app name) is ALWAYS a trailing argv element, read via
// JXA's run(argv) handler — mirrors macTools.ts's FRONTMOST_APP_SCRIPT pattern.

const WINDOW_BOUNDS_SCRIPT = `
function run(argv) {
  const appName = argv[0];
  const se = Application("System Events");
  let proc;
  if (appName && appName.length > 0) {
    proc = se.processes.byName(appName);
  } else {
    const matches = se.processes.whose({ frontmost: true });
    proc = matches[0];
  }
  const win = proc.windows[0];
  const pos = win.position();
  const size = win.size();
  return JSON.stringify({ x: pos[0], y: pos[1], width: size[0], height: size[1] });
}
`;

const FULL_DISPLAY_BOUNDS_SCRIPT = `
function run(argv) {
  const bounds = Application("Finder").desktop.window.bounds();
  return JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}
`;

function parsePixelDimensions(stdout: string): { width: number; height: number } | null {
  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  if (!widthMatch || !heightMatch) return null;
  return { width: Number(widthMatch[1]), height: Number(heightMatch[1]) };
}

function isValidRect(value: unknown): value is ScreenshotRect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number"
  );
}

/**
 * Maps a point in the (possibly resized) captured image back to a real
 * screen point, using the capture's own known scale factor (Pitfall 5) —
 * NEVER assume the model's returned coordinates are already screen-scale.
 */
export function imageToScreenPoint(
  point: { x: number; y: number },
  capture: ScreenshotCapture,
): { x: number; y: number } {
  return {
    x: Math.round(capture.rect.x + point.x * capture.pointsPerImagePixel),
    y: Math.round(capture.rect.y + point.y * capture.pointsPerImagePixel),
  };
}

export class ScreenshotRunner {
  private readonly run: MacCommandRunner;
  private readonly script: ScriptRunner;
  private readonly fs: ScreenshotFs;

  constructor(opts?: ScreenshotRunnerOptions) {
    this.run = opts?.run ?? execFileMacRunner;
    this.script = opts?.script ?? new ScriptRunner(this.run);
    this.fs = opts?.fs ?? liveFs;
  }

  private async readDimensions(
    tmpPath: string,
  ): Promise<{ ok: true; width: number; height: number } | { ok: false; error: string; kind: TccFailureKind }> {
    const result = await this.run(SIPS_BIN, ["-g", "pixelWidth", "-g", "pixelHeight", tmpPath]);
    if (result.exitCode !== 0 || result.timedOut) {
      return macFailure(result, { command: "sips -g" });
    }
    const dims = parsePixelDimensions(result.stdout);
    if (!dims) {
      return { ok: false, error: "could not parse image dimensions from sips output", kind: "unknown" };
    }
    return { ok: true, ...dims };
  }

  /**
   * Capture the target window (default) or the full display (opt-in) as a
   * PNG, deterministically resized under maxDim, with the exact scale
   * factor needed to map image coordinates back to real screen points.
   *
   * Degrades through `macFailure` at every native-call step — never falls
   * back to an unbounded full-screen grab when the rectangle cannot be
   * resolved (Pitfall 3 + 5).
   */
  async capture(opts: ScreenshotCaptureOptions = {}): Promise<ScreenshotResult> {
    // Step 1: resolve the capture rectangle in SCREEN POINTS.
    const source: "window" | "display" = opts.fullDisplay ? "display" : "window";
    const boundsResult = opts.fullDisplay
      ? await this.script.runJxa(FULL_DISPLAY_BOUNDS_SCRIPT, [])
      : await this.script.runJxa(WINDOW_BOUNDS_SCRIPT, [opts.app ?? ""]);

    if (!boundsResult.ok) return boundsResult;

    let rect: ScreenshotRect;
    try {
      const parsed: unknown = JSON.parse(boundsResult.stdout);
      if (!isValidRect(parsed)) {
        return {
          ok: false,
          error: "could not resolve a valid capture rectangle — refusing an unbounded full-screen grab",
          kind: "unknown",
        };
      }
      rect = parsed;
    } catch {
      return {
        ok: false,
        error: "could not resolve a valid capture rectangle — refusing an unbounded full-screen grab",
        kind: "unknown",
      };
    }

    // Step 2: mkdtemp + screencapture -R <rect>.
    let tmpDir: string | undefined;
    try {
      tmpDir = await this.fs.mkdtemp(path.join(os.tmpdir(), "jarvis-screenshot-"));
      const tmpPath = path.join(tmpDir, "capture.png");
      const rectArg = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      const captureResult = await this.run(SCREENCAPTURE_BIN, ["-x", "-R", rectArg, tmpPath]);
      if (captureResult.exitCode !== 0 || captureResult.timedOut) {
        return macFailure(captureResult, { command: "screencapture" });
      }

      // Step 3: read original pixel dimensions.
      const dims1 = await this.readDimensions(tmpPath);
      if (!dims1.ok) return dims1;
      let imageWidth = dims1.width;
      let imageHeight = dims1.height;

      // Step 4: resize if the longer edge exceeds the limit. NEVER rely on
      // the API's server-side downscale (Pitfall 5) — resize ourselves and
      // re-read the real post-resize dimensions.
      const maxDim = opts.maxDim ?? SCREENSHOT_MAX_DIM;
      if (Math.max(imageWidth, imageHeight) > maxDim) {
        const resizeResult = await this.run(SIPS_BIN, ["-Z", String(maxDim), tmpPath]);
        if (resizeResult.exitCode !== 0 || resizeResult.timedOut) {
          return macFailure(resizeResult, { command: "sips -Z" });
        }
        const dims2 = await this.readDimensions(tmpPath);
        if (!dims2.ok) return dims2;
        imageWidth = dims2.width;
        imageHeight = dims2.height;
      }

      // Step 5: read + base64-encode; compute the scale factor.
      const buf = await this.fs.readFile(tmpPath);
      const pngBase64 = buf.toString("base64");
      const pointsPerImagePixel = rect.width / imageWidth;

      return {
        ok: true,
        pngBase64,
        imageWidth,
        imageHeight,
        rect,
        pointsPerImagePixel,
        source,
      };
    } finally {
      // Step 6: always clean up, on both success and failure paths.
      if (tmpDir) {
        try {
          await this.fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
          // Swallow cleanup errors — never let temp-dir removal mask the
          // real capture result.
        }
      }
    }
  }
}
