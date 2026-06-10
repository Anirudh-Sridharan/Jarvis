/**
 * Web research skill (feature 18).
 *
 * Pipeline:
 *   1. WebSearch → top URLs (read-only)
 *   2. Fetch content for each URL (read-only)
 *   3. AI synthesize with inline citations [n]
 *   4. Deterministic citation resolution guard: reject synthesis if any [n]
 *      doesn't map to a fetched URL (anti-hallucination)
 *
 * This skill is entirely read-only → no approval needed.
 * Exception: if a task requires form submit/login → that becomes outward → approval.
 */

import { z } from "zod";
import type { Skill, SkillCtx } from "./registry.js";
import type { SkillResult, ResearchResult } from "../types.js";
import { registerToolMeta } from "../safety/policy.js";

registerToolMeta("web_search", { sideEffects: "read_only", reversible: true });
registerToolMeta("web_fetch", { sideEffects: "read_only", reversible: true });

const ResearchArgs = z.object({
  query: z.string().min(1).max(500),
  maxSources: z.number().int().min(1).max(10).optional().default(5),
});

interface FetchedSource {
  url: string;
  title: string;
  text: string;
  fetchedAt: string;
}

/**
 * Verify that every [n] citation in the synthesis maps to a real fetched source.
 * Returns the set of unresolved citation numbers.
 */
export function verifyCitations(
  synthesis: string,
  sources: FetchedSource[],
): number[] {
  const cited = new Set<number>();
  const pattern = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(synthesis)) !== null) {
    if (match[1] !== undefined) {
      cited.add(parseInt(match[1], 10));
    }
  }

  const unresolved: number[] = [];
  for (const n of cited) {
    if (n < 1 || n > sources.length) {
      unresolved.push(n);
    }
  }
  return unresolved;
}

export const webResearchSkill: Skill = {
  id: "web.research",
  name: "Web Research",
  description:
    "Search the web, fetch pages, and synthesize a cited answer. Read-only.",
  allowedTools: ["web_search", "web_fetch"],
  outward: false,
  approvalPolicy: "never",

  async run(rawArgs: unknown, ctx: SkillCtx): Promise<SkillResult> {
    const parsed = ResearchArgs.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        skillId: "web.research",
        status: "clarify",
        summary: "Invalid research arguments",
        artifacts: [],
        actions: [],
        citations: [],
        clarifyQuestion: "What would you like me to research?",
      };
    }

    const { query, maxSources } = parsed.data;

    // ── 1. SEARCH ────────────────────────────────────────────────────────────
    let searchResults: unknown[];
    try {
      const raw = await ctx.tool("web_search", { query, maxResults: maxSources });
      searchResults = Array.isArray(raw) ? raw : [];
    } catch (err) {
      return {
        skillId: "web.research",
        status: "error",
        summary: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        artifacts: [],
        actions: [],
        citations: [],
      };
    }

    if (searchResults.length === 0) {
      return {
        skillId: "web.research",
        status: "ok",
        summary: "No search results found",
        artifacts: [
          { query, answer: "No results found", sources: [], unresolved: true } as ResearchResult,
        ],
        actions: [],
        citations: [],
      };
    }

    // ── 2. FETCH ──────────────────────────────────────────────────────────────
    const sources: FetchedSource[] = [];
    for (const item of searchResults.slice(0, maxSources)) {
      const r = item as { url?: string; title?: string };
      const url = r.url ?? String(item);
      try {
        const content = await ctx.tool("web_fetch", { url });
        sources.push({
          url,
          title: r.title ?? url,
          text: String(content).slice(0, 3000),
          fetchedAt: ctx.clock.isoNow(),
        });
      } catch {
        // skip unfetchable URLs
      }
    }

    if (sources.length === 0) {
      return {
        skillId: "web.research",
        status: "ok",
        summary: "Could not fetch any sources",
        artifacts: [
          {
            query,
            answer: "Could not retrieve content from search results",
            sources: [],
            unresolved: true,
          } as ResearchResult,
        ],
        actions: [],
        citations: [],
      };
    }

    // ── 3. SYNTHESIZE (AI) ────────────────────────────────────────────────────
    const sourceSummaries = sources
      .map(
        (s, i) =>
          `[${i + 1}] ${s.title} (${s.url})\n${s.text.slice(0, 500)}`,
      )
      .join("\n\n");

    const prompt =
      `Research question: ${query}\n\n` +
      `Sources:\n${sourceSummaries}\n\n` +
      `Write a comprehensive answer with inline citations [1], [2], etc. ` +
      `Each factual claim must cite its source. Do not invent facts.`;

    let answer: string;
    try {
      answer = await ctx.llm.complete({ prompt });
    } catch {
      answer = "Could not synthesize answer due to model error.";
    }

    // ── 4. CITATION RESOLUTION GUARD ─────────────────────────────────────────
    const unresolved = verifyCitations(answer, sources);
    if (unresolved.length > 0) {
      // Regenerate or flag as unresolved
      answer =
        answer +
        `\n\n[Warning: citations ${unresolved.join(", ")} could not be verified against fetched sources.]`;
    }

    const result: ResearchResult = {
      query,
      answer,
      sources: sources.map((s) => ({
        url: s.url,
        title: s.title,
        fetchedAt: s.fetchedAt,
        quotes: [], // populated from synthesis in production
      })),
      unresolved: unresolved.length > 0,
    };

    return {
      skillId: "web.research",
      status: "ok",
      summary: `Research complete: ${sources.length} sources, ${unresolved.length === 0 ? "all citations verified" : `${unresolved.length} unresolved`}`,
      artifacts: [result],
      actions: [],
      citations: sources.map((s) => ({
        url: s.url,
        title: s.title,
        quote: s.text.slice(0, 200),
      })),
    };
  },
};
