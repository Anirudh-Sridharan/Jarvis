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
  maxWords?: number;
  timezone?: string;
}

export class BriefingService {
  constructor(
    private metricStore: MetricStore,
    private calendarMirror: CalendarMirror,
    private todoStore: TodoStore,
    private llm: LlmClient,
    private config: BriefingConfig = {}
  ) {}

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
    const now = new Date().toISOString();
    const dayStart = `${date}T00:00:00Z`;
    const dayEnd = `${date}T23:59:59Z`;

    // Sleep + HRV from MetricStore
    const sleep = await this.gatherSleep(date, now);

    // Calendar agenda for today
    const agenda = await this.gatherAgenda(date, dayStart, dayEnd, now);

    // Todos due today + overdue
    const todos = this.gatherTodos(date, now);

    return {
      date,
      sleep,
      agenda,
      todos,
      insights: null, // stubbed — feature 6 consolidation (phase later)
    };
  }

  private async gatherSleep(date: string, now: string): Promise<SleepInput | null> {
    // Look back one day for sleep data (T+1 pattern: sleep data arrives morning after)
    const prevDay = prevDate(date);
    const from = `${prevDay}T00:00:00Z`;
    const to = `${date}T12:00:00Z`;

    const durationSeries = this.metricStore.querySeries("sleep.duration_min", { from, to });
    const recoverySeries = this.metricStore.querySeries("recovery", { from, to });
    const hrvSeries = this.metricStore.querySeries("hrv", { from, to });

    const sleepPt = durationSeries.points[durationSeries.points.length - 1];
    const recovPt = recoverySeries.points[recoverySeries.points.length - 1];
    const hrvPt = hrvSeries.points[hrvSeries.points.length - 1];

    if (!sleepPt && !recovPt) return null;

    // Missing duration point ≠ "slept 0h" — keep it null so renderers can
    // mark the duration as unknown instead of stating 0h as fact.
    const hoursSlept = sleepPt ? sleepPt.value / 60 : null;
    const recoveryPct = recovPt?.value ?? 0;

    const recovery: SleepInput["recovery"] =
      recoveryPct >= 67 ? "high" : recoveryPct >= 34 ? "ok" : "low";

    return {
      score: recovPt?.value ?? 0,
      hoursSlept: hoursSlept == null ? null : Math.round(hoursSlept * 10) / 10,
      recovery,
      source: {
        feature: "10",
        gatheredAt: now,
        stale: hoursSlept == null && recovPt == null,
      },
    };
  }

  private async gatherAgenda(
    date: string,
    dayStart: string,
    dayEnd: string,
    now: string
  ): Promise<AgendaInput | null> {
    try {
      const events = this.calendarMirror.getEvents("primary", dayStart, dayEnd);
      return {
        events: events.map((e) => ({
          time: e.start.dateTime
            ? new Date(e.start.dateTime).toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                timeZone: this.config.timezone ?? "UTC",
              })
            : "all-day",
          title: e.summary,
          key: e.attendees.length > 2, // multi-person meetings are "key"
        })),
        source: { feature: "12", gatheredAt: now, stale: false },
      };
    } catch {
      return null;
    }
  }

  private gatherTodos(date: string, now: string): TodoInput | null {
    try {
      const overdue = this.todoStore.overdue(new Date());
      const allOpen = this.todoStore.listTodos({ status: "open" });
      const dueToday = allOpen.filter(
        (t) => t.due && t.due.slice(0, 10) === date
      );

      const combined = [
        ...overdue.map((t) => ({ title: t.text, priority: "high" as const })),
        ...dueToday.filter((t) => !overdue.find((o) => o.id === t.id))
          .map((t) => ({ title: t.text, priority: "med" as const })),
      ];

      if (combined.length === 0) return null;

      return {
        dueToday: combined,
        source: { feature: "13", gatheredAt: now, stale: false },
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

export function renderTemplateBrief(context: BriefingContext): string {
  const lines: string[] = [];
  const dateStr = formatDate(context.date);

  lines.push(`**Good morning. ${dateStr}**`);
  lines.push("");

  // Sleep / Recovery
  if (context.sleep) {
    const { hoursSlept, recovery } = context.sleep;
    const recMsg = {
      low: "Recovery is **low** — go easy today.",
      ok: "Recovery is **ok**.",
      high: "Recovery is **high** — great day for demanding work.",
    }[recovery];
    if (hoursSlept == null) {
      // Recovery exists but no duration point — don't state "0h" as fact.
      lines.push(`🌙 No sleep duration recorded for last night. ${recMsg}`);
    } else {
      lines.push(`🌙 You slept **${hoursSlept}h** last night. ${recMsg}`);
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
    for (const e of events) {
      const keyMark = e.key ? " *(key)*" : "";
      lines.push(`- ${e.time} — ${e.title}${keyMark}`);
    }
    lines.push("");
  } else {
    lines.push("📅 No events on the calendar today — open day for deep work.");
    lines.push("");
  }

  // Todos
  if (context.todos && context.todos.dueToday.length > 0) {
    const { dueToday } = context.todos;
    const highPri = dueToday.filter((t) => t.priority === "high");
    const others = dueToday.filter((t) => t.priority !== "high");

    lines.push(
      `✅ ${dueToday.length} todo${dueToday.length !== 1 ? "s" : ""} due today:`
    );
    for (const t of highPri) {
      lines.push(`- **${t.title}** (overdue)`);
    }
    for (const t of others) {
      lines.push(`- ${t.title}`);
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
    for (const e of context.agenda.events) {
      parts.push(`  ${e.time} ${e.title}${e.key ? " [KEY]" : ""}`);
    }
  } else {
    parts.push("Calendar: no events");
  }

  if (context.todos) {
    parts.push("Todos due:");
    for (const t of context.todos.dueToday) {
      parts.push(`  [${t.priority}] ${t.title}`);
    }
  }

  if (context.insights) {
    parts.push("Insights:");
    for (const i of context.insights.digest) {
      parts.push(`  - ${i}`);
    }
  }

  return parts.join("\n");
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
