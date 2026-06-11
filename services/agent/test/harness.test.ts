/**
 * Tests for the validate-and-retry harness (feature 16).
 *
 * Key claim from spec: "raw local-model tool-calling is unreliable <7% without help,
 * ~100% with a harness". These tests prove the mechanism:
 *   - Invalid JSON → retry with feedback → valid on 2nd try
 *   - Exhausts retries → abort
 *   - Tool not found → feedback → correct tool on retry
 *   - Args schema mismatch → ZodError feedback → corrected args
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  validateAndRetry,
  parseLlmToolCall,
  buildToolCallPrompt,
  MAX_VALIDATION_RETRIES,
} from "../src/core/harness.js";
import {
  FakeLlm,
  FakeSearchTool,
  FakeSendEmailTool,
  makeToolRegistry,
} from "../src/testing/fakes.js";

// ── parseLlmToolCall unit tests ──────────────────────────────────────────────

describe("parseLlmToolCall", () => {
  it("parses hermes format { tool, args }", () => {
    const result = parseLlmToolCall(
      '{"tool": "search", "args": {"query": "test"}}',
    );
    expect(result).toEqual({ tool: "search", args: { query: "test" } });
  });

  it("parses openai format { name, arguments }", () => {
    const result = parseLlmToolCall(
      '{"name": "search", "arguments": {"query": "test"}}',
    );
    expect(result).toEqual({ tool: "search", args: { query: "test" } });
  });

  it("parses arguments as JSON string in openai format", () => {
    const result = parseLlmToolCall(
      '{"name": "search", "arguments": "{\\"query\\": \\"hello\\"}"}',
    );
    expect(result).toEqual({ tool: "search", args: { query: "hello" } });
  });

  it("extracts JSON from code block", () => {
    const result = parseLlmToolCall(
      "```json\n{\"tool\": \"search\", \"args\": {\"query\": \"foo\"}}\n```",
    );
    expect(result).toEqual({ tool: "search", args: { query: "foo" } });
  });

  it("returns null for invalid JSON", () => {
    expect(parseLlmToolCall("not json at all")).toBeNull();
  });

  it("returns null when openai-format arguments string is unparseable (no silent {} coercion)", () => {
    expect(
      parseLlmToolCall('{"name": "search", "arguments": "{not valid json"}'),
    ).toBeNull();
  });

  it("returns null for JSON without tool/name", () => {
    expect(parseLlmToolCall('{"x": 1}')).toBeNull();
  });
});

// ── buildToolCallPrompt grounding ────────────────────────────────────────────

describe("buildToolCallPrompt", () => {
  it("instructs the model to ground user claims in tool results, not invent them", () => {
    const search = new FakeSearchTool();
    const prompt = buildToolCallPrompt("find my next meeting", [], [search]);
    expect(prompt).toContain("never invent personal details");
    expect(prompt).toContain("tool");
  });
});

// ── validateAndRetry harness tests ───────────────────────────────────────────

describe("validateAndRetry harness", () => {
  const makeTools = () => {
    const search = new FakeSearchTool();
    const sendEmail = new FakeSendEmailTool();
    return makeToolRegistry([search, sendEmail]);
  };

  it("succeeds on first try with valid tool call", async () => {
    const llm = new FakeLlm().setScript([
      '{"tool": "search", "args": {"query": "hello"}}',
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "search for hello",
      scratchpad: [],
      tools: makeTools(),
    });

    expect("aborted" in result).toBe(false);
    if (!("aborted" in result)) {
      expect(result.toolName).toBe("search");
      expect(result.args).toMatchObject({ query: "hello" });
      expect(result.attempts).toBe(1);
    }
  });

  it("retries after invalid JSON → succeeds on 2nd try", async () => {
    const llm = new FakeLlm().setScript([
      "not valid json at all", // attempt 1: bad JSON
      '{"tool": "search", "args": {"query": "test"}}', // attempt 2: valid
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "search for test",
      scratchpad: [],
      tools: makeTools(),
    });

    expect("aborted" in result).toBe(false);
    if (!("aborted" in result)) {
      expect(result.toolName).toBe("search");
      expect(result.attempts).toBe(2);
    }
    // LLM was called twice
    expect(llm.callLog.length).toBe(2);
  });

  it("retries after schema validation failure → succeeds on 2nd try", async () => {
    const llm = new FakeLlm().setScript([
      // attempt 1: missing required 'to' field for email_send
      '{"tool": "email_send", "args": {"subject": "Hi", "body": "Hello"}}',
      // attempt 2: complete valid args
      '{"tool": "email_send", "args": {"to": ["bob@test.com"], "subject": "Hi", "body": "Hello"}}',
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "send email to bob",
      scratchpad: [],
      tools: makeTools(),
    });

    expect("aborted" in result).toBe(false);
    if (!("aborted" in result)) {
      expect(result.toolName).toBe("email_send");
      expect((result.args as { to: string[] }).to).toContain("bob@test.com");
      expect(result.attempts).toBe(2);
    }
    // Retry feedback was included in second prompt
    expect(llm.callLog[1]).toContain("failed schema validation");
  });

  it("retries after unknown tool → corrects on retry", async () => {
    const llm = new FakeLlm().setScript([
      '{"tool": "nonexistent_tool", "args": {}}', // attempt 1: bad tool
      '{"tool": "search", "args": {"query": "test"}}', // attempt 2: correct
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "search test",
      scratchpad: [],
      tools: makeTools(),
    });

    expect("aborted" in result).toBe(false);
    if (!("aborted" in result)) {
      expect(result.toolName).toBe("search");
    }
    // Second prompt contains the "Unknown tool" feedback
    expect(llm.callLog[1]).toContain("Unknown tool");
  });

  it("aborts after exhausting all retries", async () => {
    // Every attempt returns garbage
    const llm = new FakeLlm().setScript([
      "garbage",
      "more garbage",
      "still garbage",
      "final garbage",
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "search test",
      scratchpad: [],
      tools: makeTools(),
      maxRetries: MAX_VALIDATION_RETRIES,
    });

    expect("aborted" in result).toBe(true);
    if ("aborted" in result) {
      expect(result.aborted).toBe("invalid-tool");
    }
    // Called exactly MAX_VALIDATION_RETRIES times
    expect(llm.callLog.length).toBe(MAX_VALIDATION_RETRIES);
  });

  it("malformed openai arguments string → retry-with-feedback, never execution with {}", async () => {
    // A tool whose schema is ALL-OPTIONAL: {} would validate, so the old
    // silent-{} coercion would have executed with args the model never produced.
    const noop = {
      name: "noop",
      description: "All-optional args",
      schema: z.object({ mode: z.string().optional() }),
      readOnly: true,
      run: async () => "ok",
    };
    const tools = makeToolRegistry([noop]);

    const llm = new FakeLlm().setScript([
      '{"name": "noop", "arguments": "{broken json"}', // attempt 1: malformed
      '{"tool": "noop", "args": {"mode": "safe"}}', // attempt 2: valid
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "do the thing",
      scratchpad: [],
      tools,
    });

    expect("aborted" in result).toBe(false);
    if (!("aborted" in result)) {
      // It retried — it did NOT succeed on attempt 1 with coerced {}.
      expect(result.attempts).toBe(2);
      expect(result.args).toMatchObject({ mode: "safe" });
    }
    expect(llm.callLog.length).toBe(2);
    expect(llm.callLog[1]).toContain("Could not parse");
  });

  it("passes the __done__ sentinel through without validation", async () => {
    const llm = new FakeLlm().setScript([
      '{"tool": "__done__", "args": {"result": "task complete"}}',
    ]);

    const result = await validateAndRetry({
      llm,
      goal: "do something",
      scratchpad: [],
      tools: makeTools(),
    });

    expect("aborted" in result).toBe(false);
    if (!("aborted" in result)) {
      expect(result.toolName).toBe("__done__");
      expect((result.args as Record<string, unknown>)["result"]).toBe("task complete");
    }
  });

  it("includes scratchpad in the prompt for context", async () => {
    const llm = new FakeLlm().setScript([
      '{"tool": "search", "args": {"query": "context test"}}',
    ]);

    await validateAndRetry({
      llm,
      goal: "search with context",
      scratchpad: ["[tool:search] → previous result"],
      tools: makeTools(),
    });

    expect(llm.callLog[0]).toContain("previous result");
  });
});
