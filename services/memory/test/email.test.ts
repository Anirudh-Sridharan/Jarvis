/**
 * Tests for the email capture adapter (second-brain capture breadth #3):
 * chunks-only records, header prefixing, doc_id = message id grouping, per-chunk
 * dedup keys, address-derived entities, immutable-timestamp parsing, and the
 * empty-body short-circuit.
 */

import { describe, it, expect } from "vitest";
import { buildEmailRecords, parseAddresses } from "../src/capture/adapters/email.js";

function tokens(n: number): string {
  return Array.from({ length: n }, (_, i) => `tok${String(i).padStart(3, "0")}`).join(" ");
}

const MULTI = { targetChars: 60, overlapChars: 0, minChars: 10 };

const BASE = {
  messageId: "m1",
  threadId: "t1",
  from: "Alice Smith <alice@example.com>",
  to: "me@example.com",
  subject: "Project kickoff",
  date: "Mon, 01 Jun 2026 08:00:00 +0000",
};

describe("buildEmailRecords", () => {
  it("emits a single gmail/email record for a short body", () => {
    const recs = buildEmailRecords({ ...BASE, body: "Let's meet Tuesday." });
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.source).toBe("gmail");
    expect(r.type).toBe("email");
    expect(r.actor).toBe("user");
    expect(r.payload["chunk_index"]).toBe(0);
    expect(r.payload["chunk_count"]).toBe(1);
    expect(r.payload["message_id"]).toBe("m1");
    expect(r.payload["thread_id"]).toBe("t1");
    expect(r.payload["doc_id"]).toBe("m1");
    expect(r.payload["subject"]).toBe("Project kickoff");
  });

  it("prefixes each chunk's text with subject + from/to/date header", () => {
    const [r] = buildEmailRecords({ ...BASE, body: "Body text here." });
    expect(r!.text).toBe(
      "Project kickoff\nFrom: Alice Smith <alice@example.com> · To: me@example.com · Mon, 01 Jun 2026 08:00:00 +0000\n\nBody text here.",
    );
  });

  it("chunks a long body into multiple records sharing one doc_id and count", () => {
    const recs = buildEmailRecords({ ...BASE, body: tokens(100), chunkOpts: MULTI });
    expect(recs.length).toBeGreaterThan(1);
    recs.forEach((r, i) => {
      expect(r.payload["chunk_index"]).toBe(i);
      expect(r.payload["chunk_count"]).toBe(recs.length);
      expect(r.payload["doc_id"]).toBe("m1");
    });
  });

  it("gives each chunk a unique, deterministic dedup key keyed by message id + index", () => {
    const args = { ...BASE, body: tokens(100), chunkOpts: MULTI };
    const a = buildEmailRecords(args);
    const b = buildEmailRecords(args);
    const keysA = a.map((r) => r.dedup_key);
    expect(new Set(keysA).size).toBe(keysA.length); // unique across chunks
    expect(keysA).toEqual(b.map((r) => r.dedup_key)); // deterministic
    expect(a[0]!.provenance.source_id).toBe("m1#0");
  });

  it("derives person + email entities from from/to (with a display name)", () => {
    const [r] = buildEmailRecords({ ...BASE, body: "hi" });
    const ents = r!.entities;
    expect(ents).toContainEqual({ kind: "person", value: "Alice Smith" });
    expect(ents).toContainEqual({ kind: "email", value: "alice@example.com" });
    expect(ents).toContainEqual({ kind: "email", value: "me@example.com" });
  });

  it("parses bare addresses and comma-separated recipient lists", () => {
    const [r] = buildEmailRecords({
      ...BASE,
      from: "bob@example.com",
      to: "Carol <carol@x.com>, dan@y.com",
      body: "hi",
    });
    const ents = r!.entities;
    expect(ents).toContainEqual({ kind: "email", value: "bob@example.com" });
    expect(ents).toContainEqual({ kind: "person", value: "Carol" });
    expect(ents).toContainEqual({ kind: "email", value: "carol@x.com" });
    expect(ents).toContainEqual({ kind: "email", value: "dan@y.com" });
    // No phantom person entity for the bare addresses.
    expect(ents.filter((e) => e.kind === "person")).toHaveLength(1);
  });

  it("parses the message date into an ISO timestamp", () => {
    const [r] = buildEmailRecords({ ...BASE, body: "hi" });
    expect(r!.timestamp).toBe("2026-06-01T08:00:00.000Z");
  });

  it("returns [] for an empty or whitespace-only body", () => {
    expect(buildEmailRecords({ ...BASE, body: "" })).toEqual([]);
    expect(buildEmailRecords({ ...BASE, body: "   \n\t " })).toEqual([]);
  });
});

describe("parseAddresses (malformed headers)", () => {
  it("keeps a comma inside a quoted display name intact", () => {
    expect(parseAddresses('"Smith, John" <john@x.com>')).toEqual([
      { name: "Smith, John", email: "john@x.com" },
    ]);
  });

  it("still splits a genuine comma-separated list with one quoted name", () => {
    expect(parseAddresses('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual([
      { name: "Doe, Jane", email: "jane@x.com" },
      { email: "bob@y.com" },
    ]);
  });

  it("drops an angle-bracket token that contains no real address", () => {
    // `foo <bar>` is malformed: `bar` is not an email → no bogus email entity.
    expect(parseAddresses("foo <bar>")).toEqual([]);
  });

  it("does not surface a bogus email/person entity for a malformed From header", () => {
    const [r] = buildEmailRecords({ ...BASE, from: "foo <bar>", to: "me@example.com", body: "hi" });
    const ents = r!.entities;
    expect(ents.some((e) => e.value === "bar")).toBe(false);
    expect(ents.some((e) => e.value === "foo")).toBe(false);
    expect(ents).toContainEqual({ kind: "email", value: "me@example.com" });
  });
});
