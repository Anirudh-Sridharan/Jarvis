/**
 * screenshotRunner.test.ts — Tier 3 plumbing (phase 15): window-scoped
 * screenshot capture with deterministic resize and coordinate mapping.
 *
 * Driven entirely by a FakeMacRunner (never throws, records every call in
 * order — including the JXA bounds-lookup osascript call, since that also
 * rides the same injected MacCommandRunner) and a FakeFs (in-memory temp
 * dir bookkeeping). No real macOS call in any test.
 */

import { describe, it, expect } from "vitest";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import {
  ScreenshotRunner,
  imageToScreenPoint,
  SCREENSHOT_MAX_DIM,
  type ScreenshotCapture,
  type ScreenshotFs,
} from "../src/mac/screenshotRunner.js";

const OSASCRIPT = "/usr/bin/osascript";
const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeMacRunner {
  calls: Array<{ cmd: string; args: string[]; opts?: MacCommandOptions }> = [];
  /** Responses returned in call order; a missing entry defaults to a clean success. */
  responses: MacCommandResult[] = [];
  private callIndex = 0;

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    const result = this.responses[this.callIndex] ?? {
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    this.callIndex++;
    return result;
  };
}

class FakeFs implements ScreenshotFs {
  mkdtempCalls: string[] = [];
  readFileCalls: string[] = [];
  rmCalls: Array<{ path: string; opts: { recursive: boolean; force: boolean } }> = [];
  fileContent = Buffer.from("fake-png-bytes");

  async mkdtemp(prefix: string): Promise<string> {
    this.mkdtempCalls.push(prefix);
    return `${prefix}FAKE123`;
  }

  async readFile(path: string): Promise<Buffer> {
    this.readFileCalls.push(path);
    return this.fileContent;
  }

  async rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void> {
    this.rmCalls.push({ path, opts });
  }
}

function boundsJson(rect: { x: number; y: number; width: number; height: number }): MacCommandResult {
  return { stdout: JSON.stringify(rect), stderr: "", exitCode: 0, timedOut: false };
}

function sipsDims(width: number, height: number): MacCommandResult {
  return {
    stdout: `/tmp/fake/capture.png\n  pixelWidth: ${width}\n  pixelHeight: ${height}\n`,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

const OK_EMPTY: MacCommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

// ── Happy path ────────────────────────────────────────────────────────────────

describe("ScreenshotRunner.capture — happy path (window mode, resize needed)", () => {
  it("builds the exact argv sequence and returns the expected base64 + pointsPerImagePixel", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    // 1: osascript bounds lookup -> rect 800x500 in screen points
    // 2: screencapture -> success
    // 3: sips -g -> original 1600x1000 (2x Retina, exceeds SCREENSHOT_MAX_DIM=1400)
    // 4: sips -Z 1400 -> success
    // 5: sips -g -> post-resize 1400x875
    fake.responses = [
      boundsJson({ x: 100, y: 50, width: 800, height: 500 }),
      OK_EMPTY,
      sipsDims(1600, 1000),
      OK_EMPTY,
      sipsDims(1400, 875),
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.source).toBe("window");
    expect(result.rect).toEqual({ x: 100, y: 50, width: 800, height: 500 });
    expect(result.imageWidth).toBe(1400);
    expect(result.imageHeight).toBe(875);
    expect(result.pointsPerImagePixel).toBeCloseTo(800 / 1400);
    expect(result.pngBase64).toBe(fs.fileContent.toString("base64"));

    // Command sequence — excluding the osascript bounds-lookup call, which
    // also rides the same injected runner but is not part of the native
    // capture pipeline being asserted here.
    const nativeCalls = fake.calls.filter((c) => c.cmd !== OSASCRIPT);
    expect(nativeCalls.map((c) => c.cmd)).toEqual([SCREENCAPTURE, SIPS, SIPS, SIPS]);

    const captureCall = fake.calls.find((c) => c.cmd === SCREENCAPTURE)!;
    expect(captureCall.args[0]).toBe("-x");
    const rIndex = captureCall.args.indexOf("-R");
    expect(rIndex).toBeGreaterThanOrEqual(0);
    expect(captureCall.args[rIndex + 1]).toBe("100,50,800,500");

    // Temp dir cleaned up.
    expect(fs.rmCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Under-limit: no resize ─────────────────────────────────────────────────────

describe("ScreenshotRunner.capture — capture already under the limit", () => {
  it("skips the -Z resize call entirely", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.responses = [
      boundsJson({ x: 0, y: 0, width: 1200, height: 800 }),
      OK_EMPTY,
      sipsDims(1200, 800), // already under SCREENSHOT_MAX_DIM=1400
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.imageWidth).toBe(1200);
    expect(result.imageHeight).toBe(800);
    expect(fake.calls.filter((c) => c.args.includes("-Z")).length).toBe(0);
  });
});

// ── Screen Recording denied ────────────────────────────────────────────────────

describe("ScreenshotRunner.capture — screen recording denied", () => {
  it("degrades to kind: screen-recording-denied and still cleans up the temp dir", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.responses = [
      boundsJson({ x: 0, y: 0, width: 800, height: 500 }),
      { stdout: "", stderr: "could not create image from display", exitCode: 1, timedOut: false },
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.kind).toBe("screen-recording-denied");
    expect(fs.rmCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Accessibility denied (bounds lookup failure) ──────────────────────────────

describe("ScreenshotRunner.capture — bounds lookup denied (Accessibility)", () => {
  it("degrades to kind: accessibility-denied and never invokes screencapture", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.responses = [
      {
        stdout: "",
        stderr: "osascript is not allowed assistive access. (-25211)",
        exitCode: 1,
        timedOut: false,
      },
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.kind).toBe("accessibility-denied");
    expect(fake.calls.filter((c) => c.cmd.endsWith("screencapture")).length).toBe(0);
  });
});

// ── Window mode is the default ─────────────────────────────────────────────────

describe("ScreenshotRunner.capture — window mode is the default", () => {
  it("uses source: window when fullDisplay is omitted", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.responses = [
      boundsJson({ x: 0, y: 0, width: 1200, height: 800 }),
      OK_EMPTY,
      sipsDims(1200, 800),
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture({});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.source).toBe("window");
  });
});

// ── Resize failure degrades structurally ───────────────────────────────────────

describe("ScreenshotRunner.capture — sips -Z resize failure", () => {
  it("degrades to a structured failure instead of throwing, and still cleans up", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.responses = [
      boundsJson({ x: 0, y: 0, width: 800, height: 500 }),
      OK_EMPTY,
      sipsDims(1600, 1000),
      { stdout: "", stderr: "Error 1: An unknown error occurred", exitCode: 1, timedOut: false },
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(fs.rmCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Full display mode ──────────────────────────────────────────────────────────

describe("ScreenshotRunner.capture — fullDisplay opt-in", () => {
  it("uses the full-display bounds script and reports source: display", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.responses = [
      boundsJson({ x: 0, y: 0, width: 1200, height: 800 }),
      OK_EMPTY,
      sipsDims(1200, 800),
    ];
    const runner = new ScreenshotRunner({ run: fake.runner, fs });

    const result = await runner.capture({ fullDisplay: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.source).toBe("display");
  });
});

// ── imageToScreenPoint ──────────────────────────────────────────────────────────

describe("imageToScreenPoint", () => {
  it("maps a known image point to the expected screen point for a 2x Retina capture", () => {
    const capture: ScreenshotCapture = {
      pngBase64: "",
      imageWidth: 1400,
      imageHeight: 875,
      rect: { x: 100, y: 50, width: 800, height: 500 },
      pointsPerImagePixel: 800 / 1400,
      source: "window",
    };
    const screenPoint = imageToScreenPoint({ x: 700, y: 350 }, capture);
    expect(screenPoint).toEqual({ x: capture.rect.x + 400, y: capture.rect.y + 200 });
  });
});

describe("SCREENSHOT_MAX_DIM", () => {
  it("equals 1400, comfortably under Claude Sonnet 5's 2576px long-edge limit", () => {
    expect(SCREENSHOT_MAX_DIM).toBe(1400);
  });
});
