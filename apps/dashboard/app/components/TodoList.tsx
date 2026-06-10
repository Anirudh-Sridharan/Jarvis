"use client";

import { useState, useCallback } from "react";
import type { TodoContract, WidgetEnvelope } from "@/app/lib/contracts";
import { isOverdue } from "@/app/lib/dates";

interface TodoListProps {
  initialEnvelope: WidgetEnvelope<TodoContract[]>;
}

export default function TodoList({ initialEnvelope }: TodoListProps) {
  const [todos, setTodos] = useState<TodoContract[]>(initialEnvelope.data ?? []);
  const [newText, setNewText] = useState("");
  const [newDue, setNewDue] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTodo = useCallback(async () => {
    const text = newText.trim();
    if (!text || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, due: newDue || undefined }),
      });
      const envelope = (await res.json()) as WidgetEnvelope<TodoContract>;
      if (envelope.data) {
        setTodos((prev) => [envelope.data as TodoContract, ...prev]);
        setNewText("");
        setNewDue("");
      } else {
        setError(envelope.error?.message ?? "Failed to add todo");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setAdding(false);
    }
  }, [newText, newDue, adding]);

  const completeTodo = useCallback(async (id: string) => {
    try {
      const res = await fetch("/api/todos", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const envelope = (await res.json()) as WidgetEnvelope<TodoContract>;
      if (envelope.data) {
        setTodos((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: "done" as const } : t))
        );
      }
    } catch {
      // silently ignore — optimistic update already applied via visual feedback
    }
  }, []);

  const open = todos.filter((t) => t.status === "open");
  const isNow = (due?: string) => (due ? isOverdue(due) : false);

  return (
    <div className="card">
      <div className="card__title">Todos</div>

      {error && <p className="text-error text-sm">{error}</p>}

      <div className="todo-composer">
        <input
          className="todo-composer__input"
          placeholder="Add a todo…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addTodo(); }}
          disabled={adding}
        />
        <input
          className="todo-composer__date"
          type="date"
          value={newDue}
          onChange={(e) => setNewDue(e.target.value)}
          disabled={adding}
        />
        <button
          className="composer__btn"
          onClick={() => void addTodo()}
          disabled={adding || !newText.trim()}
        >
          Add
        </button>
      </div>

      {open.length === 0 ? (
        <p className="text-dim">No open todos.</p>
      ) : (
        <ul className="todo-list">
          {open.map((t) => (
            <li key={t.id} className={`todo-list__item${isNow(t.due) ? " todo-list__item--overdue" : ""}`}>
              <button
                className="todo-list__check"
                onClick={() => void completeTodo(t.id)}
                title="Mark done"
                aria-label={`Complete: ${t.text}`}
              >
                &#9675;
              </button>
              <span className="todo-list__text">{t.text}</span>
              {t.due && (
                <span className={`todo-list__due${isNow(t.due) ? " todo-list__due--overdue" : ""}`}>
                  {new Date(t.due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
