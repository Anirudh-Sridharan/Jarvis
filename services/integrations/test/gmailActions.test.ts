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
