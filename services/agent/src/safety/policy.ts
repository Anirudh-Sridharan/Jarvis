/**
 * Risk classification + policy decision engine (feature 17).
 *
 * This is 100% deterministic — no AI judgment. The agent proposes; rules dispose.
 * Implements the Policy DECISION TABLE from the spec.
 *
 * Decision table:
 *   read_only       → auto_allow
 *   internal_write  → auto_allow (own data, reversible)
 *   outward_comm    → require_approval (always)
 *   financial       → require_approval (always; >threshold → double-confirm)
 *   destructive     → require_approval (always; irreversible → double-confirm)
 *   calendar_write  → require_approval (always; delete → double-confirm)
 *   code_exec       → require_approval (always)
 *   browser_action  → require_approval (always; LOCKED — not grantable)
 *   mac_action      → require_approval (always; LOCKED — not grantable)
 *   unknown/new     → require_approval (read-only default fail-safe)
 *
 * "LOCKED" is enforced one layer up, in ApprovalService: see
 * NON_GRANTABLE_RISK_CLASSES below. "require_approval, always" in this table
 * is only honest if an always-allow grant cannot later reverse it.
 */

import type {
  ProposedAction,
  PolicyDecision,
  RiskClass,
  Outcome,
  Clock,
} from "../types.js";
import { scanForInjectionMarkers, severityForFlags } from "./injectionGuards.js";

// ── Tool metadata (registered at startup) ────────────────────────────────────

export interface ToolMeta {
  sideEffects?: RiskClass;
  reversible: boolean;
  /**
   * Standing, approver-facing risk disclosure for this tool (T-15-11).
   * Copied verbatim onto every ApprovalRequest the tool raises and rendered
   * in the human-facing summary, so the sentence a human is supposed to read
   * before approving actually reaches the approval surface rather than only
   * the model-facing tool description.
   *
   * Keep it one or two sentences, and state what CANNOT be guaranteed —
   * that is the part a human needs at the moment of decision. Optional:
   * tools without one behave exactly as before.
   */
  disclosure?: string;
}

const toolRegistry = new Map<string, ToolMeta>();

export function registerToolMeta(tool: string, meta: ToolMeta): void {
  toolRegistry.set(tool, meta);
}

export function getToolMeta(tool: string): ToolMeta | undefined {
  return toolRegistry.get(tool);
}

// ── Decision table ────────────────────────────────────────────────────────────

interface TableEntry {
  defaultOutcome: Outcome;
  requiresApproval: boolean;
}

export const DECISION_TABLE: Record<RiskClass, TableEntry> = {
  read_only: { defaultOutcome: "auto_allow", requiresApproval: false },
  internal_write: { defaultOutcome: "auto_allow", requiresApproval: false },
  outward_comm: { defaultOutcome: "require_approval", requiresApproval: true },
  financial: { defaultOutcome: "require_approval", requiresApproval: true },
  destructive: { defaultOutcome: "require_approval", requiresApproval: true },
  calendar_write: { defaultOutcome: "require_approval", requiresApproval: true },
  code_exec: { defaultOutcome: "require_approval", requiresApproval: true },
  browser_action: { defaultOutcome: "require_approval", requiresApproval: true },
  mac_action: { defaultOutcome: "require_approval", requiresApproval: true },
};

// ── Locked (non-grantable) risk classes ───────────────────────────────────────

/**
 * LOCKED classes: a standing "always allow" grant may never be CREATED for,
 * nor MATCHED against, an action in one of these classes. Every such action
 * reaches a human, every time — one prior decision can never convert the
 * highest-capability tools in the repo into a permanent, ungated
 * planner→native path (15 security audit UF-01).
 *
 * The decision table alone does NOT give this: DECISION_TABLE is evaluated
 * inside classifyAndDecide, while the always-allow grant is applied one layer
 * up in ApprovalService — so "require_approval, always" in the table was
 * silently reversible by a single earlier alwaysAllow decision.
 *
 * Both entries are load-bearing:
 *   browser_action — drives a real browser session; CLAUDE.md has described
 *                    this class as "locked" since the feature-18 slice, and
 *                    this is where the code finally matches that contract.
 *   mac_action     — drives the user's REAL machine: Launch Services,
 *                    arbitrary AppleScript/JXA, synthesized keystrokes,
 *                    screen clicks.
 *
 * Do not weaken. Adding a class here is safe; removing one is a gate change.
 */
export const NON_GRANTABLE_RISK_CLASSES: ReadonlySet<RiskClass> = new Set<RiskClass>([
  "browser_action",
  "mac_action",
]);

/** False for a LOCKED class — see NON_GRANTABLE_RISK_CLASSES. */
export function isGrantableRiskClass(riskClass: RiskClass): boolean {
  return !NON_GRANTABLE_RISK_CLASSES.has(riskClass);
}

// ── Dynamic trigger evaluation ────────────────────────────────────────────────

const FINANCIAL_THRESHOLD = 50; // default $50
const BATCH_THRESHOLD = 5;

interface DynamicTriggerResult {
  escalate: boolean;
  overThreshold: boolean;
  reasons: string[];
  rules: string[];
}

export function evalDynamicTriggers(
  action: ProposedAction,
  riskClass: RiskClass,
): DynamicTriggerResult {
  const reasons: string[] = [];
  const rules: string[] = [];
  let overThreshold = false;

  // Financial amount threshold
  if (riskClass === "financial") {
    const amount = extractAmount(action.args);
    if (amount !== null && amount > FINANCIAL_THRESHOLD) {
      overThreshold = true;
      reasons.push(`amount $${amount} exceeds threshold $${FINANCIAL_THRESHOLD}`);
      rules.push("financial_threshold");
    }
  }

  // New recipient escalation
  if (riskClass === "outward_comm") {
    const recipient = extractRecipient(action.args);
    if (recipient && !isKnownContact(recipient)) {
      reasons.push(`new recipient: ${recipient}`);
      rules.push("new_recipient");
    }
  }

  // Batch threshold
  const items = extractBatchItems(action.args);
  if (items > BATCH_THRESHOLD) {
    reasons.push(`batch of ${items} items exceeds threshold ${BATCH_THRESHOLD}`);
    rules.push("batch_threshold");
  }

  // Taint escalation: args derived from external untrusted content
  if (action.provenance.derivedFromExternal && riskClass !== "read_only") {
    reasons.push("args derived from untrusted external content");
    rules.push("taint_escalation");
  }

  return {
    escalate: reasons.length > 0,
    overThreshold,
    reasons,
    rules,
  };
}

function extractAmount(args: Record<string, unknown>): number | null {
  for (const key of ["amount", "value", "price", "cost", "total"]) {
    const v = args[key];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseFloat(v.replace(/[^0-9.]/g, ""));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function extractRecipient(args: Record<string, unknown>): string | null {
  for (const key of ["to", "recipient", "email", "address"]) {
    const v = args[key];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0] as string;
  }
  return null;
}

// Simple known-contacts stub (in production, queried from feature 5 memory)
const KNOWN_CONTACTS = new Set<string>();
export function addKnownContact(email: string): void {
  KNOWN_CONTACTS.add(email.toLowerCase());
}
export function isKnownContact(email: string): boolean {
  return KNOWN_CONTACTS.has(email.toLowerCase());
}

function extractBatchItems(args: Record<string, unknown>): number {
  for (const key of ["items", "ids", "recipients", "targets", "list"]) {
    const v = args[key];
    if (Array.isArray(v)) return v.length;
  }
  return 1;
}

// ── Main classifyAndDecide ─────────────────────────────────────────────────────

/**
 * Classify a proposed action and produce a PolicyDecision.
 * Pure function — no side effects.
 *
 * NOTE: This is the canonical implementation of the decision table from
 * features/17-action-approval-and-safety-gate.md.
 */
export function classifyAndDecide(
  action: ProposedAction,
  toolMeta?: ToolMeta,
  clock?: Clock,
): PolicyDecision {
  const reasons: string[] = [];
  const triggeredRules: string[] = [];
  const decidedAt = clock ? clock.isoNow() : new Date().toISOString();

  // 1. Determine risk class (unknown capability → outward_comm as fail-safe)
  const riskClass: RiskClass = toolMeta?.sideEffects ?? "outward_comm";
  if (!toolMeta) {
    reasons.push("unknown capability: read-only default (treated as outward_comm)");
    triggeredRules.push("unknown_capability");
  }

  // 2. Injection / confused-deputy scan — overrides everything.
  //    Severity policy (see injectionGuards.severityForFlags):
  //      - hard-block flags (model control tokens, hidden unicode) → block
  //      - soft flags from external/untrusted content → require_approval
  //      - soft flags NOT from external content → block (suspicious agent state)
  const injectionFlags = scanForInjectionMarkers(action);
  const injectionSeverity = severityForFlags(
    injectionFlags,
    action.provenance.derivedFromExternal,
  );
  if (injectionSeverity === "block") {
    triggeredRules.push("injection_marker");
    return {
      actionId: action.id,
      riskClass,
      outcome: "block",
      reasons: ["injection markers detected: " + injectionFlags.join(", ")],
      triggeredRules,
      requiresDoubleConfirm: false,
      decidedAt,
    };
  }
  if (injectionSeverity === "require_approval") {
    reasons.push(
      "injection markers in external content: " + injectionFlags.join(", "),
    );
    triggeredRules.push("injection_marker");
  }

  // 3. Base outcome from decision table
  const tableEntry = DECISION_TABLE[riskClass];
  let outcome: Outcome = tableEntry.defaultOutcome;

  // 4. Dynamic triggers (can only RAISE friction, never lower it)
  const dynamic = evalDynamicTriggers(action, riskClass);
  if (dynamic.escalate) {
    outcome = "require_approval";
    reasons.push(...dynamic.reasons);
    triggeredRules.push(...dynamic.rules);
  }

  // 4b. Injection escalation (can only RAISE friction)
  if (injectionSeverity === "require_approval") {
    outcome = "require_approval";
  }

  // 5. If base class requires approval and nothing overrides, require it
  if (tableEntry.requiresApproval && outcome !== "block") {
    outcome = "require_approval";
  }

  // 6. requiresDoubleConfirm
  const requiresDoubleConfirm =
    (riskClass === "destructive" && toolMeta?.reversible === false) ||
    (riskClass === "financial" && dynamic.overThreshold) ||
    (riskClass === "calendar_write" && action.tool.toLowerCase().includes("delete"));

  if (reasons.length === 0) {
    reasons.push("policy default");
  }

  return {
    actionId: action.id,
    riskClass,
    outcome,
    reasons,
    triggeredRules,
    requiresDoubleConfirm,
    decidedAt,
  };
}
