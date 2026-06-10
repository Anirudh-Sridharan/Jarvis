/**
 * Prompt-injection / confused-deputy detection (feature 17).
 *
 * Deterministic scanners over:
 *   - ProposedAction.reasoning (agent's justification)
 *   - ProposedAction.args (serialized)
 *   - ProposedAction.provenance.injectionFlags (pre-tagged by tool output handler)
 *
 * Returns matched flag identifiers. Empty array = clean.
 *
 * These are heuristics, not foolproof. The point is:
 *   1. Known injection patterns are caught deterministically.
 *   2. Anything coming from external content (derivedFromExternal) is escalated.
 *   3. The gate never trusts the LLM's judgment on what is safe.
 */

import type { ProposedAction } from "../types.js";

// ── Injection pattern definitions ──────────────────────────────────────────────

interface InjectionPattern {
  id: string;
  test: (text: string) => boolean;
}

const PATTERNS: InjectionPattern[] = [
  {
    id: "ignore-prev-instructions",
    test: (t) => /ignore\s+(previous|prior|all)\s+instructions?/i.test(t),
  },
  {
    id: "disregard-above",
    test: (t) => /disregard\s+(the\s+)?above/i.test(t),
  },
  {
    id: "new-instructions",
    test: (t) => /new\s+instructions?\s*:/i.test(t),
  },
  {
    id: "system-override",
    test: (t) => /\[system\]|\bsystem\s*:/i.test(t),
  },
  {
    id: "hermes-token",
    test: (t) => /<\|im_start\||<\|system\||<\|endoftext\|>/.test(t),
  },
  {
    id: "act-as-if",
    test: (t) => /act\s+as\s+if\b/i.test(t),
  },
  {
    id: "you-are-now",
    test: (t) => /\byou\s+are\s+now\b/i.test(t),
  },
  {
    id: "forget-everything",
    test: (t) => /forget\s+(everything|all|prior)/i.test(t),
  },
  {
    id: "base64-blob",
    test: (t) => /[A-Za-z0-9+/]{100,}={0,2}/.test(t),
  },
  {
    id: "hidden-unicode",
    // Zero-width chars used to smuggle instructions
    test: (t) => /[​-‏‪-‮﻿]/.test(t),
  },
  {
    id: "prompt-leak",
    test: (t) => /output\s+(your\s+)?(system\s+)?prompt|repeat\s+.*instructions/i.test(t),
  },
];

/**
 * Scan a ProposedAction for injection markers.
 * Returns matched flag identifiers; empty = clean.
 */
export function scanForInjectionMarkers(action: ProposedAction): string[] {
  const flags = new Set<string>(action.provenance.injectionFlags);

  // Scan reasoning
  scanText(action.reasoning, flags);

  // Scan serialized args
  const argsStr = JSON.stringify(action.args);
  scanText(argsStr, flags);

  return [...flags];
}

function scanText(text: string, flags: Set<string>): void {
  for (const pattern of PATTERNS) {
    if (pattern.test(text)) {
      flags.add(pattern.id);
    }
  }
}

/**
 * Scan raw tool output for injection patterns.
 * Returns flag identifiers found.
 */
export function scanToolOutput(output: string): string[] {
  const flags = new Set<string>();
  scanText(output, flags);
  return [...flags];
}

/**
 * Determine if an injection-flagged action should be hard-blocked vs escalated.
 *
 * Hard-block (return "block"):
 *   - hermes tokens (model control tokens)
 *   - hidden unicode
 *   - system-override with suspicious patterns
 *
 * Escalate (return "require_approval"):
 *   - Other patterns from external content
 */
export function severityForFlags(
  flags: string[],
  derivedFromExternal: boolean,
): "block" | "require_approval" | "clean" {
  if (flags.length === 0) return "clean";

  const hardBlockFlags = new Set(["hermes-token", "hidden-unicode"]);
  const hasHardBlock = flags.some((f) => hardBlockFlags.has(f));

  if (hasHardBlock) return "block";
  if (derivedFromExternal) return "require_approval";
  return "block"; // any injection marker from non-external source is suspicious
}
