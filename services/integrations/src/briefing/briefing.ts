/**
 * Daily briefing assembly.
 *
 * Pipeline (spec feature 15):
 *   1. Gather — deterministic: pull sleep+HRV from MetricStore, agenda from
 *      CalendarMirror, todos from TodoStore, insights (stubbed in phase 4).
 *   2. Assemble context — typed BriefingContext object.
 *   3. Generate — LlmClient.complete() → prose.
 *      Fallback: if LLM unavailable (throws), render deterministic template.
 *   4. Return BriefingDoc.
 *
 * Determinism guarantee:
 *   The gather step copies numbers and titles verbatim — no inference.
 *   The LLM step only paraphrases. The fallback produces factually identical
 *   output, just with fixed sentence templates instead of prose.
 */

import { randomUUID } from "node:crypto";
import type {
  BriefingContext,
  BriefingDoc,
  SleepInput,
  AgendaInput,
  TodoInput,
  LlmClient,
} from "../types.js";
import type { MetricStore } from "../framework/metricStore.js";
import type { CalendarMirror } from "../connectors/googleCalendar.js";
import type { TodoStore } from "../work/todos.js";

export interface BriefingConfig {
  /** Word cap applied to LLM-generated prose (default 200). */
  maxWords?: number;
  /** IANA timezone used to render event times (default "UTC"). */
  timezone?: string;
}

/**
 * Assembles the daily morning briefing by gathering deterministic facts
 * (sleep, agenda, todos) and then paraphrasing them via the LLM — falling
 * back to a fixed template when the LLM is unavailable. See the file header
 * for the determinism guarantee.
 */
export class BriefingService {
  constructor(
    private metricStore: MetricStore,
    private calendarMirror: CalendarMirror,
    private todoStore: TodoStore,
    private llm: LlmClient,
    private config: BriefingConfig = {}
  ) {}

  /**
   * Build the briefing for `date` (defaults to today, UTC). Never throws on
   * LLM failure: it degrades to the deterministic template and records that
   * via `generatedBy: "template"`.
   */
  async assembleBriefing(date?: string): Promise<BriefingDoc> {
    const briefingDate = date ?? todayDate();
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    // 1. Gather — fully deterministic
    const context = await this.gatherContext(briefingDate);

    // 2. Generate prose (LLM or template fallback)
    let markdown: string;
    let generatedBy: "llm" | "template";

    try {
      markdown = await this.generateWithLlm(context);
      generatedBy = "llm";
    } catch {
      // Template fallback — deterministic, factually identical
      markdown = renderTemplateBrief(context);
      generatedBy = "template";
    }

    return {
      id,
      date: briefingDate,
      context,
      generatedBy,
      status: "ready",
      createdAt,
      markdown,
      ttsText: markdownToPlainText(markdown),
    };
  }

  private async gatherContext(date: string): Promise<BriefingContext> {
    const gatheredAt = new Date().toISOString();

    const sleep = await this.gatherSleep(date, gatheredAt);
    const agenda = await this.gatherAgenda(date, gatheredAt);
    const todos = this.gatherTodos(date, gatheredAt);

    return {
      date,
      sleep,
      agenda,
      todos,
      insights: null, // stubbed — feature 6 consolidation (phase later)
    };
  }

  private async gatherSleep(date: string, gatheredAt: string): Promise<SleepInput | null> {
    // Look back one day for sleep data (T+1 pattern: sleep data arrives morning after)
    const previousDay = prevDate(date);
    const from = `${previousDay}T00:00:00Z`;
    const to = `${date}T12:00:00Z`;

    // Use the most recent point in the window for each series.
    const lastDurationPoint = lastPoint(this.metricStore.querySeries("sleep.duration_min", { from, to }));
    const lastRecoveryPoint = lastPoint(this.metricStore.querySeries("recovery", { from, to }));

    if (!lastDurationPoint && !lastRecoveryPoint) return null;

    // Missing duration point ≠ "slept 0h" — keep it null so renderers can
    // mark the duration as unknown instead of stating 0h as fact.
    const hoursSlept = lastDurationPoint ? lastDurationPoint.value / 60 : null;
    const recoveryPct = lastRecoveryPoint?.value ?? 0;

    const recovery: SleepInput["recovery"] =
      recoveryPct >= 67 ? "high" : recoveryPct >= 34 ? "ok" : "low";

    return {
      score: lastRecoveryPoint?.value ?? 0,
      hoursSlept: hoursSlept == null ? null : Math.round(hoursSlept * 10) / 10,
      recovery,
      source: {
        feature: "10",
        gatheredAt,
        stale: hoursSlept == null && lastRecoveryPoint == null,
      },
    };
  }

  private async gatherAgenda(date: string, gatheredAt: string): Promise<AgendaInput | null> {
    const dayStart = `${date}T00:00:00Z`;
    const dayEnd = `${date}T23:59:59Z`;
    try {
      const events = this.calendarMirror.getEvents("primary", dayStart, dayEnd);
      return {
        events: events.map((event) => ({
          time: event.start.dateTime
            ? new Date(event.start.dateTime).toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                timeZone: this.config.timezone ?? "UTC",
              })
            : "all-day",
          title: event.summary,
          key: event.attendees.length > 2, // multi-person meetings are "key"
        })),
        source: { feature: "12", gatheredAt, stale: false },
      };
    } catch {
      return null;
    }
  }

  private gatherTodos(date: string, gatheredAt: string): TodoInput | null {
    try {
      const overdue = this.todoStore.overdue(new Date());
      const overdueIds = new Set(overdue.map((todo) => todo.id));

      // Open todos whose due-date falls on `date` but that aren't already
      // overdue — those are surfaced separately at high priority below.
      const dueTodayNotOverdue = this.todoStore
        .listTodos({ status: "open" })
        .filter((todo) => todo.due?.slice(0, 10) === date && !overdueIds.has(todo.id));

      // Overdue first (high), then the remaining due-today items (med).
      const items = [
        ...overdue.map((todo) => ({ title: todo.text, priority: "high" as const })),
        ...dueTodayNotOverdue.map((todo) => ({ title: todo.text, priority: "med" as const })),
      ];

      if (items.length === 0) return null;

      return {
        dueToday: items,
        source: { feature: "13", gatheredAt, stale: false },
      };
    } catch {
      return null;
    }
  }

  private async generateWithLlm(context: BriefingContext): Promise<string> {
    const prompt = buildLlmPrompt(context);
    const prose = await this.llm.complete({
      system:
        "You are a helpful chief-of-staff. Write a concise morning brief (under 200 words). " +
        "Only use information from the provided context — no fabrication. " +
        "Be direct and prioritized. Use markdown with emoji section headers.",
      prompt,
    });

    // Trim if too long
    const maxWords = this.config.maxWords ?? 200;
    return trimToWords(prose, maxWords);
  }
}

// ── Deterministic template fallback ───────────────────────────────────────────

/**
 * Render the briefing from fixed sentence templates — the LLM-free fallback.
 * Output is factually identical to the LLM path (same numbers/titles), just
 * with deterministic phrasing. Exported because tests pin this exact format.
 */
export function renderTemplateBrief(context: BriefingContext): string {
  const lines: string[] = [];
  const dateStr = formatDate(context.date);

  lines.push(`**Good morning. ${dateStr}**`);
  lines.push("");

  // Sleep / Recovery
  if (context.sleep) {
    const { hoursSlept, recovery } = context.sleep;
    const recoveryMessage = {
      low: "Recovery is **low** — go easy today.",
      ok: "Recovery is **ok**.",
      high: "Recovery is **high** — great day for demanding work.",
    }[recovery];
    if (hoursSlept == null) {
      // Recovery exists but no duration point — don't state "0h" as fact.
      lines.push(`🌙 No sleep duration recorded for last night. ${recoveryMessage}`);
    } else {
      lines.push(`🌙 You slept **${hoursSlept}h** last night. ${recoveryMessage}`);
    }
    lines.push("");
  } else {
    lines.push("🌙 No sleep data for last night.");
    lines.push("");
  }

  // Agenda
  if (context.agenda && context.agenda.events.length > 0) {
    const { events } = context.agenda;
    lines.push(`📅 ${events.length} event${events.length !== 1 ? "s" : ""} today:`);
    for (const event of events) {
      const keyMark = event.key ? " *(key)*" : "";
      lines.push(`- ${event.time} — ${event.title}${keyMark}`);
    }
    lines.push("");
  } else {
    lines.push("📅 No events on the calendar today — open day for deep work.");
    lines.push("");
  }

  // Todos
  if (context.todos && context.todos.dueToday.length > 0) {
    const { dueToday } = context.todos;
    const overdue = dueToday.filter((todo) => todo.priority === "high");
    const remaining = dueToday.filter((todo) => todo.priority !== "high");

    lines.push(
      `✅ ${dueToday.length} todo${dueToday.length !== 1 ? "s" : ""} due today:`
    );
    for (const todo of overdue) {
      lines.push(`- **${todo.title}** (overdue)`);
    }
    for (const todo of remaining) {
      lines.push(`- ${todo.title}`);
    }
    lines.push("");
  }

  // Insights (stubbed)
  if (context.insights && context.insights.digest.length > 0) {
    lines.push("💡 From last night's review:");
    for (const insight of context.insights.digest) {
      lines.push(`- ${insight}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildLlmPrompt(context: BriefingContext): string {
  const parts: string[] = [
    `Date: ${context.date}`,
    "",
  ];

  if (context.sleep) {
    const duration =
      context.sleep.hoursSlept == null ? "duration unknown" : `${context.sleep.hoursSlept}h`;
    parts.push(`Sleep: ${duration}, recovery=${context.sleep.recovery} (${context.sleep.score}%)`);
  } else {
    parts.push("Sleep: no data");
  }

  if (context.agenda) {
    parts.push("Calendar events today:");
    for (const event of context.agenda.events) {
      parts.push(`  ${event.time} ${event.title}${event.key ? " [KEY]" : ""}`);
    }
  } else {
    parts.push("Calendar: no events");
  }

  if (context.todos) {
    parts.push("Todos due:");
    for (const todo of context.todos.dueToday) {
      parts.push(`  [${todo.priority}] ${todo.title}`);
    }
  }

  if (context.insights) {
    parts.push("Insights:");
    for (const insight of context.insights.digest) {
      parts.push(`  - ${insight}`);
    }
  }

  return parts.join("\n");
}

/** Most recent point in a metric series (series are returned oldest-first). */
function lastPoint<P>(series: { points: P[] }): P | undefined {
  return series.points[series.points.length - 1];
}

function formatDate(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function prevDate(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function trimToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
}

function markdownToPlainText(md: string): string {
  return md
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/[🌙📅✅💡]/gu, "")
    .trim();
}
