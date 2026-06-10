/**
 * Todo store tests:
 *   - CRUD: addTodo, completeTodo, snoozeTodo, listTodos, getTodo
 *   - overdue(): returns all open todos with due < now
 *   - agent vs user source distinction
 *   - Recurrence: completing a recurring todo spawns next instance
 *   - Snooze: increments snoozedCount, updates due date
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../src/db/schema.js";
import { TodoStore, computeNextDue } from "../src/work/todos.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  applySchema(db);
  return db;
}

describe("TodoStore", () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore(makeDb());
  });

  describe("addTodo", () => {
    it("creates a new open todo", () => {
      const todo = store.addTodo({ text: "Write tests", source: "user" });

      expect(todo.id).toBeDefined();
      expect(todo.text).toBe("Write tests");
      expect(todo.status).toBe("open");
      expect(todo.source).toBe("user");
      expect(todo.snoozedCount).toBe(0);
      expect(todo.createdAt).toBeDefined();
    });

    it("throws when text is empty", () => {
      expect(() => store.addTodo({ text: "  ", source: "user" })).toThrow("todo text is required");
    });

    it("creates todo with due date", () => {
      const due = "2026-06-10T09:00:00.000Z";
      const todo = store.addTodo({ text: "Meeting prep", source: "user", due });
      expect(todo.due).toBe(due);
    });

    it("creates agent-sourced todo", () => {
      const todo = store.addTodo({
        text: "Review PR #101",
        source: "agent",
        links: [{ type: "github", url: "https://github.com/user/repo/pull/101" }],
      });
      expect(todo.source).toBe("agent");
      expect(todo.links).toHaveLength(1);
    });
  });

  describe("completeTodo", () => {
    it("marks todo as done", () => {
      const todo = store.addTodo({ text: "Ship it", source: "user" });
      const done = store.completeTodo(todo.id);

      expect(done.status).toBe("done");
      expect(done.completedAt).toBeDefined();
    });

    it("throws for non-existent todo", () => {
      expect(() => store.completeTodo("nonexistent-id")).toThrow("Todo not found");
    });

    it("idempotent: completing an already-done todo returns the todo", () => {
      const todo = store.addTodo({ text: "Done", source: "user" });
      store.completeTodo(todo.id);
      // Should not throw
      const result = store.completeTodo(todo.id);
      expect(result.status).toBe("done");
    });

    it("spawns next instance for daily recurring todos", () => {
      const todo = store.addTodo({
        text: "Daily standup notes",
        source: "user",
        due: "2026-06-09T09:00:00.000Z",
        recurrence: "daily",
      });

      store.completeTodo(todo.id);

      const open = store.listTodos({ status: "open" });
      expect(open).toHaveLength(1);
      expect(open[0]?.text).toBe("Daily standup notes");
      expect(open[0]?.recurrence).toBe("daily");
      // Next due should be the day after
      expect(open[0]?.due).toContain("2026-06-10");
    });

    it("spawns next instance for weekly recurring todos", () => {
      const todo = store.addTodo({
        text: "Weekly review",
        source: "user",
        due: "2026-06-09T09:00:00.000Z",
        recurrence: "weekly",
      });

      store.completeTodo(todo.id);

      const open = store.listTodos({ status: "open" });
      expect(open).toHaveLength(1);
      expect(open[0]?.due).toContain("2026-06-16");
    });

    it("spawns next instance for weekdays, skipping weekends", () => {
      // June 13 is Saturday
      const todo = store.addTodo({
        text: "Weekday check",
        source: "user",
        due: "2026-06-13T09:00:00.000Z", // Saturday
        recurrence: "weekdays",
      });

      store.completeTodo(todo.id);

      const open = store.listTodos({ status: "open" });
      // Next weekday after Saturday = Monday June 15
      expect(open[0]?.due).toContain("2026-06-15");
    });
  });

  describe("snoozeTodo", () => {
    it("updates due date and increments snoozedCount", () => {
      const todo = store.addTodo({ text: "Review PR", source: "user", due: "2026-06-09T09:00:00.000Z" });
      const snoozed = store.snoozeTodo(todo.id, "2026-06-10T09:00:00.000Z");

      expect(snoozed.due).toBe("2026-06-10T09:00:00.000Z");
      expect(snoozed.snoozedCount).toBe(1);
    });

    it("multiple snoozes accumulate count", () => {
      const todo = store.addTodo({ text: "Overdue task", source: "user", due: "2026-06-01T09:00:00.000Z" });
      store.snoozeTodo(todo.id, "2026-06-02T09:00:00.000Z");
      const twice = store.snoozeTodo(todo.id, "2026-06-03T09:00:00.000Z");

      expect(twice.snoozedCount).toBe(2);
    });
  });

  describe("listTodos", () => {
    beforeEach(() => {
      store.addTodo({ text: "User todo 1", source: "user" });
      store.addTodo({ text: "User todo 2", source: "user" });
      store.addTodo({ text: "Agent todo", source: "agent" });
    });

    it("lists all todos by default", () => {
      const todos = store.listTodos();
      expect(todos).toHaveLength(3);
    });

    it("filters by source", () => {
      const agentTodos = store.listTodos({ source: "agent" });
      expect(agentTodos).toHaveLength(1);
      expect(agentTodos[0]?.source).toBe("agent");
    });

    it("filters by status", () => {
      const todo = store.addTodo({ text: "Done todo", source: "user" });
      store.completeTodo(todo.id);

      const open = store.listTodos({ status: "open" });
      const done = store.listTodos({ status: "done" });

      expect(open).toHaveLength(3); // original 3
      expect(done).toHaveLength(1);
    });

    it("sorts overdue todos to the top", () => {
      const overdue = store.addTodo({
        text: "Very overdue",
        source: "user",
        due: "2020-01-01T09:00:00.000Z",
      });
      const future = store.addTodo({
        text: "Future task",
        source: "user",
        due: "2030-01-01T09:00:00.000Z",
      });

      const all = store.listTodos({ status: "open" });
      // Overdue should be first
      const overdueIdx = all.findIndex((t) => t.id === overdue.id);
      const futureIdx = all.findIndex((t) => t.id === future.id);
      expect(overdueIdx).toBeLessThan(futureIdx);
    });
  });

  describe("overdue()", () => {
    it("returns todos with due < now", () => {
      // Past due
      store.addTodo({ text: "Old task 1", source: "user", due: "2020-01-01T09:00:00.000Z" });
      store.addTodo({ text: "Old task 2", source: "user", due: "2021-06-01T09:00:00.000Z" });
      // Not overdue
      store.addTodo({ text: "Future task", source: "user", due: "2030-01-01T09:00:00.000Z" });
      // No due date
      store.addTodo({ text: "No due date", source: "user" });

      const overdue = store.overdue(new Date());
      expect(overdue).toHaveLength(2);
      expect(overdue.every((t) => t.status === "open")).toBe(true);
    });

    it("returns empty when nothing is overdue", () => {
      store.addTodo({ text: "Future task", source: "user", due: "2030-01-01T09:00:00.000Z" });
      expect(store.overdue(new Date())).toHaveLength(0);
    });

    it("excludes done todos from overdue", () => {
      const todo = store.addTodo({ text: "Done overdue", source: "user", due: "2020-01-01T09:00:00.000Z" });
      store.completeTodo(todo.id);

      expect(store.overdue(new Date())).toHaveLength(0);
    });
  });
});

describe("computeNextDue", () => {
  it("daily: advances by 1 day", () => {
    const next = computeNextDue("2026-06-09T09:00:00.000Z", "daily");
    expect(next).toContain("2026-06-10");
  });

  it("weekly: advances by 7 days", () => {
    const next = computeNextDue("2026-06-09T09:00:00.000Z", "weekly");
    expect(next).toContain("2026-06-16");
  });

  it("weekdays: skips Saturday → Monday", () => {
    // June 13, 2026 is Saturday
    const next = computeNextDue("2026-06-13T09:00:00.000Z", "weekdays");
    expect(next).toContain("2026-06-15"); // Monday
  });

  it("weekdays: skips Sunday → Monday", () => {
    // June 14, 2026 is Sunday
    const next = computeNextDue("2026-06-14T09:00:00.000Z", "weekdays");
    expect(next).toContain("2026-06-15"); // Monday
  });

  it("handles undefined due date by using today as base", () => {
    const next = computeNextDue(undefined, "daily");
    expect(next).toBeDefined();
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
