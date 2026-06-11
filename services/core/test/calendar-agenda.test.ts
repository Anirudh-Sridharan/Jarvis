/**
 * calendar-agenda.test.ts
 *
 * "What's on my calendar?" must be answered from the connected app, not from
 * top-k memory similarity. Verifies:
 *  1. buildAgendaBlock renders mirror events (timed, all-day, empty, capped).
 *  2. ChatCore injects the block only for calendar-shaped messages.
 *  3. A failing agenda source never fails the turn.
 */

import { describe, it, expect, vi } from "vitest";
import type { CalendarEvent } from "@jarvis/integrations";

import { buildAgendaBlock, CALENDAR_INTENT } from "../src/chat/calendarAgenda.js";
import { ChatCore } from "../src/chat/chatCore.js";
import { InMemoryConversationStore } from "../src/chat/conversationStore.js";

function makeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  const now = new Date().toISOString();
  return {
    calendarId: "primary",
    id: "ev-1",
    etag: "etag",
    status: "confirmed",
    summary: "Platform Standup",
    start: { dateTime: "2026-06-11T17:00:00.000Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-11T17:30:00.000Z", timeZone: "UTC" },
    allDay: false,
    attendees: [],
    created: now,
    updated: now,
    source: "google",
    syncedAt: now,
    ...overrides,
  };
}

function makeMirror(events: CalendarEvent[]) {
  return {
    getEvents: vi.fn((_cal: string, _from: string, _to: string) => events),
  };
}

function makeGatewayStub() {
  let capturedMessages: { role: string; content: string }[] = [];
  const gateway = {
    chat: async function* (req: unknown) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: "ok" };
      yield { type: "done" as const };
    },
    registry: {
      defaultFor: () => ({ ctxWindow: 16_384, id: "test", modelRef: "test", kind: "chat", provider: "mlx" }),
    },
    modelManager: { isFallbackActive: () => false },
  } as unknown as InstanceType<typeof import("../src/inference/gateway.js").InferenceGateway>;
  return { gateway, messages: () => capturedMessages };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe("buildAgendaBlock", () => {
  const now = new Date("2026-06-10T20:00:00.000Z");

  it("renders timed events with summary and location", () => {
    const mirror = makeMirror([
      makeEvent({ summary: "Design Review for PHI Detector", location: "Room 4" }),
    ]);
    const block = buildAgendaBlock(mirror, now);
    expect(block).toContain("## Calendar (Google Calendar");
    expect(block).toContain("Design Review for PHI Detector");
    expect(block).toContain("@ Room 4");
    expect(block).toContain("do not invent others");
  });

  it("queries from local midnight so today's earlier events are included", () => {
    const mirror = makeMirror([]);
    buildAgendaBlock(mirror, now);
    const [, from, to] = mirror.getEvents.mock.calls[0]!;
    expect(new Date(from).getTime()).toBeLessThanOrEqual(now.getTime());
    expect(new Date(to).getTime()).toBeGreaterThan(now.getTime());
  });

  it("renders all-day events with their date", () => {
    const mirror = makeMirror([
      makeEvent({
        summary: "Meeting Free Day",
        allDay: true,
        start: { date: "2026-06-24", timeZone: "UTC" },
        end: { date: "2026-06-25", timeZone: "UTC" },
      }),
    ]);
    const block = buildAgendaBlock(mirror, now);
    expect(block).toContain("2026-06-24 (all day): Meeting Free Day");
  });

  it("explicitly says when the window has no events", () => {
    const block = buildAgendaBlock(makeMirror([]), now);
    expect(block).toContain("No events in this window");
  });

  it("filters cancelled events and caps long agendas", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, summary: `Event ${i}` }),
    );
    events.push(makeEvent({ id: "ev-x", summary: "Ghost", status: "cancelled" }));
    const block = buildAgendaBlock(makeMirror(events), now);
    expect(block).not.toContain("Ghost");
    expect(block).toContain("(+5 more events in this window)");
  });
});

describe("CALENDAR_INTENT gate", () => {
  it("matches calendar-shaped questions", () => {
    for (const q of [
      "whats on my calendar for tomorrow",
      "am I free Friday at 2? check my schedule",
      "do I have any meetings today",
      "what's the agenda this week",
    ]) {
      expect(CALENDAR_INTENT.test(q)).toBe(true);
    }
  });

  it("ignores non-calendar questions", () => {
    for (const q of ["explain rust traits", "what's my dog's name", "write a haiku"]) {
      expect(CALENDAR_INTENT.test(q)).toBe(false);
    }
  });
});

describe("ChatCore agenda injection", () => {
  const agendaSource = {
    getAgendaBlock: () => "## Calendar (Google Calendar, next 7 days, times in UTC)\n- Thu Jun 11 10:00–10:30: Platform Standup",
  };

  it("injects the agenda block for calendar-shaped messages", async () => {
    const { gateway, messages } = makeGatewayStub();
    const core = new ChatCore(gateway, new InMemoryConversationStore(), null, agendaSource);
    await drain(core.send({ message: "whats on my calendar for tomorrow" }));

    const block = messages().find((m) => m.content.includes("Platform Standup"));
    expect(block).toBeDefined();
    expect(block?.role).toBe("system");
    // Agenda precedes the user message (which sits at the bottom edge).
    const agendaIdx = messages().findIndex((m) => m.content.includes("Platform Standup"));
    const userIdx = messages().findIndex((m) => m.role === "user");
    expect(agendaIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(agendaIdx);
  });

  it("omits the agenda block for non-calendar messages", async () => {
    const spy = vi.fn(agendaSource.getAgendaBlock);
    const { gateway, messages } = makeGatewayStub();
    const core = new ChatCore(gateway, new InMemoryConversationStore(), null, {
      getAgendaBlock: spy,
    });
    await drain(core.send({ message: "explain rust traits" }));

    expect(spy).not.toHaveBeenCalled();
    expect(messages().some((m) => m.content.includes("Platform Standup"))).toBe(false);
  });

  it("a throwing agenda source never fails the turn", async () => {
    const { gateway } = makeGatewayStub();
    const core = new ChatCore(gateway, new InMemoryConversationStore(), null, {
      getAgendaBlock: () => {
        throw new Error("mirror unavailable");
      },
    });
    const events = await drain(core.send({ message: "any meetings today?" }));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });
});
