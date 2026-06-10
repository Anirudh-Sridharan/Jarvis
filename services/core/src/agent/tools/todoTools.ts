/**
 * Todo tools — bridge @jarvis/agent Tool interface to @jarvis/integrations todos.
 *
 * todo_add      — internal write (readOnly:false, but low-risk — no approval required
 *                 per policy since sideEffects:'internal_write')
 * todo_list     — read-only
 * todo_complete — internal write (same low-risk policy)
 *
 * These are registered with readOnly:false so the policy engine can classify them
 * as 'internal_write' (auto_allow by policy) without requiring human approval.
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { IntegrationsSystem } from "@jarvis/integrations";

// ── todo_add ──────────────────────────────────────────────────────────────────

const TodoAddSchema = z.object({
  text: z.string().min(1).describe("Todo item text"),
  due: z.string().optional().describe("ISO-8601 due date (optional)"),
  recurrence: z
    .enum(["daily", "weekly", "weekdays"])
    .optional()
    .describe("Optional recurrence pattern"),
});

export function makeTodoAddTool(
  integrations: Pick<IntegrationsSystem, "todos">,
): Tool {
  // Register as internal_write — auto-allowed by policy, no human approval needed
  registerToolMeta("todo_add", { sideEffects: "internal_write", reversible: true });

  return {
    name: "todo_add",
    description: "Add a new todo item to the task list.",
    schema: TodoAddSchema,
    readOnly: false,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = TodoAddSchema.parse(rawArgs);
      const todo = integrations.todos.addTodo({
        text: args.text,
        due: args.due,
        source: "agent",
        recurrence: args.recurrence ?? null,
      });
      return todo;
    },
  };
}

// ── todo_list ─────────────────────────────────────────────────────────────────

const TodoListSchema = z.object({
  filter: z
    .enum(["all", "open", "done", "overdue", "today"])
    .optional()
    .default("open")
    .describe("Filter todos by status"),
});

export function makeTodoListTool(
  integrations: Pick<IntegrationsSystem, "todos">,
): Tool {
  return {
    name: "todo_list",
    description: "List todo items with optional filter.",
    schema: TodoListSchema,
    readOnly: true,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = TodoListSchema.parse(rawArgs);
      const filter = args.filter ?? "open";

      if (filter === "overdue") {
        return integrations.todos.overdue();
      }

      const status =
        filter === "done" ? "done" :
        filter === "all" ? undefined :
        "open";

      return integrations.todos.listTodos({ status });
    },
  };
}

// ── todo_complete ─────────────────────────────────────────────────────────────

const TodoCompleteSchema = z.object({
  id: z.string().describe("Todo item ID"),
});

export function makeTodoCompleteTool(
  integrations: Pick<IntegrationsSystem, "todos">,
): Tool {
  // Register as internal_write — auto-allowed by policy
  registerToolMeta("todo_complete", { sideEffects: "internal_write", reversible: true });

  return {
    name: "todo_complete",
    description: "Mark a todo item as completed.",
    schema: TodoCompleteSchema,
    readOnly: false,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = TodoCompleteSchema.parse(rawArgs);
      const todo = integrations.todos.completeTodo(args.id);
      return todo;
    },
  };
}
