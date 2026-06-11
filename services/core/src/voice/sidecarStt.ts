/**
 * SidecarSttEngine — real SttEngine over the voice sidecar's WS /stt/stream.
 *
 * Mic capture: spawns ffmpeg (avfoundation) producing PCM-16 LE mono 16 kHz on
 * stdout, which is forwarded to the sidecar as binary WebSocket frames. The
 * sidecar answers with JSON text frames (speech_start / partial / speech_end /
 * final / error) which are translated into @jarvis/voice SttEvents.
 *
 * Note: the sidecar's speech_end frame reports silence_ms — the time since
 * the last voiced frame (VAD hangover + Whisper transcription) — which the
 * orchestrator counts toward its end-of-turn silence threshold so silence the
 * VAD already observed is not waited out twice.
 *
 * The WebSocket factory and mic process are injectable so tests run with no
 * network, no mic, and no ffmpeg.
 */

import { spawn } from "node:child_process";
import type { SttEngine, SttEvent } from "@jarvis/voice";

// ── Injectable boundaries ─────────────────────────────────────────────────────

/** Minimal surface of a browser-style WebSocket (Node ≥22 global). */
export interface WsLike {
  send(data: Uint8Array | string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void;
  readyState: number;
}

export interface MicProcess {
  /** Register a PCM chunk callback. */
  onData(cb: (chunk: Uint8Array) => void): void;
  kill(): void;
}

export interface SidecarSttOptions {
  /** e.g. http://127.0.0.1:8089 — converted to ws:// for the stream. */
  sidecarUrl: string;
  wsFactory?: (url: string) => WsLike;
  micFactory?: () => MicProcess;
  /** avfoundation audio device (":<index>" or ":default"). */
  micDevice?: string;
  log?: (line: string) => void;
}

const WS_OPEN = 1;

function defaultMicFactory(device: string): MicProcess {
  const proc = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "avfoundation",
      "-i", device,
      "-ar", "16000",
      "-ac", "1",
      "-f", "s16le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[mic] ${msg}`);
  });
  return {
    onData: (cb) => proc.stdout.on("data", cb),
    kill: () => proc.kill("SIGKILL"),
  };
}

// ── Async event queue (push-based → AsyncIterable) ────────────────────────────

class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

interface SidecarFrame {
  type?: string;
  text?: string;
  stability?: number;
  confidence?: number;
  detail?: string;
  silence_ms?: number;
}

export class SidecarSttEngine implements SttEngine {
  private ws: WsLike | null = null;
  private mic: MicProcess | null = null;
  private queue: AsyncQueue<SttEvent> | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: SidecarSttOptions) {
    this.log = opts.log ?? ((l) => console.error(l));
  }

  startStream(): AsyncIterable<SttEvent> {
    // A previous session may still be open if stop() raced — close it first.
    this.teardown();

    const queue = new AsyncQueue<SttEvent>();
    this.queue = queue;

    const wsUrl =
      this.opts.sidecarUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/stt/stream";
    const ws = (this.opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(
      wsUrl,
    );
    this.ws = ws;

    ws.addEventListener("open", () => {
      // Mic starts only once the socket can take frames.
      const mic = (this.opts.micFactory ?? (() => defaultMicFactory(this.opts.micDevice ?? ":default")))();
      this.mic = mic;
      mic.onData((chunk) => {
        if (ws.readyState === WS_OPEN) ws.send(chunk);
      });
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let frame: SidecarFrame;
      try {
        frame = JSON.parse(event.data) as SidecarFrame;
      } catch {
        return; // malformed frame — ignore
      }
      const translated = translateFrame(frame);
      if (translated) queue.push(translated);
      else if (frame.type === "error") this.log(`[stt] sidecar error: ${frame.detail}`);
    });

    ws.addEventListener("close", () => queue.end());
    ws.addEventListener("error", (e) => {
      this.log(`[stt] websocket error: ${e.message ?? "unknown"}`);
      queue.end();
    });

    return queue;
  }

  async stop(): Promise<void> {
    this.teardown();
  }

  private teardown(): void {
    this.mic?.kill();
    this.mic = null;
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    this.queue?.end();
    this.queue = null;
  }
}

export function translateFrame(frame: SidecarFrame): SttEvent | null {
  switch (frame.type) {
    case "speech_start":
      return { type: "speech_start" };
    case "partial":
      return { type: "partial", text: frame.text ?? "", stability: frame.stability ?? 0.5 };
    case "speech_end":
      // The sidecar reports silence since the last voiced frame (VAD hangover
      // + transcription time); the orchestrator counts it toward end-of-turn.
      return {
        type: "speech_end",
        silenceMs: typeof frame.silence_ms === "number" ? frame.silence_ms : 0,
      };
    case "final":
      return { type: "final", text: frame.text ?? "", confidence: frame.confidence ?? 1 };
    default:
      return null;
  }
}
