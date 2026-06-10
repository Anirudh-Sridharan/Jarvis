/**
 * Built-in Todo store — local SQLite CRUD.
 *
 * The only task list Jarvis owns natively (no Notion/Linear/Jira).
 * Used by:
 *   - Dashboard UI (feature 14): add/complete/snooze/list
 *   - Agent (feature 18): add agent-created todos, list overdue
 *   - Briefing (feature 15): list due-today and overdue todos
 *
 * Key behaviors:
 *   - addTodo: validates text, generates ID, persists
 *   - completeTodo: marks done, spawns next recurrence instance
 *   - snoozeTodo: extends due date, increments snoozedCount
 *   - listTodos: filter by status/source, sorted (overdue first)
 *   - overdue(): all open todos with due < now (computed at read time, no stale flag)
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Todo } from "../types.js";
import { toJson, fromJson } from "../db/database.js";

export interface NewTodo {
  text: string;
  due?: string;
  source: "user" | "agent";
  links?: Todo["links"];
  recurrence?: Todo["recurrence"];
}

export class TodoStore {
  constructor(private db: DatabaseSync) {}

  addTodo(input: NewTodo): Todo {
    const text = input.text.trim();
    if (!text) throw new Error("todo text is required");

    const todo: Todo = {
      id: randomUUID(),
      text,
      due: input.due,
      status: "open",
      source: input.source,
      links: input.links ?? [],
      createdAt: new Date().toISOString(),
      recurrence: input.recurrence ?? null,
      snoozedCount: 0,
    };

    this.db
      .prepare(
        `INSERT INTO todos
           (id, text, due, status, source, links, recurrence, snoozed_count, created_at)
         VALUES
           (:id, :text, :due, :status, :source, :links, :recurrence, :snoozed_count, :created_at)`
      )
      .run({
        id: todo.id,
        text: todo.text,
        due: todo.due ?? null,
        status: todo.status,
        source: todo.source,
        links: toJson(todo.links ?? []),
        recurrence: todo.recurrence ?? null,
        snoozed_count: 0,
        created_at: todo.createdAt,
      });

    return todo;
  }

  completeTodo(id: string): Todo {
    const row = this.getRow(id);
    if (!row) throw new Error(`Todo not found: ${id}`);
    if (row.status === "done") return row;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE todos SET status = 'done', completed_at = ? WHERE id = ?`
      )
      .run(now, id);

    // Spawn next recurrence instance if applicable
    if (row.recurrence) {
      const nextDue = computeNextDue(row.due, row.recurrence);
      if (nextDue) {
        this.addTodo({
          text: row.text,
          source: row.source,
          links: row.links,
          recurrence: row.recurrence,
          due: nextDue,
        });
      }
    }

    return { ...row, status: "done", completedAt: now };
  }

  snoozeTodo(id: string, newDue: string): Todo {
    const row = this.getRow(id);
    if (!row) throw new Error(`Todo not found: ${id}`);

    const newCount = (row.snoozedCount ?? 0) + 1;
    this.db
      .prepare(
        `UPDATE todos SET due = ?, snoozed_count = ? WHERE id = ?`
      )
      .run(newDue, newCount, id);

    return { ...row, due: newDue, snoozedCount: newCount };
  }

  getTodo(id: string): Todo | null {
    return this.getRow(id);
  }

  listTodos(filter?: {
    status?: "open" | "done";
    source?: "user" | "agent";
  }): Todo[] {
    let sql = `SELECT * FROM todos WHERE 1=1`;
    const params: unknown[] = [];

    if (filter?.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }
    if (filter?.source) {
      sql += ` AND source = ?`;
      params.push(filter.source);
    }

    // Sort: overdue first (status=open, due < now), then by due ASC, then createdAt
    sql += ` ORDER BY
      CASE WHEN status = 'open' AND due IS NOT NULL AND due < datetime('now') THEN 0 ELSE 1 END,
      CASE WHEN due IS NULL THEN 1 ELSE 0 END,
      due ASC,
      created_at ASC`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (this.db.prepare(sql).all as any)(...params) as Record<string, unknown>[];
    return rows.map(rowToTodo);
  }

  /** All open todos with due < now — computed at read time. */
  overdue(now = new Date()): Todo[] {
    const nowIso = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM todos
         WHERE status = 'open' AND due IS NOT NULL AND due < ?
         ORDER BY due ASC`
      )
      .all(nowIso) as Record<string, unknown>[];
    return rows.map(rowToTodo);
  }

  deleteTodo(id: string): void {
    this.db.prepare(`DELETE FROM todos WHERE id = ?`).run(id);
  }

  private getRow(id: string): Todo | null {
    const row = this.db
      .prepare(`SELECT * FROM todos WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToTodo(row) : null;
  }
}

// ── Recurrence ────────────────────────────────────────────────────────────────

export function computeNextDue(
  currentDue: string | undefined,
  recurrence: "daily" | "weekly" | "weekdays"
): string | null {
  const base = currentDue ? new Date(currentDue) : new Date();
  // Ensure next due is strictly after today
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let next = new Date(base);

  switch (recurrence) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      break;

    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      break;

    case "weekdays": {
      next.setUTCDate(next.getUTCDate() + 1);
      // Skip weekend
      const dow = next.getUTCDay();
      if (dow === 0) next.setUTCDate(next.getUTCDate() + 1); // Sunday → Monday
      if (dow === 6) next.setUTCDate(next.getUTCDate() + 2); // Saturday → Monday
      break;
    }
  }

  // Guard: next due must be strictly after today (infinite-loop guard)
  if (next <= today) {
    next = new Date(today);
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.toISOString().slice(0, 10) + "T00:00:00.000Z";
}

// ── Row mapping ───────────────────────────────────────────────────────────────

function rowToTodo(row: Record<string, unknown>): Todo {
  return {
    id: row["id"] as string,
    text: row["text"] as string,
    due: (row["due"] as string | null | undefined) ?? undefined,
    status: row["status"] as "open" | "done",
    source: row["source"] as "user" | "agent",
    links: fromJson<Todo["links"]>(row["links"] as string | null, []),
    createdAt: row["created_at"] as string,
    completedAt: (row["completed_at"] as string | null | undefined) ?? undefined,
    recurrence: (row["recurrence"] as Todo["recurrence"] | null | undefined) ?? null,
    snoozedCount: (row["snoozed_count"] as number | undefined) ?? 0,
  };
}
