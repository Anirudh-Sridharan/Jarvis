/**
 * Reminders & todos skill (feature 18).
 *
 * Operations:
 *   - create: parse natural language → {title, due?, recurrence?} → dedupe → insert
 *   - list: query open todos
 *   - complete: mark a todo done
 *
 * Local store only (feature 13 todo store). No external calls → no approval needed.
 */

import { z } from "zod";
import type { Skill, SkillCtx } from "./registry.js";
import type { SkillResult } from "../types.js";
import { registerToolMeta } from "../safety/policy.js";

registerToolMeta("todo_add", { sideEffects: "internal_write", reversible: true });
registerToolMeta("todo_list", { sideEffects: "read_only", reversible: true });
registerToolMeta("todo_complete", { sideEffects: "internal_write", reversible: true });

const RemindersArgs = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    text: z.string().min(1).max(500),
    due: z.string().optional(), // ISO or natural language
    recurrence: z.string().optional(), // cron or natural language
  }),
  z.object({
    action: z.literal("list"),
    filter: z.enum(["all", "overdue", "today"]).optional().default("all"),
  }),
  z.object({
    action: z.literal("complete"),
    todoId: z.string(),
  }),
]);

export const remindersSkill: Skill = {
  id: "reminders.todo",
  name: "Reminders & Todos",
  description: "Create, list, and complete reminders and todos. Local store only.",
  allowedTools: ["todo_add", "todo_list", "todo_complete"],
  outward: false,
  approvalPolicy: "never",

  async run(rawArgs: unknown, ctx: SkillCtx): Promise<SkillResult> {
    const parsed = RemindersArgs.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        skillId: "reminders.todo",
        status: "clarify",
        summary: "Invalid arguments for reminder",
        artifacts: [],
        actions: [],
        citations: [],
        clarifyQuestion: "What reminder would you like to create or manage?",
      };
    }

    const args = parsed.data;

    if (args.action === "list") {
      try {
        const todos = await ctx.tool("todo_list", { filter: args.filter });
        const items = Array.isArray(todos) ? todos : [];
        return {
          skillId: "reminders.todo",
          status: "ok",
          summary: `Found ${items.length} todos (filter: ${args.filter})`,
          artifacts: items,
          actions: [],
          citations: [],
        };
      } catch (err) {
        return {
          skillId: "reminders.todo",
          status: "error",
          summary: `Could not list todos: ${err instanceof Error ? err.message : String(err)}`,
          artifacts: [],
          actions: [],
          citations: [],
        };
      }
    }

    if (args.action === "complete") {
      try {
        await ctx.tool("todo_complete", { id: args.todoId });
        return {
          skillId: "reminders.todo",
          status: "ok",
          summary: `Todo ${args.todoId} marked complete`,
          artifacts: [],
          actions: [{ type: "todo.complete", status: "done", target: args.todoId }],
          citations: [],
        };
      } catch (err) {
        return {
          skillId: "reminders.todo",
          status: "error",
          summary: `Could not complete todo: ${err instanceof Error ? err.message : String(err)}`,
          artifacts: [],
          actions: [],
          citations: [],
        };
      }
    }

    // action === "create"
    // Dedupe check
    let existing: unknown[];
    try {
      const raw = await ctx.tool("todo_list", { filter: "all" });
      existing = Array.isArray(raw) ? raw : [];
    } catch {
      existing = [];
    }

    const isDuplicate = existing.some((t) => {
      const todo = t as { title?: string; due?: string };
      const titleMatch =
        typeof todo.title === "string" &&
        fuzzyMatch(todo.title, args.text);
      const dueMatch = args.due
        ? todo.due === args.due
        : true;
      return titleMatch && dueMatch;
    });

    if (isDuplicate) {
      return {
        skillId: "reminders.todo",
        status: "ok",
        summary: `Similar reminder already exists: "${args.text}"`,
        artifacts: [],
        actions: [{ type: "todo.create", status: "skipped", reason: "duplicate" }],
        citations: [],
      };
    }

    try {
      const todo = await ctx.tool("todo_add", {
        text: args.text,
        due: args.due,
        recurrence: args.recurrence,
      });

      return {
        skillId: "reminders.todo",
        status: "ok",
        summary: `Created reminder: "${args.text}"`,
        artifacts: [todo],
        actions: [{ type: "todo.create", status: "done" }],
        citations: [],
      };
    } catch (err) {
      return {
        skillId: "reminders.todo",
        status: "error",
        summary: `Could not create todo: ${err instanceof Error ? err.message : String(err)}`,
        artifacts: [],
        actions: [],
        citations: [],
      };
    }
  },
};

/**
 * Very simple fuzzy match: normalized lowercase edit distance <= 3
 * or one string contains the other.
 */
function fuzzyMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Levenshtein distance <= 3 for short strings
  if (Math.abs(na.length - nb.length) > 5) return false;
  return levenshtein(na, nb) <= 3;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]!;
      } else {
        dp[i]![j] =
          1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
      }
    }
  }
  return dp[m]![n]!;
}
