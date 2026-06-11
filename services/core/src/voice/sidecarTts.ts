/**
 * SidecarTtsEngine — real TtsEngine over the voice sidecar's POST /tts.
 *
 * Each sentence from the orchestrator's chunker is synthesized as one /tts
 * request (raw PCM-16 LE mono 24 kHz streamed back). All of a turn's PCM is
 * piped into ONE speaker process (ffplay) spawned on the first sentence —
 * playback starts on the first chunk and there are no per-sentence respawn
 * gaps (which read as choppy, robotic delivery).
 *
 * Voice: the sidecar's default is a British Kokoro blend. Override with
 * JARVIS_TTS_VOICE / the `voice` option. Speed defaults to 0.95 (Kokoro
 * sounds most natural slightly slowed); JARVIS_TTS_SPEED / `speed` override.
 *
 * Sentences are markdown-stripped before synthesis (sanitizeForSpeech) so
 * Jarvis never reads out asterisks or backticks.
 *
 * cancel() — the barge-in path — aborts the in-flight fetch, fires
 * POST /tts/cancel for the active request_id, kills the player, and makes the
 * sentence loop drain without speaking the rest. speak() RESOLVES on cancel
 * (the orchestrator treats a cancelled turn as bargedIn, not an error).
 *
 * fetch and the player process are injectable for tests.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { TtsEngine } from "@jarvis/voice";

export interface PlayerProcess {
  write(chunk: Uint8Array): void;
  /** Close stdin; resolves when playback finished. */
  end(): Promise<void>;
  kill(): void;
}

export interface SidecarTtsOptions {
  sidecarUrl: string;
  /** Kokoro voice id or blend spec; omitted → sidecar default (British blend). */
  voice?: string;
  /** Playback speed multiplier. Default 0.95 (Kokoro is most natural slightly slowed). */
  speed?: number;
  fetchImpl?: typeof fetch;
  playerFactory?: () => PlayerProcess;
  log?: (line: string) => void;
}

/**
 * Strip markdown the LLM may emit — TTS should speak words, not syntax.
 * Conservative: removes markers, keeps the content.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code omitted ")
    .replace(/```\w*/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultPlayerFactory(): PlayerProcess {
  const proc = spawn(
    "ffplay",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-nodisp",
      "-autoexit",
      // Raw PCM needs no probing; default demuxer buffering adds startup lag.
      "-probesize", "32",
      "-analyzeduration", "0",
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-f", "s16le",
      "-ar", "24000",
      "-i", "pipe:0",
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  proc.stderr.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[speaker] ${msg}`);
  });
  return {
    write: (chunk) => {
      if (!proc.killed && proc.stdin.writable) proc.stdin.write(chunk);
    },
    end: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.killed) return resolve();
        proc.once("exit", () => resolve());
        proc.stdin.end();
      }),
    kill: () => proc.kill("SIGKILL"),
  };
}

export class SidecarTtsEngine implements TtsEngine {
  private cancelled = false;
  private currentRequestId: string | null = null;
  private currentAbort: AbortController | null = null;
  private currentPlayer: PlayerProcess | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: SidecarTtsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? ((l) => console.error(l));
  }

  async speak(sentences: AsyncIterable<string>, signal?: AbortSignal): Promise<void> {
    this.cancelled = false;
    signal?.addEventListener("abort", () => this.cancel(), { once: true });

    // ONE player per turn: every sentence's PCM goes into the same stdin so
    // there are no per-sentence respawn gaps.
    let player: PlayerProcess | null = null;

    try {
      for await (const sentence of sentences) {
        if (this.cancelled || signal?.aborted) break;
        const text = sanitizeForSpeech(sentence);
        if (!text) continue;
        try {
          if (!player) {
            player = (this.opts.playerFactory ?? defaultPlayerFactory)();
            this.currentPlayer = player;
          }
          await this.speakOne(text, player);
        } catch (err) {
          if (this.cancelled) break; // cancellation aborts the fetch — expected
          this.log(`[tts] synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
    } finally {
      if (player) {
        if (this.cancelled) {
          player.kill();
        } else {
          await player.end(); // wait for the speaker to drain
        }
      }
      this.currentPlayer = null;
    }
  }

  private async speakOne(text: string, player: PlayerProcess): Promise<void> {
    const requestId = randomUUID();
    const abort = new AbortController();
    this.currentRequestId = requestId;
    this.currentAbort = abort;

    const body: Record<string, unknown> = {
      text,
      request_id: requestId,
      speed: this.opts.speed ?? 0.95,
    };
    if (this.opts.voice) body["voice"] = this.opts.voice;

    try {
      const res = await this.fetchImpl(`${this.opts.sidecarUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`TTS HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.cancelled) {
          await reader.cancel().catch(() => {});
          break;
        }
        if (value) player.write(value);
      }
    } finally {
      this.currentRequestId = null;
      this.currentAbort = null;
    }
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    const requestId = this.currentRequestId;
    this.currentAbort?.abort();
    this.currentPlayer?.kill();

    if (requestId) {
      // Best-effort: tell the sidecar to stop synthesizing this request.
      void this.fetchImpl(`${this.opts.sidecarUrl}/tts/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId }),
      }).catch(() => {});
    }
  }
}
