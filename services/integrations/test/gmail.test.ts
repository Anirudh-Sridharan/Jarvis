/**
 * Gmail connector tests:
 *   - sync follows messages.list nextPageToken (Gmail returns newest-first;
 *     stopping at page 1 would advance the cursor past unfetched older messages)
 *   - sync throws when a page-level messages.list fetch fails
 *   - per-message metadata fetch failures are tolerated (skipped, not fatal)
 *   - normalizeGmailMessage: unparseable internalDate / Date header must not
 *     throw (poison message would wedge every subsequent sync)
 *   - unread-count point ts is bucketed to the start of the current hour
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gmailConnector, normalizeGmailMessage } from "../src/connectors/gmail.js";
import { clearOAuthState } from "../src/framework/oauth.js";
import { FakeHttp, MemoryTokenStore, makeTokens } from "../src/testing/fakes.js";

function listBody(
  ids: string[],
  nextPageToken?: string
): { status: number; headers: Record<string, string>; body: object } {
  return {
    status: 200,
    headers: {},
    body: {
      messages: ids.map((id) => ({ id, threadId: `t-${id}` })),
      ...(nextPageToken ? { nextPageToken } : {}),
    },
  };
}

function metaBody(id: string, internalDate: string) {
  return {
    status: 200,
    headers: {},
    body: {
      id,
      threadId: `t-${id}`,
      labelIds: ["INBOX"],
      internalDate,
      payload: { headers: [{ name: "Subject", value: `Subject ${id}` }] },
    },
  };
}

const unreadOk = {
  status: 200,
  headers: {},
  body: { messagesUnread: 7 },
};

describe("gmailConnector.sync", () => {
  let http: FakeHttp;
  let tokenStore: MemoryTokenStore;

  beforeEach(() => {
    http = new FakeHttp();
    tokenStore = new MemoryTokenStore();
    tokenStore.seed("gmail", makeTokens({ expiresAt: Date.now() + 3600_000 }));
    clearOAuthState();
  });

  afterEach(() => clearOAuthState());

  it("follows nextPageToken across messages.list pages", async () => {
    // page 1 → m1 with a nextPageToken, page 2 → m2 (no token)
    http.add("users/me/messages?", [
      listBody(["m1"], "page2tok"),
      listBody(["m2"]),
    ]);
    http.add("format=metadata", [
      metaBody("m1", String(Date.parse("2026-06-09T10:00:00Z"))),
      metaBody("m2", String(Date.parse("2026-06-08T09:00:00Z"))),
    ]);
    http.add("labels/UNREAD", unreadOk);

    const result = await gmailConnector.sync(null, http, tokenStore);

    expect(http.callCount("users/me/messages?")).toBe(2);
    const secondList = http.calls.filter((c) =>
      c.req.url.includes("users/me/messages?")
    )[1];
    expect(secondList?.req.url).toContain("pageToken=page2tok");

    // Both messages counted (one per day → two daily received points)
    const received = result.points.filter((p) => p.metric === "gmail.received");
    expect(received).toHaveLength(2);
    // Cursor advances to the newest message ts
    expect(result.nextCursor).toBe("2026-06-09T10:00:00.000Z");
  });

  it("throws when a page-level messages.list fetch fails", async () => {
    http.add("users/me/messages?", { status: 500, headers: {}, body: {} });
    http.add("labels/UNREAD", unreadOk);

    await expect(gmailConnector.sync(null, http, tokenStore)).rejects.toThrow(
      /messages\.list failed: HTTP 500/
    );
  });

  it("throws when a LATER page fails (first page ok)", async () => {
    http.add("users/me/messages?", [
      listBody(["m1"], "page2tok"),
      { status: 429, headers: {}, body: {} },
    ]);
    http.add("format=metadata", metaBody("m1", String(Date.parse("2026-06-09T10:00:00Z"))));
    http.add("labels/UNREAD", unreadOk);

    await expect(gmailConnector.sync(null, http, tokenStore)).rejects.toThrow(
      /messages\.list failed: HTTP 429/
    );
  });

  it("tolerates per-message metadata fetch failures without crashing", async () => {
    http.add("users/me/messages?", listBody(["m1", "m2"]));
    http.add("format=metadata", [
      { status: 500, headers: {}, body: {} }, // m1 metadata fails
      metaBody("m2", String(Date.parse("2026-06-09T11:00:00Z"))),
    ]);
    http.add("labels/UNREAD", unreadOk);

    const result = await gmailConnector.sync(null, http, tokenStore);

    const received = result.points.find((p) => p.metric === "gmail.received");
    expect(received?.value).toBe(1); // only m2 counted; run did not crash
  });

  it("buckets the unread-count point ts to the start of the current hour (idempotent re-runs)", async () => {
    http.add("users/me/messages?", listBody([]));
    http.add("labels/UNREAD", unreadOk);

    const result1 = await gmailConnector.sync(null, http, tokenStore);
    const result2 = await gmailConnector.sync(null, http, tokenStore);

    const unread1 = result1.points.find((p) => p.metric === "gmail.unread_count");
    const unread2 = result2.points.find((p) => p.metric === "gmail.unread_count");

    expect(unread1).toBeDefined();
    // ts is exactly the top of an hour
    const d = new Date(unread1!.ts);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
    // Two runs within the same hour → same deterministic id (upsert, not append)
    expect(unread2!.id).toBe(unread1!.id);
    expect(unread2!.ts).toBe(unread1!.ts);
  });
});

describe("normalizeGmailMessage — poison dates", () => {
  it("falls back to the Date header when internalDate is unparseable", () => {
    const ev = normalizeGmailMessage(
      {
        id: "m1",
        threadId: "t1",
        internalDate: "not-a-number",
        payload: {
          headers: [{ name: "Date", value: "Tue, 09 Jun 2026 10:00:00 GMT" }],
        },
      },
      "email_received"
    );
    expect(ev?.ts).toBe("2026-06-09T10:00:00.000Z");
  });

  it("falls back to now when both internalDate and Date header are malformed (no throw)", () => {
    const before = Date.now();
    const ev = normalizeGmailMessage(
      {
        id: "m1",
        threadId: "t1",
        internalDate: "garbage",
        payload: { headers: [{ name: "Date", value: "definitely not a date ::: " }] },
      },
      "email_received"
    );
    const after = Date.now();
    expect(ev).not.toBeNull();
    const ts = Date.parse(ev!.ts);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("still prefers a valid internalDate", () => {
    const ev = normalizeGmailMessage(
      {
        id: "m1",
        internalDate: String(Date.parse("2026-06-09T08:30:00Z")),
        payload: { headers: [] },
      },
      "email_received"
    );
    expect(ev?.ts).toBe("2026-06-09T08:30:00.000Z");
  });
});
