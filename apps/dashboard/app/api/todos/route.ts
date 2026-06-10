/**
 * GET  /api/todos?status=open|done  — list todos
 * POST /api/todos                   — add todo { text, due? }
 * PATCH /api/todos                  — complete todo { id }
 *
 * Returns WidgetEnvelope<TodoContract[]> or WidgetEnvelope<TodoContract>.
 * Never 500 on empty — returns state:"empty".
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, TodoContract } from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";

function toContract(todo: import("@jarvis/integrations").Todo): TodoContract {
  return {
    id: todo.id,
    text: todo.text,
    due: todo.due,
    status: todo.status,
    source: todo.source,
    createdAt: todo.createdAt,
    completedAt: todo.completedAt,
  };
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const status = req.nextUrl.searchParams.get("status") as "open" | "done" | null;

  try {
    const { todos } = getIntegrations();
    const list = todos.listTodos(status ? { status } : undefined);
    const contracts = list.map(toContract);

    const envelope: WidgetEnvelope<TodoContract[]> = {
      data: contracts,
      state: contracts.length === 0 ? "empty" : "ok",
      meta: { source: "local-sqlite", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<TodoContract[]> = {
      data: null,
      state: "error",
      error: { code: "STORE_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { text?: string; due?: string };
    if (!body.text?.trim()) {
      return NextResponse.json(
        { error: "text is required" } as Record<string, string>,
        { status: 400 }
      );
    }

    const { todos } = getIntegrations();
    const todo = todos.addTodo({ text: body.text.trim(), due: body.due, source: "user" });

    const envelope: WidgetEnvelope<TodoContract> = {
      data: toContract(todo),
      state: "ok",
      meta: { source: "local-sqlite", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope, { status: 201 });
  } catch (err) {
    const envelope: WidgetEnvelope<TodoContract> = {
      data: null,
      state: "error",
      error: { code: "ADD_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { id?: string };
    if (!body.id) {
      return NextResponse.json({ error: "id is required" } as Record<string, string>, { status: 400 });
    }

    const { todos } = getIntegrations();
    const todo = todos.completeTodo(body.id);

    const envelope: WidgetEnvelope<TodoContract> = {
      data: toContract(todo),
      state: "ok",
      meta: { source: "local-sqlite", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<TodoContract> = {
      data: null,
      state: "error",
      error: { code: "COMPLETE_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}
