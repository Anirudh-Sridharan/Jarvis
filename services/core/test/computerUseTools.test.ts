/**
 * computerUseTools.test.ts — Tier 3 vision fallback (phase 15, plan 15-05).
 *
 * Fake-driven throughout: FakeMacRunner stands in for the injected
 * MacCommandRunner (mirrors screenshotRunner.test.ts's sequential-response
 * fake), FakeGateway stands in for the InferenceGateway's chat() generator.
 * No real macOS call, no real network call, in any test.
 */

import { describe, it, expect } from "vitest";
import { writeFile as fsWriteFile } from "node:fs/promises";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { makeComputerUseTools, COMPUTER_MAX_ELEMENTS } from "../src/agent/tools/computerUseTools.js";
import { imageToScreenPoint } from "../src/mac/screenshotRunner.js";
import type { ChatMessage, JarvisInferenceRequest, InferenceStreamChunk } from "../src/inference/types.js";
import type { InferenceGateway } from "../src/inference/gateway.js";

const SCREENCAPTURE = "/usr/sbin/screencapture";

/** Bytes the fake "screencapture" call writes to the real temp path so the
 * production ScreenshotRunner's (unfaked, LIVE) fs.readFile succeeds.
 * makeComputerUseTools does not expose an fs injection seam — only `run` and
 * `gateway` — so this is the one point where these tests touch a real (but
 * always-cleaned-up) temp file; no real macOS command ever executes. */
const FAKE_PNG_BYTES = Buffer.from("fake-png-bytes");

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeMacRunner {
  calls: Array<{ cmd: string; args: string[]; opts?: MacCommandOptions }> = [];
  responses: MacCommandResult[] = [];
  private callIndex = 0;

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    const result = this.responses[this.callIndex] ?? { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    this.callIndex++;
    if (cmd === SCREENCAPTURE && result.exitCode === 0 && !result.timedOut) {
      const outPath = args[args.length - 1];
      if (outPath) await fsWriteFile(outPath, FAKE_PNG_BYTES);
    }
    return result;
  };
}

interface FakeGatewayCall {
  taskHint: string | undefined;
  messages: ChatMessage[];
}

class FakeGateway implements Pick<InferenceGateway, "chat"> {
  calls: FakeGatewayCall[] = [];
  /** Chunks yielded for every call, in order. Defaults to a minimal valid reply. */
  chunks: InferenceStreamChunk[] = [
    { type: "token", text: '{"description":"a screen","elements":[]}' },
    { type: "done" },
  ];

  async *chat(
    rawReq: Partial<JarvisInferenceRequest>,
    _signal?: AbortSignal,
  ): AsyncGenerator<InferenceStreamChunk, void, unknown> {
    this.calls.push({ taskHint: rawReq.taskHint, messages: rawReq.messages ?? [] });
    for (const chunk of this.chunks) {
      yield chunk;
    }
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

/** A capture sequence that requires a resize — 2x Retina 1600x1000 -> 1400x875,
 * rect 800x500 at (100,50) — so raw vs mapped model coordinates visibly differ. */
const RETINA_CAPTURE_SEQUENCE: MacCommandResult[] = [
  boundsJson({ x: 100, y: 50, width: 800, height: 500 }),
  OK_EMPTY, // screencapture
  sipsDims(1600, 1000), // original dims
  OK_EMPTY, // sips -Z resize
  sipsDims(1400, 875), // post-resize dims
];

function toolByName(run: MacCommandRunner, gateway: Pick<InferenceGateway, "chat">, name: string) {
  const tool = makeComputerUseTools(run, gateway).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not built`);
  return tool;
}

const ORIGINAL_KEY = process.env["ANTHROPIC_API_KEY"];

function withApiKey(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  if (value === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = value;
  return fn().finally(() => {
    if (ORIGINAL_KEY === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = ORIGINAL_KEY;
  });
}

// ── Surface ───────────────────────────────────────────────────────────────────

describe("computer_screenshot — surface", () => {
  it("is readOnly and returnsExternalContent", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      const gateway = new FakeGateway();
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");
      expect(tool.readOnly).toBe(true);
      expect(tool.returnsExternalContent).toBe(true);
    });
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("computer_screenshot — happy path", () => {
  it("issues exactly one gateway.chat call with taskHint reasoning and an image_url content part", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      gateway.chunks = [{ type: "token", text: '{"description":"a screen","elements":[]}' }, { type: "done" }];
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as Record<string, unknown>;

      expect(result["ok"]).toBe(true);
      expect(gateway.calls.length).toBe(1);
      expect(gateway.calls[0]!.taskHint).toBe("reasoning");
      const userMsg = gateway.calls[0]!.messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(Array.isArray(userMsg!.content)).toBe(true);
      const parts = userMsg!.content as { type: string; image_url?: { url: string } }[];
      const lastPart = parts[parts.length - 1]!;
      expect(lastPart.type).toBe("image_url");
      expect(lastPart.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
    });
  });

  it("never returns the base64 payload in the result", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = await tool.run({});

      const expectedBase64 = FAKE_PNG_BYTES.toString("base64");
      expect((result as Record<string, unknown>)["ok"]).toBe(true);
      expect(JSON.stringify(result).includes(expectedBase64)).toBe(false);
    });
  });

  it("maps model coordinates through imageToScreenPoint — mapped point differs from the raw model coordinate", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      const rawPoint = { x: 700, y: 350 };
      gateway.chunks = [
        {
          type: "token",
          text: JSON.stringify({
            description: "a button",
            elements: [{ label: "Save", role: "button", x: rawPoint.x, y: rawPoint.y }],
          }),
        },
        { type: "done" },
      ];
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as { elements: { x: number; y: number }[] };

      const capture = {
        pngBase64: "",
        imageWidth: 1400,
        imageHeight: 875,
        rect: { x: 100, y: 50, width: 800, height: 500 },
        pointsPerImagePixel: 800 / 1400,
        source: "window" as const,
      };
      const expected = imageToScreenPoint(rawPoint, capture);

      expect(result.elements.length).toBe(1);
      expect(result.elements[0]!.x).toBe(expected.x);
      expect(result.elements[0]!.y).toBe(expected.y);
      expect(result.elements[0]!.x).not.toBe(rawPoint.x);
      expect(result.elements[0]!.y).not.toBe(rawPoint.y);
    });
  });

  it("caps a 200-element model reply at COMPUTER_MAX_ELEMENTS", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      const manyElements = Array.from({ length: 200 }, (_, i) => ({
        label: `el-${i}`,
        role: "button",
        x: i,
        y: i,
      }));
      gateway.chunks = [
        { type: "token", text: JSON.stringify({ description: "many buttons", elements: manyElements }) },
        { type: "done" },
      ];
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as { elements: unknown[] };

      expect(result.elements.length).toBe(COMPUTER_MAX_ELEMENTS);
    });
  });
});

// ── Degrade, never crash ────────────────────────────────────────────────────────

describe("computer_screenshot — degrade, never crash", () => {
  it("a missing ANTHROPIC_API_KEY degrades without any capture or gateway call", async () => {
    await withApiKey(undefined, async () => {
      const fake = new FakeMacRunner();
      const gateway = new FakeGateway();
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as Record<string, unknown>;

      expect(result["ok"]).toBe(false);
      expect(String(result["error"])).toMatch(/ANTHROPIC_API_KEY/);
      expect(fake.calls.length).toBe(0);
      expect(gateway.calls.length).toBe(0);
    });
  });

  it("a capture failure returns the capture's own kind and issues 0 gateway calls", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = [
        { stdout: "", stderr: "could not create image from display", exitCode: 1, timedOut: false },
      ];
      const gateway = new FakeGateway();
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as Record<string, unknown>;

      expect(result["ok"]).toBe(false);
      expect(result["kind"]).toBeDefined();
      expect(gateway.calls.length).toBe(0);
    });
  });

  it("an error chunk from the gateway yields ok:false without throwing", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      gateway.chunks = [{ type: "error", message: "cloud provider unavailable" }];
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = await tool.run({});

      expect((result as Record<string, unknown>)["ok"]).toBe(false);
    });
  });

  it("non-JSON model output yields the parse-failure result with a raw excerpt, never rejects", async () => {
    await withApiKey("test-key", async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      gateway.chunks = [{ type: "token", text: "I'm not going to give you JSON, sorry." }, { type: "done" }];
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as Record<string, unknown>;

      expect(result["ok"]).toBe(false);
      expect(String(result["error"])).toMatch(/parseable JSON/i);
      expect(result["raw"]).toBeDefined();
    });
  });
});
