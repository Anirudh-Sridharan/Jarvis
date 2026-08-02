/**
 * labelMatch.ts — the shared perception-binding label comparison used by the
 * Tier 2 (Accessibility) and Tier 3 (vision) Mac-control tools.
 *
 * Both tiers make the model supply a human-readable `element` string that is
 * surfaced in the approval prompt. That string is only worth anything if it is
 * CHECKED against the thing that will actually be acted on — otherwise a human
 * can approve "click the Save button" while a bare, unrelated ref or
 * coordinate fires. Tier 3 got this check in 15 WR-12; Tier 2 got it in the
 * 15 security audit's UF-03. One implementation, so the two cannot drift.
 */

/** Case/punctuation-insensitive comparison form. */
export function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does the model's human-readable claim describe the element the perception
 * layer actually recorded?
 *
 * Containment either way, so "Save button" still matches a recorded label of
 * "Save" — the check exists to catch an approval prompt that describes a
 * DIFFERENT thing from what will run, not to demand verbatim echoing.
 *
 * An element the perception layer gave no label for cannot contradict
 * anything, so an empty `actual` always matches (many AX elements genuinely
 * have no title/description/value). An empty CLAIM never matches: the model
 * is required to say what it is acting on.
 */
export function labelsMatch(actual: string, claimed: string): boolean {
  const a = normalizeLabel(actual);
  const c = normalizeLabel(claimed);
  if (!a) return true;
  if (!c) return false;
  return a === c || a.includes(c) || c.includes(a);
}
