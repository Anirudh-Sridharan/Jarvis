"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const CORE_URL =
  process.env.NEXT_PUBLIC_CORE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8080";

// ---- Wire types (the core /chat SSE contract) ------------------------------
// POST /chat { message, conversationId? } → SSE stream of `data: <json>` lines:
//   { type: "status", state }                         model state transition
//   { type: "token",  text }                          one streamed delta
//   { type: "done",   conversationId, messageId }     turn finished
//   { type: "error",  message }                       turn failed
type ChatEvent =
  | { type: "status"; state: string }
  | { type: "token"; text: string }
  | { type: "done"; conversationId: string; messageId: string }
  | { type: "error"; message: string };

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversationId = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest content as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, waking]);

  // Abort any in-flight stream on unmount so the reader loop stops instead of
  // running (and firing setState) after navigation away. The abort surfaces in
  // send() as an AbortError, which is already swallowed; React treats the
  // post-unmount setState calls in `finally` as no-ops.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const appendToAssistant = useCallback((id: string, text: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + text } : m)),
    );
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    setInput("");

    const userMsg: ChatMessage = { id: uid(), role: "user", content: text };
    const assistantId = uid();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${CORE_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          message: text,
          conversationId: conversationId.current,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`core responded ${res.status}`);
      }

      // ---- SSE / streamed-fetch parsing -----------------------------------
      // Read the ReadableStream, decode incrementally, split on the SSE event
      // delimiter (\n\n), strip the `data: ` prefix off each line, JSON.parse
      // the payload, and dispatch by event type. A trailing partial event is
      // kept in `buffer` until its delimiter arrives in a later chunk.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let gotToken = false;

      const handleEvent = (raw: string) => {
        // An SSE event can carry multiple `data:` lines; concatenate them.
        const dataLines = raw
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""));
        if (dataLines.length === 0) return;
        const payload = dataLines.join("\n").trim();
        if (!payload || payload === "[DONE]") return;

        let evt: ChatEvent;
        try {
          evt = JSON.parse(payload) as ChatEvent;
        } catch {
          return; // ignore unparseable keep-alive / comment frames
        }

        switch (evt.type) {
          case "status":
            setWaking(evt.state === "loading");
            break;
          case "token":
            if (!gotToken) {
              gotToken = true;
              setWaking(false);
            }
            appendToAssistant(assistantId, evt.text);
            break;
          case "done":
            conversationId.current = evt.conversationId;
            setWaking(false);
            break;
          case "error":
            setWaking(false);
            setError(evt.message || "Generation failed.");
            break;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (rawEvent.trim()) handleEvent(rawEvent);
        }
      }
      // Flush any final event not terminated by a trailing delimiter.
      if (buffer.trim()) handleEvent(buffer);
    } catch (err) {
      const aborted =
        err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        setError(
          err instanceof Error
            ? `Could not reach Jarvis core (${err.message}).`
            : "Could not reach Jarvis core.",
        );
      }
    } finally {
      setStreaming(false);
      setWaking(false);
      abortRef.current = null;
      // Drop an empty assistant bubble if nothing ever streamed (and no error
      // bubble will explain it — error renders separately).
      setMessages((prev) =>
        prev.filter((m) => !(m.id === assistantId && m.content === "")),
      );
    }
  }, [input, streaming, appendToAssistant]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat">
      <div className="chat__messages" ref={scrollRef}>
        {messages.length === 0 && !error ? (
          <div className="chat__empty">
            <h1>Jarvis</h1>
            <p>
              Capable, concise, slightly witty. Ask anything — replies stream in
              live. Enter to send, Shift+Enter for a new line.
            </p>
          </div>
        ) : null}

        {messages.map((m) => (
          <div key={m.id} className={`bubble bubble--${m.role}`}>
            <div className="bubble__role">
              {m.role === "user" ? "You" : "Jarvis"}
            </div>
            {m.content}
            {m.role === "assistant" && streaming && m.content === "" && !waking ? (
              <span className="caret">&nbsp;</span>
            ) : null}
          </div>
        ))}

        {waking ? <div className="waking">Waking Jarvis…</div> : null}

        {error ? <div className="bubble bubble--error">{error}</div> : null}
      </div>

      <div className="composer">
        <textarea
          className="composer__input"
          placeholder="Type a message…"
          rows={1}
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button className="composer__btn composer__btn--stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            className="composer__btn"
            onClick={() => void send()}
            disabled={!input.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
