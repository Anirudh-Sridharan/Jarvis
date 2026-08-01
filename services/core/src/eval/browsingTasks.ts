/**
 * Shared browsing-eval task definitions and grading rule (SC3).
 *
 * The Browser Use Cloud v2 client (browserUseClient.ts, this plan) and the
 * Playwright-MCP/agent side of the eval (plan 13.3-04) both run against
 * these exact three definitions and grade with the same gradeAnswer()
 * predicate — that is what makes "Browser Use got 3/3 in 40s, the Playwright
 * slice got 2/3 in 95s" a real, apples-to-apples comparison rather than two
 * anecdotes (13.3-CONTEXT.md D-03).
 *
 * All three tasks target public sandbox/reference sites that need no login,
 * per 13.3-RESEARCH.md's Security Domain guidance: an eval task must need no
 * credential of its own.
 */

export interface BrowsingEvalTask {
  /** Stable identifier — quoted verbatim by plan 13.3-04 and tabled by 13.3-05. */
  id: string;
  /** Path-neutral instruction: reads sensibly both as a Browser Use task string
   *  and as an agent `goal`. */
  prompt: string;
  /** The page the task starts from. */
  url: string;
  /** Substring the graded answer must contain (case/whitespace-insensitive). */
  expectedContains: string;
  /** True only for the one task that forces a real form interaction. */
  requiresInteraction: boolean;
  /** Where the expected value comes from, so a future reader can re-verify
   *  if the target site's content ever changes. */
  groundTruthNote: string;
}

export const BROWSING_EVAL_TASKS: BrowsingEvalTask[] = [
  {
    id: "e1-js-extract",
    url: "https://quotes.toscrape.com/js/",
    prompt:
      "Open https://quotes.toscrape.com/js/ and report the author of the first quote listed on the page.",
    expectedContains: "Albert Einstein",
    requiresInteraction: false,
    groundTruthNote:
      "quotes.toscrape.com/js/ injects its quote list via JavaScript (this measures rendering, not just " +
      "fetching); the first quote's author is Albert Einstein as authored 2026-08-01 — re-verify by " +
      "loading the page directly if the fixture data ever changes.",
  },
  {
    id: "e2-multi-step-nav",
    url: "https://books.toscrape.com/",
    prompt:
      "Open https://books.toscrape.com/, navigate to the Travel category, and report the title of the " +
      "first book listed there.",
    expectedContains: "It's Only the Himalayas",
    requiresInteraction: false,
    groundTruthNote:
      "books.toscrape.com's Travel category first-listed title is \"It's Only the Himalayas\" as authored " +
      "2026-08-01 (this measures multi-page navigation) — re-verify against the live category page if the " +
      "fixture catalog is ever reordered.",
  },
  {
    id: "e3-interaction",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    prompt:
      'Open https://en.wikipedia.org/wiki/Main_Page, use the page\'s search box to search for "Apple M3", ' +
      "and report the year the chip was announced.",
    expectedContains: "2023",
    requiresInteraction: true,
    groundTruthNote:
      "Apple announced the M3 chip in October 2023 (public record); the Wikipedia \"Apple M3\" article " +
      "should reflect this. This is the task that forces a real form interaction, which on the Playwright " +
      "side rides the locked browser_action approval class — that asymmetry is the point of including it.",
  },
];

const WHITESPACE_RE = /\s+/g;

function normalize(value: string): string {
  return value.toLowerCase().replace(WHITESPACE_RE, " ").trim();
}

/**
 * Single shared grading rule (13.3-CONTEXT.md D-09: evidence discipline —
 * one predicate, used identically by both sides of the comparison). A
 * case-insensitive, whitespace-tolerant substring check over the graded
 * answer; never trusts a provider's own self-reported success flag.
 */
export function gradeAnswer(answer: string | null | undefined, task: BrowsingEvalTask): boolean {
  if (!answer) return false;
  return normalize(answer).includes(normalize(task.expectedContains));
}
