/**
 * Tests for the immutable hash-chained audit log (feature 17).
 *
 * Covers:
 *   - Hash chain links entries (prevHash of entry N = hash of entry N-1)
 *   - Tampering with any entry breaks verifyChain()
 *   - Genesis entry has correct prevHash
 *   - verifyChain() passes on unmodified chain
 *   - forRun() returns entries for a specific run
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditLog } from "../src/safety/audit.js";

describe("AuditLog hash chain", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first entry has GENESIS prevHash (64 zeros)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    const entry = log.append({
      kind: "classified",
      actionId: "a1",
      runId: "r1",
      payload: { test: true },
    });

    expect(entry.seq).toBe(0);
    expect(entry.prevHash).toBe("0".repeat(64));
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chain: each entry's prevHash equals prior entry's hash", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    const e0 = log.append({ kind: "classified", actionId: "a1", runId: "r1", payload: {} });
    const e1 = log.append({ kind: "decided", actionId: "a1", runId: "r1", payload: {} });
    const e2 = log.append({ kind: "executed", actionId: "a1", runId: "r1", payload: {} });

    expect(e1.prevHash).toBe(e0.hash);
    expect(e2.prevHash).toBe(e1.hash);
  });

  it("verifyChain() returns ok=true for unmodified chain", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    log.append({ kind: "classified", actionId: "a1", runId: "r1", payload: { x: 1 } });
    log.append({ kind: "decided", actionId: "a1", runId: "r1", payload: { y: 2 } });
    log.append({ kind: "approved", actionId: "a1", runId: "r1", payload: { by: "user" } });
    log.append({ kind: "executed", actionId: "a1", runId: "r1", payload: { result: "ok" } });

    const result = log.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });

  it("verifyChain() detects tampered entry (modified payload)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    log.append({ kind: "classified", actionId: "a1", runId: "r1", payload: { x: 1 } });
    log.append({ kind: "decided", actionId: "a2", runId: "r1", payload: { y: 2 } });
    log.append({ kind: "executed", actionId: "a3", runId: "r1", payload: { z: 3 } });

    // Directly tamper with the database — modify the payload of seq 1
    const db = new DatabaseSync(join(tmpDir, "audit.db"));
    db.exec(`UPDATE audit_log SET payload = '{"y": 999}' WHERE seq = 1`);

    const result = log.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("verifyChain() detects deleted entry (chain gap)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    log.append({ kind: "classified", actionId: "a1", runId: "r1", payload: {} });
    log.append({ kind: "decided", actionId: "a1", runId: "r1", payload: {} });
    log.append({ kind: "executed", actionId: "a1", runId: "r1", payload: {} });

    // Delete seq 1 from the DB directly
    const db = new DatabaseSync(join(tmpDir, "audit.db"));
    db.exec(`DELETE FROM audit_log WHERE seq = 1`);

    // Reload the log to get fresh state
    const log2 = new AuditLog(tmpDir);
    const result = log2.verifyChain();
    // seq 2's prevHash now won't match seq 0's hash
    expect(result.ok).toBe(false);
  });

  it("forRun() returns only entries for the specified run", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    log.append({ kind: "classified", actionId: "a1", runId: "run-A", payload: {} });
    log.append({ kind: "classified", actionId: "a2", runId: "run-B", payload: {} });
    log.append({ kind: "executed", actionId: "a1", runId: "run-A", payload: {} });

    const runA = log.forRun("run-A");
    const runB = log.forRun("run-B");

    expect(runA.length).toBe(2);
    expect(runA.every((e) => e.runId === "run-A")).toBe(true);
    expect(runB.length).toBe(1);
  });

  it("count reflects total entries", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    expect(log.count).toBe(0);
    log.append({ kind: "classified", actionId: "a1", runId: "r1", payload: {} });
    log.append({ kind: "decided", actionId: "a1", runId: "r1", payload: {} });
    expect(log.count).toBe(2);
  });

  it("hashes include all fields (changing any field breaks chain)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const log = new AuditLog(tmpDir);

    log.append({ kind: "classified", actionId: "a1", runId: "r1", payload: { data: "original" } });

    // Tamper with action_id
    const db = new DatabaseSync(join(tmpDir, "audit.db"));
    db.exec(`UPDATE audit_log SET action_id = 'tampered' WHERE seq = 0`);

    const result = log.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(0);
  });
});
