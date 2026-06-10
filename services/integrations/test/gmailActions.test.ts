/**
 * Gmail actions tests (feature 18 email tools):
 *   - sendEmail: RFC 2822 raw decodes back to expected headers/body, threadId
 *     passthrough, result ids, error mapping (429/5xx retryable, 4xx terminal)
 *   - createEmailDraft: drafts endpoint, draftId in result
 *   - RFC 2047 subject encoding for non-ASCII
 *
 * Approval is NOT tested here — it lives upstream in the agent ReAct loop.
 */

import { describe, it, expect } from "vitest";
import {
  sendEmail,
  createEmailDraft,
  buildRfc2822,
  searchEmail,
  getEmailThread,
  type GmailDeps,
  type EmailSendRequest,
} from "../src/connectors/gmailActions.js";
import { FakeHttp, MemoryTokenStore, makeTokens } from "../src/testing/fakes.js";

function makeDeps(): { deps: GmailDeps; http: FakeHttp } {
  const http = new FakeHttp();
  const tokens = new MemoryTokenStore();
  tokens.seed("gmail", makeTokens());
  return { deps: { http, tokenStore: tokens }, http };
}

function sendReq(overrides: Partial<EmailSendRequest> = {}): EmailSendRequest {
  return {
    to: ["pat@example.com"],
    subject: "Quarterly sync",
    body: "Hi Pat,\n\nShall we sync Thursday?\n",
    ...overrides,
  };
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("sendEmail", () => {
  it("POSTs base64url RFC 2822 raw with bearer auth and returns ids", async () => {
    const { deps, http } = makeDeps();
    http.add("/messages/send", {
      status: 200,
      headers: {},
      body: { id: "msg-1", threadId: "thr-1" },
    });

    const result = await sendEmail(sendReq({ cc: ["sam@example.com"] }), deps);

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-1");
    expect(result.threadId).toBe("thr-1");

    const post = http.calls.find((c) => c.req.method === "POST");
    expect(post).toBeDefined();
    expect(post!.req.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    expect(post!.req.headers?.["Authorization"]).toBe("Bearer test_access_token");

    const { raw } = post!.req.body as { raw: string };
    const msg = decodeRaw(raw);
    expect(msg).toContain("To: pat@example.com\r\n");
    expect(msg).toContain("Cc: sam@example.com\r\n");
    expect(msg).toContain("Subject: Quarterly sync\r\n");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    // body is base64 after the blank line
    const bodyB64 = msg.split("\r\n\r\n")[1]!;
    expect(Buffer.from(bodyB64, "base64").toString("utf8")).toContain("Shall we sync Thursday?");
  });

  it("passes threadId through for replies", async () => {
    const { deps, http } = makeDeps();
    http.add("/messages/send", {
      status: 200,
      headers: {},
      body: { id: "msg-2", threadId: "thr-existing" },
    });

    const result = await sendEmail(sendReq({ threadId: "thr-existing" }), deps);

    expect(result.ok).toBe(true);
    const body = http.calls.find((c) => c.req.method === "POST")!.req.body as Record<string, unknown>;
    expect(body["threadId"]).toBe("thr-existing");
  });

  it("requires at least one recipient (400, no network)", async () => {
    const { deps, http } = makeDeps();
    const result = await sendEmail(sendReq({ to: [] }), deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(400);
    expect(http.calls.length).toBe(0);
  });

  it.each([
    [429, true],
    [500, true],
    [403, false],
  ])("HTTP %i → ok:false retryable=%s", async (status, retryable) => {
    const { deps, http } = makeDeps();
    http.add("/messages/send", { status, headers: {}, body: {} });

    const result = await sendEmail(sendReq(), deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(status);
    expect(result.error?.retryable).toBe(retryable);
  });

  it("returns 401 without tokens and never calls the API", async () => {
    const http = new FakeHttp();
    const result = await sendEmail(sendReq(), { http, tokenStore: new MemoryTokenStore() });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(401);
    expect(http.calls.length).toBe(0);
  });
});

describe("createEmailDraft", () => {
  it("POSTs to /drafts with nested message and returns draftId", async () => {
    const { deps, http } = makeDeps();
    http.add("/drafts", {
      status: 200,
      headers: {},
      body: { id: "draft-1", message: { id: "msg-d1", threadId: "thr-d1" } },
    });

    const result = await createEmailDraft(sendReq(), deps);

    expect(result.ok).toBe(true);
    expect(result.draftId).toBe("draft-1");
    expect(result.messageId).toBe("msg-d1");

    const post = http.calls.find((c) => c.req.method === "POST")!;
    expect(post.req.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    const body = post.req.body as { message: { raw: string } };
    expect(decodeRaw(body.message.raw)).toContain("To: pat@example.com\r\n");
  });
});

describe("buildRfc2822", () => {
  it("RFC 2047-encodes non-ASCII subjects", () => {
    const msg = buildRfc2822(sendReq({ subject: "Café plans ☕" }));
    const subjectLine = msg.split("\r\n").find((l) => l.startsWith("Subject: "))!;
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const b64 = subjectLine.match(/\?B\?([A-Za-z0-9+/=]+)\?=/)![1]!;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Café plans ☕");
  });

  it("leaves ASCII subjects unencoded", () => {
    const msg = buildRfc2822(sendReq());
    expect(msg).toContain("Subject: Quarterly sync\r\n");
  });
});

describe("searchEmail", () => {
  it("lists with q + maxResults, fetches metadata per hit, tolerates a miss", async () => {
    const { deps, http } = makeDeps();
    http.add(/\/messages\?/, {
      status: 200,
      headers: {},
      body: {
        messages: [
          { id: "m1", threadId: "t1" },
          { id: "m2", threadId: "t2" },
        ],
      },
    });
    http.add("/messages/m1?", {
      status: 200,
      headers: {},
      body: {
        id: "m1",
        payload: {
          headers: [
            { name: "Subject", value: "Invoice #42" },
            { name: "From", value: "alice@example.com" },
            { name: "Date", value: "Wed, 10 Jun 2026 09:00:00 +0000" },
          ],
        },
      },
    });
    http.add("/messages/m2?", { status: 404, headers: {}, body: {} });

    const hits = await searchEmail("from:alice", 10, deps);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      messageId: "m1",
      threadId: "t1",
      subject: "Invoice #42",
      from: "alice@example.com",
      date: "Wed, 10 Jun 2026 09:00:00 +0000",
    });
    const list = http.calls[0]!.req;
    expect(list.url).toContain("q=from%3Aalice");
    expect(list.url).toContain("maxResults=10");
    expect(list.headers?.["Authorization"]).toBe("Bearer test_access_token");
  });

  it("throws when the list call fails", async () => {
    const { deps, http } = makeDeps();
    http.add(/\/messages\?/, { status: 500, headers: {}, body: {} });
    await expect(searchEmail("anything", 5, deps)).rejects.toThrow("HTTP 500");
  });
});

describe("getEmailThread", () => {
  it("extracts text/plain bodies from nested multipart payloads", async () => {
    const { deps, http } = makeDeps();
    const plain = Buffer.from("The plain body", "utf8").toString("base64url");
    http.add("/threads/t1?", {
      status: 200,
      headers: {},
      body: {
        id: "t1",
        messages: [
          {
            id: "m1",
            threadId: "t1",
            payload: {
              mimeType: "multipart/alternative",
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "me@example.com" },
                { name: "Subject", value: "Hello" },
                { name: "Date", value: "Wed, 10 Jun 2026 09:00:00 +0000" },
              ],
              parts: [
                { mimeType: "text/html", body: { data: "ignored" } },
                {
                  mimeType: "multipart/mixed",
                  parts: [{ mimeType: "text/plain", body: { data: plain } }],
                },
              ],
            },
          },
        ],
      },
    });

    const thread = await getEmailThread("t1", deps);

    expect(thread.id).toBe("t1");
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.body).toBe("The plain body");
    expect(thread.messages[0]!.from).toBe("alice@example.com");
    expect(thread.messages[0]!.subject).toBe("Hello");
  });

  it("returns empty body when no text/plain part exists", async () => {
    const { deps, http } = makeDeps();
    http.add("/threads/t2?", {
      status: 200,
      headers: {},
      body: {
        id: "t2",
        messages: [
          {
            id: "m9",
            payload: {
              mimeType: "text/html",
              headers: [{ name: "Subject", value: "HTML only" }],
              body: { data: "aGk" },
            },
          },
        ],
      },
    });

    const thread = await getEmailThread("t2", deps);
    expect(thread.messages[0]!.body).toBe("");
  });

  it("throws when the thread fetch fails", async () => {
    const { deps, http } = makeDeps();
    http.add("/threads/missing?", { status: 404, headers: {}, body: {} });
    await expect(getEmailThread("missing", deps)).rejects.toThrow("HTTP 404");
  });
});
