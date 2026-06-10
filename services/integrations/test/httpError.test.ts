import { describe, it, expect } from "vitest";
import { httpError, httpErrorDetail } from "../src/framework/httpError.js";

describe("httpErrorDetail", () => {
  it("extracts Google-style { error: { message } } bodies", () => {
    const body = { error: { code: 403, message: "Calendar API has not been used in project X" } };
    expect(httpErrorDetail(body)).toBe("Calendar API has not been used in project X");
  });

  it("extracts string bodies, flat message fields, and string error fields", () => {
    expect(httpErrorDetail("plain text error")).toBe("plain text error");
    expect(httpErrorDetail({ message: "flat" })).toBe("flat");
    expect(httpErrorDetail({ error: "stringy" })).toBe("stringy");
  });

  it("returns empty string for empty/unknown bodies", () => {
    expect(httpErrorDetail(null)).toBe("");
    expect(httpErrorDetail(undefined)).toBe("");
    expect(httpErrorDetail({ items: [] })).toBe("");
  });

  it("collapses whitespace and truncates long details", () => {
    expect(httpErrorDetail("a\n  b\t c")).toBe("a b c");
    const long = "x".repeat(500);
    expect(httpErrorDetail(long)).toHaveLength(301); // 300 + ellipsis
  });
});

describe("httpError", () => {
  it("appends the body detail when present", () => {
    const err = httpError("Calendar sync failed", {
      status: 403,
      body: { error: { message: "enable the API" } },
    });
    expect(err.message).toBe("Calendar sync failed: HTTP 403 — enable the API");
  });

  it("keeps the bare form when the body has no detail", () => {
    const err = httpError("Calendar sync failed", { status: 500, body: null });
    expect(err.message).toBe("Calendar sync failed: HTTP 500");
  });
});
