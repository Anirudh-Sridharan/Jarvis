/**
 * Chat CLI (feature 2): a tiny REPL that talks to the running core server.
 *
 * Reads lines from stdin, POSTs each to POST /chat, and prints streamed tokens
 * live. The core server must already be running (`npm run dev`).
 *
 * Env:
 *   CORE_URL  (default http://127.0.0.1:${CORE_PORT||8080})
 */
import "../loadEnv.js"; // MUST be first: populates process.env from .env (e.g. CORE_PORT)
import { createInterface } from "node:readline";

const port = process.env["CORE_PORT"] ?? "8080";
const baseUrl = process.env["CORE_URL"] ?? `http://127.0.0.1:${port}`;

let conversationId: string | undefined;

async function ping(): Promise<boolean> {
  try {
    const res = await fetch(new URL("/healthz", baseUrl), {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface SseEvent {
  type: "status" | "token" | "done" | "error";
  state?: string;
  text?: string;
  conversationId?: string;
  messageId?: string;
  message?: string;
}

async function sendMessage(message: string): Promise<void> {
  const res = await fetch(new URL("/chat", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, conversationId }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    process.stdout.write(`\n[error] HTTP ${res.status}: ${text}\n`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let printedHeader = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice("data:".length).trim();
        if (!data) continue;
        let ev: SseEvent;
        try {
          ev = JSON.parse(data) as SseEvent;
        } catch {
          continue;
        }
        switch (ev.type) {
          case "status":
            if (ev.state === "loading") process.stdout.write("\n[waking up…] ");
            break;
          case "token":
            if (!printedHeader) {
              process.stdout.write("\nJarvis: ");
              printedHeader = true;
            }
            process.stdout.write(ev.text ?? "");
            break;
          case "done":
            conversationId = ev.conversationId ?? conversationId;
            process.stdout.write("\n");
            break;
          case "error":
            process.stdout.write(`\n[error] ${ev.message ?? "unknown error"}\n`);
            break;
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const up = await ping();
  if (!up) {
    console.error(
      `Cannot reach the Jarvis core at ${baseUrl}. Start it first with: npm run dev`,
    );
    process.exit(1);
  }

  console.error(`Connected to Jarvis core at ${baseUrl}. Type a message (Ctrl+C to quit).`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\nYou: " });
  rl.prompt();

  rl.on("line", async (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }
    try {
      await sendMessage(message);
    } catch (err) {
      console.error(`\n[error] ${err instanceof Error ? err.message : String(err)}`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.error("\nBye.");
    process.exit(0);
  });
}

void main();
