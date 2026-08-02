/**
 * Hermetic arg-parsing tests for the SC2 live recall probe CLI.
 *
 * Only the side-effect-free args module is exercised here — the CLI
 * entrypoint (evalRecall.ts) is never imported, so its loadEnv side effect
 * can never leak a developer's real .env into the test process (repo
 * invariant, WR-03 precedent from browserUseEval.test.ts).
 */
import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import {
  parseEvalRecallArgs,
  resolveOutPathWithinRepo,
  DEFAULT_OUT_PATH,
  DEFAULT_K,
  DEFAULT_CANARIES,
  MAX_K,
  MAX_CANARIES,
} from "../src/cli/evalRecallArgs.js";

describe("parseEvalRecallArgs", () => {
  it("defaults to no help, no dry-run, DEFAULT_K, DEFAULT_CANARIES, and the default --out path", () => {
    const args = parseEvalRecallArgs([]);
    expect(args).toEqual({
      help: false,
      dryRun: false,
      k: DEFAULT_K,
      canaries: DEFAULT_CANARIES,
      out: DEFAULT_OUT_PATH,
    });
  });

  it("--help sets the flag", () => {
    expect(parseEvalRecallArgs(["--help"]).help).toBe(true);
  });

  it("-h sets the flag", () => {
    expect(parseEvalRecallArgs(["-h"]).help).toBe(true);
  });

  it("--dry-run sets the flag", () => {
    expect(parseEvalRecallArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("--out overrides the default output path (parser is a pure pass-through; containment is enforced at resolution, not here)", () => {
    // The parser deliberately accepts any string — repo containment is a
    // property of path RESOLUTION and is enforced by
    // resolveOutPathWithinRepo() (tested below), which evalRecall.ts calls
    // before any dry-run or live work (WR-02).
    expect(parseEvalRecallArgs(["--out", "/tmp/custom-recall-eval.json"]).out).toBe(
      "/tmp/custom-recall-eval.json",
    );
  });

  it("--out with no following value throws", () => {
    expect(() => parseEvalRecallArgs(["--out"])).toThrow(/--out requires a path argument/);
  });

  it("--k 12 sets k", () => {
    expect(parseEvalRecallArgs(["--k", "12"]).k).toBe(12);
  });

  it("--k 0 throws naming the valid range", () => {
    expect(() => parseEvalRecallArgs(["--k", "0"])).toThrow(new RegExp(`1 and ${MAX_K}`));
  });

  it("--k -1 throws naming the valid range", () => {
    expect(() => parseEvalRecallArgs(["--k", "-1"])).toThrow(new RegExp(`1 and ${MAX_K}`));
  });

  it("--k abc throws naming the valid range", () => {
    expect(() => parseEvalRecallArgs(["--k", "abc"])).toThrow(new RegExp(`1 and ${MAX_K}`));
  });

  it("--k 999 throws naming the valid range", () => {
    expect(() => parseEvalRecallArgs(["--k", "999"])).toThrow(new RegExp(`1 and ${MAX_K}`));
  });

  it("--canaries 5 sets canaries", () => {
    expect(parseEvalRecallArgs(["--canaries", "5"]).canaries).toBe(5);
  });

  it("--canaries 0 throws naming the valid range", () => {
    expect(() => parseEvalRecallArgs(["--canaries", "0"])).toThrow(new RegExp(`1 and ${MAX_CANARIES}`));
  });

  it("--canaries 99 throws naming the valid range", () => {
    expect(() => parseEvalRecallArgs(["--canaries", "99"])).toThrow(new RegExp(`1 and ${MAX_CANARIES}`));
  });

  it("rejects an unknown flag", () => {
    expect(() => parseEvalRecallArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("resolveOutPathWithinRepo (WR-02 containment — the path-traversal mitigation must enforce, not decorate)", () => {
  const repoRoot = resolve("/repo/jarvis");

  it("resolves a relative path inside the repo", () => {
    expect(resolveOutPathWithinRepo(repoRoot, "out/baseline.json")).toBe(
      resolve(repoRoot, "out/baseline.json"),
    );
  });

  it("resolves the default out path inside the repo", () => {
    const resolved = resolveOutPathWithinRepo(repoRoot, DEFAULT_OUT_PATH);
    expect(resolved.startsWith(repoRoot + sep)).toBe(true);
  });

  it("rejects an absolute path outside the repo", () => {
    expect(() => resolveOutPathWithinRepo(repoRoot, "/tmp/escape.json")).toThrow(
      /--out must resolve inside the repo/,
    );
  });

  it("rejects a ../ relative escape", () => {
    expect(() => resolveOutPathWithinRepo(repoRoot, "../../../outside.json")).toThrow(
      /--out must resolve inside the repo/,
    );
  });

  it("rejects a prefix-cousin directory (repo root + suffix without a separator)", () => {
    // /repo/jarvis-evil starts with the string "/repo/jarvis" but is NOT
    // inside it — the containment check must compare against root + sep,
    // not a bare startsWith(root).
    expect(() => resolveOutPathWithinRepo(repoRoot, `${repoRoot}-evil/out.json`)).toThrow(
      /--out must resolve inside the repo/,
    );
  });

  it("accepts an absolute path that is inside the repo", () => {
    expect(resolveOutPathWithinRepo(repoRoot, `${repoRoot}/sub/out.json`)).toBe(
      resolve(repoRoot, "sub/out.json"),
    );
  });
});
