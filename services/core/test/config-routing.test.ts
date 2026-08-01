/**
 * config-routing.test.ts
 *
 * Proves the REAL config/models.yaml (not a fixture) encodes the D-04
 * Fireworks/Anthropic split via loadConfig(), and that the routingSchema's
 * `.default()` idiom lets a models.yaml with no `routing:` cloud-provider
 * block still resolve to the same D-04 defaults. Imports ONLY loadConfig
 * from ../src/config.js — router/registry/gateway are mid-refactor during
 * this task (Task 1) and would break this run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/config-routing.test.ts -> services/core/test -> services/core -> services -> <root>
const REAL_MODELS_YAML = resolve(__dirname, "..", "..", "..", "config", "models.yaml");

let savedModelsConfig: string | undefined;

beforeAll(() => {
  savedModelsConfig = process.env["JARVIS_MODELS_CONFIG"];
  process.env["JARVIS_MODELS_CONFIG"] = REAL_MODELS_YAML;
});

afterAll(() => {
  if (savedModelsConfig === undefined) delete process.env["JARVIS_MODELS_CONFIG"];
  else process.env["JARVIS_MODELS_CONFIG"] = savedModelsConfig;
});

describe("loadConfig() against the real config/models.yaml", () => {
  it("resolves cloudTaskProviders to the D-04 split", () => {
    const cfg = loadConfig();
    expect(cfg.routing.cloudTaskProviders).toEqual({
      consolidation: "fireworks",
      reasoning: "anthropic",
      agent: "anthropic",
    });
  });

  it("resolves defaultCloudProvider and agentPreferCloud", () => {
    const cfg = loadConfig();
    expect(cfg.routing.defaultCloudProvider).toBe("fireworks");
    expect(cfg.routing.agentPreferCloud).toBe(true);
  });

  it("contains a default fireworks-heavy chat entry", () => {
    const cfg = loadConfig();
    const entry = cfg.registry.find(
      (e) => e.provider === "fireworks" && e.kind === "chat",
    );
    expect(entry).toBeDefined();
    expect(entry?.modelRef).toBe("accounts/fireworks/models/qwen3p7-plus");
    expect(entry?.default).toBe(true);
  });

  it("contains a default anthropic-agent chat entry", () => {
    const cfg = loadConfig();
    const entry = cfg.registry.find(
      (e) => e.provider === "anthropic" && e.kind === "chat",
    );
    expect(entry).toBeDefined();
    expect(entry?.modelRef).toBe("claude-sonnet-5");
    expect(entry?.default).toBe(true);
  });

  it("has no hf registry entries and no gpt-5-mini modelRef", () => {
    const cfg = loadConfig();
    expect(cfg.registry.some((e) => e.provider === "hf")).toBe(false);
    expect(cfg.registry.some((e) => e.modelRef === "gpt-5-mini")).toBe(false);
  });

  it("exposes fireworks/anthropic env keys and no hf env keys", () => {
    const cfg = loadConfig();
    // Assert key PRESENCE only — never assert a value, since the real
    // environment may or may not have live keys set.
    expect("fireworksApiKey" in cfg.env).toBe(true);
    expect("fireworksEndpointUrl" in cfg.env).toBe(true);
    expect("anthropicApiKey" in cfg.env).toBe(true);
    expect("anthropicEndpointUrl" in cfg.env).toBe(true);
    expect("hfEndpointUrl" in cfg.env).toBe(false);
    expect("hfToken" in cfg.env).toBe(false);
  });
});

describe("loadConfig() defaults when the cloud-provider routing block is omitted", () => {
  let tmpDir: string;
  let tmpYamlPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "jarvis-models-yaml-"));
    tmpYamlPath = join(tmpDir, "models.yaml");
    // No `routing:` key at all — proves the routingSchema `.default()` idiom,
    // not a required-field, so an operator can omit the whole block.
    writeFileSync(
      tmpYamlPath,
      [
        "models:",
        "  - id: local-chat",
        "    kind: chat",
        "    provider: mlx",
        "    modelRef: fake/local-chat",
        "    default: true",
        "  - id: fireworks-heavy",
        "    kind: chat",
        "    provider: fireworks",
        "    modelRef: fake/fireworks-heavy",
        "    default: true",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("still parses and defaults to the D-04 split", () => {
    const saved = process.env["JARVIS_MODELS_CONFIG"];
    process.env["JARVIS_MODELS_CONFIG"] = tmpYamlPath;
    try {
      const cfg = loadConfig();
      expect(cfg.routing.cloudTaskProviders).toEqual({
        consolidation: "fireworks",
        reasoning: "anthropic",
        agent: "anthropic",
      });
      expect(cfg.routing.defaultCloudProvider).toBe("fireworks");
      expect(cfg.routing.agentPreferCloud).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["JARVIS_MODELS_CONFIG"];
      else process.env["JARVIS_MODELS_CONFIG"] = saved;
    }
  });
});
