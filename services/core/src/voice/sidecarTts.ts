/**
 * SidecarTtsEngine — real TtsEngine over the voice sidecar's POST /tts.
 *
 * Each sentence from the orchestrator's chunker is synthesized as one /tts
 * request (raw PCM-16 LE mono 24 kHz streamed back) and piped straight into a
 * speaker process (ffplay) as it arrives — playback starts on the first chunk,
 * not after the sentence completes.
 *
 * Voice: the sidecar's default is bm_fable (British English). Override with
 * JARVIS_TTS_VOICE / the `voice` option.
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
  /** Kokoro voice id; omitted → sidecar default (bm_fable, British). */
  voice?: string;
  speed?: number;
  fetchImpl?: typeof fetch;
  playerFactory?: () => PlayerProcess;
  log?: (line: string) => void;
}

function defaultPlayerFactory(): PlayerProcess {
  const proc = spawn(
    "ffplay",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-nodisp",
      "-autoexit",
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

    for await (const sentence of sentences) {
      if (this.cancelled || signal?.aborted) break;
      const text = sentence.trim();
      if (!text) continue;
      try {
        await this.speakOne(text);
      } catch (err) {
        if (this.cancelled) break; // cancellation aborts the fetch — expected
        this.log(`[tts] synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }

  private async speakOne(text: string): Promise<void> {
    const requestId = randomUUID();
    const abort = new AbortController();
    this.currentRequestId = requestId;
    this.currentAbort = abort;

    const body: Record<string, unknown> = {
      text,
      request_id: requestId,
      speed: this.opts.speed ?? 1.0,
    };
    if (this.opts.voice) body["voice"] = this.opts.voice;

    const res = await this.fetchImpl(`${this.opts.sidecarUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`TTS HTTP ${res.status}`);
    }

    const player = (this.opts.playerFactory ?? defaultPlayerFactory)();
    this.currentPlayer = player;

    const reader = res.body.getReader();
    try {
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
      if (this.cancelled) {
        player.kill();
      } else {
        await player.end(); // wait for the speaker to drain
      }
      this.currentPlayer = null;
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
