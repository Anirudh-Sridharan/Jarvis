/**
 * TXT-09 contract test — external-channel (iMessage) provenance safety gate.
 *
 * Phase 9 ("iMessage Channel — Leaf Package & Safety Logic") introduces a new
 * @jarvis/imessage leaf package that reads chat.db and replies via
 * Messages.app, but ChatCore.send() has ZERO tool-calling capability today —
 * there is no live path from a texted message to an agent ProposedAction yet
 * (verified via full source trace; see 09-RESEARCH.md
 * "TXT-09: What This Phase Can Actually Prove"). Building that wiring is out
 * of this milestone's scope.
 *
 * What this file DOES prove, ahead of that future wiring: the safety net is
 * already correctly shaped. The contract every future untrusted-input
 * channel (iMessage now, any later channel) MUST honor is —
 *
 *   A ProposedAction whose args derive from texted content MUST set
 *   provenance.derivedFromExternal = true and SHOULD tag
 *   provenance.sources with the channel name (e.g. "imessage"). Given that
 *   tagging, the existing taint_escalation rule in
 *   services/agent/src/safety/policy.ts guarantees NO non-read-only action
 *   is ever auto-approved — for every one of the seven non-read-only risk
 *   classes, including internal_write (which auto-allows in the untainted
 *   case) and the unknown-capability fail-safe.
 *
 * This is a contract pin, not an end-to-end exercise: classifyAndDecide() is
 * exercised directly (pure function — no ApprovalService/AuditLog/sink
 * needed; see 09-PATTERNS.md), with hand-built ProposedActions standing in
 * for what a future iMessage→agent bridge would propose. Zero production
 * code in @jarvis/agent changes for this plan — the gate already satisfies
 * the contract; this is the milestone-traceable regression test future
 * Phase 10+ wiring must keep green.
 */

import { describe, it, expect } from "vitest";
import { classifyAndDecide } from "../src/safety/policy.js";
import type { ProposedAction, RiskClass } from "../src/types.js";

// Redeclared locally — identical shape to policy.test.ts:25-44's
// module-local builder (not exported from that file, per 09-PATTERNS.md).
function makeAction(
  tool: string,
  args: Record<string, unknown> = {},
  overrides: Partial<ProposedAction> = {},
): ProposedAction {
  return {
    id: "test-action-1",
    runId: "test-run-1",
    tool,
    args,
    reasoning: "Testing the tool",
    provenance: {
      derivedFromExternal: false,
      sources: [],
      injectionFlags: [],
    },
    proposedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Provenance tag a real iMessage→agent bridge would attach (Phase 10+). */
const IMESSAGE_TAINT = {
  derivedFromExternal: true,
  sources: ["imessage"],
  injectionFlags: [],
} as const;

// Typed against the RiskClass union (not a bare string array): if a new
// RiskClass value is ever added to services/agent/src/types.ts, this object
// literal fails to type-check until the new member is explicitly added here
// (or the type is updated to exclude it) — forcing this contract to be
// reconsidered for the new class rather than silently under-covering it.
const NON_READ_ONLY_RISK_CLASSES: Record<Exclude<RiskClass, "read_only">, true> = {
  internal_write: true,
  outward_comm: true,
  financial: true,
  destructive: true,
  calendar_write: true,
  code_exec: true,
  browser_action: true,
};

const nonReadOnlyRiskClasses = Object.keys(
  NON_READ_ONLY_RISK_CLASSES,
) as Array<keyof typeof NON_READ_ONLY_RISK_CLASSES>;

describe("external-channel provenance (TXT-09 contract, phase 9 — iMessage)", () => {
  describe("iMessage-tainted actions are never auto-approved, for every non-read-only risk class", () => {
    for (const riskClass of nonReadOnlyRiskClasses) {
      it(`${riskClass}: derivedFromExternal + sources=["imessage"] → require_approval, taint_escalation, never auto_allow`, () => {
        const action = makeAction(
          "some_tool",
          { detail: "text-derived arg" },
          { provenance: { ...IMESSAGE_TAINT } },
        );
        const decision = classifyAndDecide(action, {
          sideEffects: riskClass,
          reversible: false,
        });
        expect(decision.outcome).toBe("require_approval");
        expect(decision.outcome).not.toBe("auto_allow");
        expect(decision.triggeredRules).toContain("taint_escalation");
      });
    }
  });

  it("load-bearing flip: internal_write auto-allows untainted, but iMessage-tainted internal_write requires approval", () => {
    const untaintedAction = makeAction("write_note", { text: "a note" });
    const baseline = classifyAndDecide(untaintedAction, {
      sideEffects: "internal_write",
      reversible: true,
    });
    expect(baseline.outcome).toBe("auto_allow");
    expect(baseline.triggeredRules).not.toContain("taint_escalation");

    const taintedAction = makeAction(
      "write_note",
      { text: "a note derived from a text message" },
      { provenance: { ...IMESSAGE_TAINT } },
    );
    const tainted = classifyAndDecide(taintedAction, {
      sideEffects: "internal_write",
      reversible: true,
    });
    expect(tainted.outcome).toBe("require_approval");
    expect(tainted.triggeredRules).toContain("taint_escalation");
  });

  it("unknown-capability fail-safe: no toolMeta + iMessage-tainted provenance → require_approval (never auto-allowed)", () => {
    const action = makeAction(
      "some_never_registered_tool",
      { detail: "text-derived arg" },
      { provenance: { ...IMESSAGE_TAINT } },
    );
    const decision = classifyAndDecide(action, undefined);
    expect(decision.riskClass).toBe("outward_comm");
    expect(decision.outcome).toBe("require_approval");
    expect(decision.outcome).not.toBe("auto_allow");
    expect(decision.triggeredRules).toContain("unknown_capability");
  });

  it("boundary: read_only with iMessage-tainted provenance does NOT fire taint_escalation (reads stay cheap, by design)", () => {
    const action = makeAction(
      "search",
      { query: "text-derived query" },
      { provenance: { ...IMESSAGE_TAINT } },
    );
    const decision = classifyAndDecide(action, {
      sideEffects: "read_only",
      reversible: true,
    });
    expect(decision.outcome).toBe("auto_allow");
    expect(decision.triggeredRules).not.toContain("taint_escalation");
  });
});
