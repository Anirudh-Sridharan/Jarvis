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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import {
  makeComputerUseTools,
  COMPUTER_MAX_ELEMENTS,
  type VisionGateway,
} from "../src/agent/tools/computerUseTools.js";
import { imageToScreenPoint } from "../src/mac/screenshotRunner.js";
import { SUBROLE_NONE } from "../src/mac/axSnapshot.js";
import type {
  ChatMessage,
  CloudTarget,
  JarvisInferenceRequest,
  InferenceStreamChunk,
} from "../src/inference/types.js";
import { getToolMeta, createAgentSystem } from "@jarvis/agent";
import { FakeLlm, FixedClock, ManualApprovalSink, makeToolRegistry } from "@jarvis/agent/testing";
import { buildToolRegistry } from "../src/agent/tools/index.js";
import { createIntegrations } from "@jarvis/integrations";
import {
  FakeHttp,
  MemoryTokenStore,
  FixedClock as IntegrationsFixedClock,
  FakeLlm as IntegrationsFakeLlm,
} from "@jarvis/integrations/testing";

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

class FakeGateway implements VisionGateway {
  calls: FakeGatewayCall[] = [];
  /** Which cloud provider serves a task hint — the seam computer_screenshot's
   * API-key preflight consults instead of hardcoding Anthropic (15 WR-07). */
  cloudTarget: CloudTarget = "anthropic";
  readonly router = { cloudTargetFor: (): CloudTarget => this.cloudTarget };
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

function toolByName(run: MacCommandRunner, gateway: VisionGateway, name: string) {
  const tool = makeComputerUseTools(run, gateway).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not built`);
  return tool;
}

/** Set/unset env vars for the duration of `fn`, always restoring them. */
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const original = new Map<string, string | undefined>(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withApiKey(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  return withEnv({ ANTHROPIC_API_KEY: value }, fn);
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

  // 15 WR-07: the preflight must follow routing.cloudTaskProviders.reasoning,
  // which CLAUDE.md advertises as rebalanceable without touching code.
  it("checks FIREWORKS_API_KEY when the router routes reasoning to fireworks", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "anthropic-key", FIREWORKS_API_KEY: undefined }, async () => {
      const fake = new FakeMacRunner();
      const gateway = new FakeGateway();
      gateway.cloudTarget = "fireworks";
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as Record<string, unknown>;

      // An ANTHROPIC key is set, but reasoning routes to fireworks — the old
      // hardcoded check would have proceeded into a 401.
      expect(result["ok"]).toBe(false);
      expect(String(result["error"])).toMatch(/FIREWORKS_API_KEY/);
      expect(String(result["error"])).toMatch(/fireworks/);
      expect(fake.calls.length).toBe(0);
      expect(gateway.calls.length).toBe(0);
    });
  });

  it("proceeds on a fireworks-routed run when FIREWORKS_API_KEY is set, with no ANTHROPIC key at all", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined, FIREWORKS_API_KEY: "fireworks-key" }, async () => {
      const fake = new FakeMacRunner();
      fake.responses = RETINA_CAPTURE_SEQUENCE;
      const gateway = new FakeGateway();
      gateway.cloudTarget = "fireworks";
      const tool = toolByName(fake.runner, gateway, "computer_screenshot");

      const result = (await tool.run({})) as Record<string, unknown>;

      expect(result["ok"]).toBe(true);
      expect(gateway.calls.length).toBe(1);
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

// ── computer_click / computer_type — gated, deterministic, zero inference ──────

describe("computer_click / computer_type — gated, zero inference", () => {
  it("makeComputerUseTools returns exactly 3 tools", () => {
    const fake = new FakeMacRunner();
    const gateway = new FakeGateway();
    const tools = makeComputerUseTools(fake.runner, gateway);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["computer_click", "computer_screenshot", "computer_type"].sort(),
    );
  });

  it("registers risk metadata: computer_click/computer_type are mac_action, computer_screenshot is read_only", () => {
    const fake = new FakeMacRunner();
    const gateway = new FakeGateway();
    makeComputerUseTools(fake.runner, gateway);
    expect(getToolMeta("computer_click")?.sideEffects).toBe("mac_action");
    expect(getToolMeta("computer_type")?.sideEffects).toBe("mac_action");
    expect(getToolMeta("computer_screenshot")?.sideEffects).toBe("read_only");
  });

  it("gated: computer_click issues 0 gateway calls and exactly one clickAt runner interaction", async () => {
    const fake = new FakeMacRunner();
    fake.responses = [{ stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0, timedOut: false }];
    const gateway = new FakeGateway();
    const tool = toolByName(fake.runner, gateway, "computer_click");

    const result = (await tool.run({ x: 100, y: 200, element: "Save button" })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(gateway.calls.length).toBe(0);
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.cmd).toBe("/usr/bin/osascript");
  });

  it("gated: computer_type issues 0 gateway calls", async () => {
    const fake = new FakeMacRunner();
    fake.responses = [
      {
        stdout: JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: SUBROLE_NONE }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
      { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0, timedOut: false },
    ];
    const gateway = new FakeGateway();
    const tool = toolByName(fake.runner, gateway, "computer_type");

    const result = (await tool.run({ text: "hello", element: "search box" })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(gateway.calls.length).toBe(0);
  });

  it("computer_click rejects a negative coordinate with 0 runner calls", async () => {
    const fake = new FakeMacRunner();
    const gateway = new FakeGateway();
    const tool = toolByName(fake.runner, gateway, "computer_click");
    await expect(tool.run({ x: -5, y: 10, element: "x" })).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
  });

  it("computer_click rejects a non-integer coordinate with 0 runner calls", async () => {
    const fake = new FakeMacRunner();
    const gateway = new FakeGateway();
    const tool = toolByName(fake.runner, gateway, "computer_click");
    await expect(tool.run({ x: 1.5, y: 10, element: "x" })).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
  });

  it("computer_type refuses a focused secure field — the secret text never reaches recorded argv", async () => {
    const fake = new FakeMacRunner();
    fake.responses = [
      {
        // Real macOS password-field shape: role AXTextField + secure SUBROLE.
        stdout: JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: "AXSecureTextField" }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    ];
    const gateway = new FakeGateway();
    const tool = toolByName(fake.runner, gateway, "computer_type");

    const result = (await tool.run({
      text: "super-secret-password",
      element: "password field",
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/secure field/i);
    expect(JSON.stringify(fake.calls)).not.toContain("super-secret-password");
  });

  it("computer_type's description states credentials are never typed", () => {
    const fake = new FakeMacRunner();
    const gateway = new FakeGateway();
    const tool = toolByName(fake.runner, gateway, "computer_type");
    expect(tool.description).toMatch(/never types? credentials/i);
  });
});

// ── Registry wiring — Tier 3 requires BOTH macRun and visionGateway ────────────

const TIER1_NAMES = [
  "mac_list_apps",
  "mac_frontmost_app",
  "mac_list_shortcuts",
  "mac_open",
  "mac_run_script",
  "mac_run_shortcut",
];
const TIER2_NAMES = ["mac_ui_snapshot", "mac_ui_click", "mac_ui_type", "mac_ui_press_key"];
const TIER3_NAMES = ["computer_screenshot", "computer_click", "computer_type"];
const ALL_MAC_NAMES = [...TIER1_NAMES, ...TIER2_NAMES, ...TIER3_NAMES];

function makeIntegrationsForRegistryTest() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-computer-use-registry-test-"));
  return createIntegrations({
    http: new FakeHttp(),
    clock: new IntegrationsFixedClock(),
    tokenStore: new MemoryTokenStore(),
    llm: new IntegrationsFakeLlm(),
    dataDir: dir,
  });
}

describe("registry wiring — Tier 3 requires both macRun and visionGateway", () => {
  it("buildToolRegistry(integrations, null, macRun, visionGateway) contains all thirteen mac tool names", () => {
    const integrations = makeIntegrationsForRegistryTest();
    const fake = new FakeMacRunner();
    const gateway = new FakeGateway();
    const registry = buildToolRegistry(integrations, null, fake.runner, gateway);
    for (const name of ALL_MAC_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("buildToolRegistry(integrations, null, macRun) contains the ten Tier 1/2 names and none of Tier 3", () => {
    const integrations = makeIntegrationsForRegistryTest();
    const fake = new FakeMacRunner();
    const registry = buildToolRegistry(integrations, null, fake.runner);
    for (const name of [...TIER1_NAMES, ...TIER2_NAMES]) {
      expect(registry.has(name)).toBe(true);
    }
    for (const name of TIER3_NAMES) {
      expect(registry.has(name)).toBe(false);
    }
  });

  it("buildToolRegistry(integrations, null) contains none of the thirteen mac tool names", () => {
    const integrations = makeIntegrationsForRegistryTest();
    const registry = buildToolRegistry(integrations, null);
    for (const name of ALL_MAC_NAMES) {
      expect(registry.has(name)).toBe(false);
    }
  });
});

// ── Tier 3 end-to-end approval ordering — no gate-bypassing loop (15-SC5) ──────

describe("Tier 3 end-to-end approval ordering (15-SC5)", () => {
  it("computer_screenshot runs with zero approvals; computer_click pauses for approval; exactly one gateway call for the whole run", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "jarvis-computer-use-approval-test-"));
    try {
      await withApiKey("test-key", async () => {
        const fake = new FakeMacRunner();
        fake.responses = [
          ...RETINA_CAPTURE_SEQUENCE,
          { stdout: JSON.stringify({ success: true }), stderr: "", exitCode: 0, timedOut: false }, // clickAt
        ];
        const gateway = new FakeGateway();
        gateway.chunks = [
          {
            type: "token",
            text: JSON.stringify({
              description: "a Save button",
              elements: [{ label: "Save", role: "button", x: 700, y: 350 }],
            }),
          },
          { type: "done" },
        ];

        const tools = makeToolRegistry(makeComputerUseTools(fake.runner, gateway));
        const llm = new FakeLlm().setScript([
          JSON.stringify({ tool: "computer_screenshot", args: {} }),
          JSON.stringify({ tool: "computer_click", args: { x: 500, y: 250, element: "Save button" } }),
          JSON.stringify({ tool: "__done__", args: { result: "clicked Save" } }),
        ]);
        const clock = new FixedClock(Date.now());
        const manualSink = new ManualApprovalSink();

        const agentSystem = createAgentSystem({
          llm,
          tools,
          clock,
          dataDir: tmpDir,
          approvalSink: manualSink.sink,
        });

        const runPromise = agentSystem.agent.run("look at the screen and click Save", { source: "manual" });

        // Wait for the screenshot step to run (0 approvals) and the click's
        // approval request to arrive.
        await new Promise((r) => setTimeout(r, 50));

        expect(manualSink.requests.length).toBe(1);
        expect(manualSink.requests[0]!.summary).toContain("computer_click");
        // Only the screenshot's native calls have happened so far — no click yet.
        expect(fake.calls.length).toBe(RETINA_CAPTURE_SEQUENCE.length);

        const requestId = manualSink.requests[0]!.id;
        manualSink.approve(requestId, "test-user");

        await runPromise;

        // Exactly one more native call — the click — after approval.
        expect(fake.calls.length).toBe(RETINA_CAPTURE_SEQUENCE.length + 1);
        // Exactly one gateway call across the ENTIRE run — the single
        // perception call — proving no tool ran an internal sample-and-act loop.
        expect(gateway.calls.length).toBe(1);
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
