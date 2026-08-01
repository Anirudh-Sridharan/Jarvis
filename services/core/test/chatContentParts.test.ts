/**
 * chatContentParts.test.ts
 *
 * Phase 15 Tier 3 plumbing: the ContentPart widening of ChatMessage.content
 * (types.ts) plus the local-fallback guard it enables (mlxProvider.ts,
 * gateway.ts). Task 1 covers the pure helpers; Task 2 extends this file with
 * the MlxProvider vision-refusal case and the gateway cloud-pin case.
 */

import { describe, it, expect } from "vitest";
import {
  messageText,
  messageHasImagePart,
  requestHasImagePart,
  type ChatMessage,
} from "../src/inference/types.js";

describe("messageText", () => {
  it("returns a plain string unchanged", () => {
    expect(messageText("hello world")).toBe("hello world");
  });

  it("joins text parts with a newline", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "text" as const, text: "second" },
    ];
    expect(messageText(content)).toBe("first\nsecond");
  });

  it("ignores image parts in a mixed array", () => {
    const content = [
      { type: "text" as const, text: "look at this" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAA" } },
    ];
    expect(messageText(content)).toBe("look at this");
  });

  it("returns an empty string for an image-only array", () => {
    const content = [
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAA" } },
    ];
    expect(messageText(content)).toBe("");
  });
});

describe("messageHasImagePart", () => {
  it("is false for a plain-string message", () => {
    const msg: ChatMessage = { role: "user", content: "hi" };
    expect(messageHasImagePart(msg)).toBe(false);
  });

  it("is false for a text-only parts array", () => {
    const msg: ChatMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(messageHasImagePart(msg)).toBe(false);
  });

  it("is true when a parts array contains an image_url part", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    };
    expect(messageHasImagePart(msg)).toBe(true);
  });
});

describe("requestHasImagePart", () => {
  it("is false for undefined", () => {
    expect(requestHasImagePart(undefined)).toBe(false);
  });

  it("is false for an empty array", () => {
    expect(requestHasImagePart([])).toBe(false);
  });

  it("is true when any message in a mixed list carries an image part", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      {
        role: "user",
        content: [
          { type: "text", text: "what's this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    expect(requestHasImagePart(messages)).toBe(true);
  });

  it("is false when no message in the list carries an image part", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
    ];
    expect(requestHasImagePart(messages)).toBe(false);
  });
});
