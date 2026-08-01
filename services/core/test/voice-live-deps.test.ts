/**
 * Tests for the real voice-loop dependencies core injects into @jarvis/voice:
 * SidecarSttEngine (fake WS + fake mic), SidecarTtsEngine (fake fetch + fake
 * player), CoreHttpClient (fake SSE fetch). No network, mic, or speakers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SidecarSttEngine,
  translateFrame,
  type WsLike,
  type MicProcess,
} from "../src/voice/sidecarStt.js";
import {
  SidecarTtsEngine,
  sanitizeForSpeech,
  type PlayerProcess,
} from "../src/voice/sidecarTts.js";
import { CoreHttpClient } from "../src/voice/coreVoiceClient.js";
import { withSidecarWarmup } from "../src/voice/buildVoiceDeps.js";
import type { CoreClient, SttEvent } from "@jarvis/voice";

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeWs implements WsLike {
  readyState = 0;
  sent: Array<Uint8Array | string> = [];
  private listeners = new Map<string, Array<(e: { data?: unknown; message?: string }) => void>>();

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.fire("close", {});
  }
  addEventListener(type: string, listener: (e: { data?: unknown; message?: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  fire(type: string, event: { data?: unknown; message?: string }): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  open(): void {
    this.readyState = 1;
    this.fire("open", {});
  }
  frame(obj: unknown): void {
    this.fire("message", { data: JSON.stringify(obj) });
  }
}

class FakeMic implements MicProcess {
  killed = false;
  private cb: ((chunk: Uint8Array) => void) | null = null;
  onData(cb: (chunk: Uint8Array) => void): void {
    this.cb = cb;
  }
  emit(chunk: Uint8Array): void {
    this.cb?.(chunk);
  }
  kill(): void {
    this.killed = true;
  }
}

function pcmStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect<T>(iter: AsyncIterable<T>, max: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

// ── SidecarSttEngine ──────────────────────────────────────────────────────────

describe("SidecarSttEngine", () => {
  it("forwards mic PCM to the socket and translates frames to SttEvents", async () => {
    const ws = new FakeWs();
    const mic = new FakeMic();
    const engine = new SidecarSttEngine({
      sidecarUrl: "http://127.0.0.1:8089",
      wsFactory: () => ws,
      micFactory: () => mic,
      log: () => {},
    });

    const stream = engine.startStream();
    ws.open();

    mic.emit(new Uint8Array([1, 2, 3, 4]));
    expect(ws.sent).toHaveLength(1); // PCM forwarded once socket is open

    ws.frame({ type: "speech_start" });
    ws.frame({ type: "partial", text: "hello", stability: 0.7 });
    ws.frame({ type: "speech_end" });
    ws.frame({ type: "final", text: "hello world", confidence: 0.93 });

    const events = await collect(stream, 4);
    expect(events).toEqual([
      { type: "speech_start" },
      { type: "partial", text: "hello", stability: 0.7 },
      { type: "speech_end", silenceMs: 0 },
      { type: "final", text: "hello world", confidence: 0.93 },
    ] satisfies SttEvent[]);
  });

  it("stop() kills the mic, closes the socket, and ends the stream", async () => {
    const ws = new FakeWs();
    const mic = new FakeMic();
    const engine = new SidecarSttEngine({
      sidecarUrl: "http://127.0.0.1:8089",
      wsFactory: () => ws,
      micFactory: () => mic,
      log: () => {},
    });

    const stream = engine.startStream();
    ws.open();
    await engine.stop();

    expect(mic.killed).toBe(true);
    expect(ws.readyState).toBe(3);
    const events = await collect(stream, 1); // ended stream yields nothing
    expect(events).toEqual([]);
  });

  it("ignores malformed and error frames without breaking the stream", async () => {
    const ws = new FakeWs();
    const engine = new SidecarSttEngine({
      sidecarUrl: "http://127.0.0.1:8089",
      wsFactory: () => ws,
      micFactory: () => new FakeMic(),
      log: () => {},
    });

    const stream = engine.startStream();
    ws.open();
    ws.fire("message", { data: "not json{{" });
    ws.frame({ type: "error", detail: "transient" });
    ws.frame({ type: "final", text: "still works", confidence: 1 });

    const events = await collect(stream, 1);
    expect(events[0]).toEqual({ type: "final", text: "still works", confidence: 1 });
  });

  it("translateFrame returns null for unknown frame types", () => {
    expect(translateFrame({ type: "bogus" })).toBeNull();
  });

  it("passes the sidecar's honest silence_ms through on speech_end", () => {
    expect(translateFrame({ type: "speech_end", silence_ms: 780 })).toEqual({
      type: "speech_end",
      silenceMs: 780,
    });
  });

  it("defaults silenceMs to 0 when the sidecar omits silence_ms", () => {
    expect(translateFrame({ type: "speech_end" })).toEqual({
      type: "speech_end",
      silenceMs: 0,
    });
  });

  // Phase 13.2: the sidecar's STT engine became swappable (faster-whisper /
  // Deepgram). These cases pin translateFrame's contract so an engine swap
  // can never change the TS-visible event shape — any additive field a new
  // engine attaches to a frame must be silently ignored, never leaked
  // through to @jarvis/voice's SttEvent union.
  it("ignores an extra field on a final frame (engine tag does not leak through)", () => {
    expect(
      translateFrame({
        type: "final",
        text: "hello world",
        confidence: 0.93,
        // @ts-expect-error additive/undocumented field a future engine might attach
        engine: "deepgram",
      }),
    ).toEqual({ type: "final", text: "hello world", confidence: 0.93 });
  });

  it("ignores an extra field on a partial frame (engine tag does not leak through)", () => {
    expect(
      translateFrame({
        type: "partial",
        text: "hello",
        stability: 0.6,
        // @ts-expect-error additive/undocumented field a future engine might attach
        engine: "deepgram",
      }),
    ).toEqual({ type: "partial", text: "hello", stability: 0.6 });
  });

  it("keeps the silence_ms passthrough intact alongside an extra field on speech_end", () => {
    expect(
      translateFrame({
        type: "speech_end",
        silence_ms: 480,
        // @ts-expect-error additive/undocumented field a future engine might attach
        engine: "deepgram",
      }),
    ).toEqual({ type: "speech_end", silenceMs: 480 });
  });

  it("defaults an empty-text final to text: \"\" / confidence: 1 (a Deepgram segment finalizing empty must not crash the orchestrator)", () => {
    expect(translateFrame({ type: "final" })).toEqual({
      type: "final",
      text: "",
      confidence: 1,
    });
  });

  it("returns null for a brand-new frame type — introducing one would be silently dropped, so this phase never does", () => {
    expect(translateFrame({ type: "utterance_end" })).toBeNull();
  });
});

// ── SidecarTtsEngine ──────────────────────────────────────────────────────────

describe("SidecarTtsEngine", () => {
  function makePlayer(): PlayerProcess & { written: Uint8Array[]; ended: boolean; killed: boolean } {
    const player = {
      written: [] as Uint8Array[],
      ended: false,
      killed: false,
      write(chunk: Uint8Array) {
        player.written.push(chunk);
      },
      async end() {
        player.ended = true;
      },
      kill() {
        player.killed = true;
      },
    };
    return player;
  }

  async function* sentences(...items: string[]): AsyncIterable<string> {
    for (const s of items) yield s;
  }

  it("synthesizes each sentence via POST /tts and pipes PCM into ONE player per turn", async () => {
    const players: ReturnType<typeof makePlayer>[] = [];
    const fetchImpl = vi.fn(async () => {
      return new Response(pcmStream(new Uint8Array([9, 9]), new Uint8Array([8])), { status: 200 });
    });

    const engine = new SidecarTtsEngine({
      sidecarUrl: "http://127.0.0.1:8089",
      voice: "bm_fable",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      playerFactory: () => {
        const p = makePlayer();
        players.push(p);
        return p;
      },
      log: () => {},
    });

    await engine.speak(sentences("Good morning, sir.", "Tea is ready."));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody["text"]).toBe("Good morning, sir.");
    expect(sentBody["voice"]).toBe("bm_fable");
    expect(sentBody["request_id"]).toBeTruthy();
    expect(sentBody["speed"]).toBe(0.95); // engine default — slightly slower reads more naturally

    // ONE player for the whole turn: no per-sentence respawn gaps.
    expect(players).toHaveLength(1);
    expect(players[0]!.written.flatMap((c) => [...c])).toEqual([9, 9, 8, 9, 9, 8]);
    expect(players[0]!.ended).toBe(true); // waited for playback drain
  });

  it("strips markdown before synthesis and skips empty results", async () => {
    const texts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      texts.push((JSON.parse(init?.body as string) as { text: string }).text);
      return new Response(pcmStream(new Uint8Array([1])), { status: 200 });
    });

    const engine = new SidecarTtsEngine({
      sidecarUrl: "http://127.0.0.1:8089",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      playerFactory: () => makePlayer(),
      log: () => {},
    });

    await engine.speak(
      sentences("**Bold** and `code` and [a link](http://x.com).", "* * *"),
    );

    expect(texts).toEqual(["Bold and code and a link."]);
  });

  it("cancel() aborts playback, fires /tts/cancel, and stops remaining sentences", async () => {
    const player = makePlayer();
    let cancelPosted = false;
    let activeRequestId = "";

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/tts/cancel")) {
        cancelPosted = true;
        const body = JSON.parse(init?.body as string) as { request_id: string };
        expect(body.request_id).toBe(activeRequestId);
        return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
      }
      const body = JSON.parse(init?.body as string) as { request_id: string };
      activeRequestId = body.request_id;
      // A stream that never closes — playback is mid-flight when cancel hits.
      // Model real fetch semantics: aborting the request errors the body
      // stream, rejecting any in-flight reader.read().
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            init?.signal?.addEventListener("abort", () => {
              try {
                controller.error(new DOMException("The operation was aborted.", "AbortError"));
              } catch {
                // already closed
              }
            });
          },
        }),
        { status: 200 },
      );
    });

    const engine = new SidecarTtsEngine({
      sidecarUrl: "http://127.0.0.1:8089",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      playerFactory: () => player,
      log: () => {},
    });

    const speakPromise = engine.speak(sentences("A very long reply that gets interrupted."));
    await new Promise((r) => setTimeout(r, 20)); // let the stream start
    engine.cancel();

    await speakPromise; // resolves (barge-in is not an error)
    expect(player.killed).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // best-effort cancel POST
    expect(cancelPosted).toBe(true);
  });
});

// ── sanitizeForSpeech ─────────────────────────────────────────────────────────

describe("sanitizeForSpeech", () => {
  it("strips emphasis, inline code, links, headings, bullets", () => {
    expect(sanitizeForSpeech("## Plan\n- **Do** `thing` via [docs](http://d)"))
      .toBe("Plan Do thing via docs");
  });

  it("replaces fenced code blocks", () => {
    expect(sanitizeForSpeech("Look:\n```js\nlet x = 1;\n```\nDone."))
      .toBe("Look: code omitted Done.");
  });

  it("leaves plain prose untouched", () => {
    expect(sanitizeForSpeech("Good evening. All systems are online."))
      .toBe("Good evening. All systems are online.");
  });
});

// ── CoreHttpClient ────────────────────────────────────────────────────────────

describe("CoreHttpClient", () => {
  function sseResponse(frames: object[]): Response {
    const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("yields token text and stops on done", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        { type: "status", state: "ready" },
        { type: "token", text: "Hello" },
        { type: "token", text: " there" },
        { type: "done", conversationId: "conv-1" },
      ]),
    );
    const client = new CoreHttpClient("http://127.0.0.1:8080", fetchImpl as unknown as typeof fetch);

    const tokens = await collect(client.chatStream("hi", "session-1"), 10);
    expect(tokens).toEqual(["Hello", " there"]);
  });

  it("reuses the server conversation id across turns of the same voice session", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return sseResponse([
        { type: "token", text: "ok" },
        { type: "done", conversationId: "conv-42" },
      ]);
    });
    const client = new CoreHttpClient("http://127.0.0.1:8080", fetchImpl as unknown as typeof fetch);

    await collect(client.chatStream("first turn", "session-A"), 10);
    await collect(client.chatStream("second turn", "session-A"), 10);

    expect(bodies[0]!["conversationId"]).toBeUndefined(); // server mints it
    expect(bodies[1]!["conversationId"]).toBe("conv-42"); // reused next turn
  });

  it("throws on SSE error frames", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([{ type: "error", message: "model fault" }]));
    const client = new CoreHttpClient("http://127.0.0.1:8080", fetchImpl as unknown as typeof fetch);

    await expect(collect(client.chatStream("hi"), 10)).rejects.toThrow(/model fault/);
  });

  it("warmup maps the /warmup response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ state: "loading", modelId: "qwen" }), { status: 200 }),
    );
    const client = new CoreHttpClient("http://127.0.0.1:8080", fetchImpl as unknown as typeof fetch);
    expect(await client.warmup()).toEqual({ ok: true, state: "loading", modelId: "qwen" });
  });
});

// ── withSidecarWarmup ─────────────────────────────────────────────────────────

describe("withSidecarWarmup", () => {
  function fakeCore(): CoreClient & { warmups: number } {
    const core = {
      warmups: 0,
      async warmup() {
        core.warmups++;
        return { ok: true, state: "ready" };
      },
      async *chatStream(): AsyncIterable<string> {
        yield "tok";
      },
    };
    return core as CoreClient & { warmups: number };
  }

  it("fires the sidecar /warmup alongside core warmup", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const core = fakeCore();

    const wrapped = withSidecarWarmup(core, "http://127.0.0.1:8089", fetchImpl);
    const result = await wrapped.warmup();

    expect(result).toEqual({ ok: true, state: "ready" });
    expect(core.warmups).toBe(1);
    expect(urls).toEqual(["http://127.0.0.1:8089/warmup"]);
  });

  it("sidecar warmup failure never blocks the wake path", async () => {
    const fetchImpl = (async () => {
      throw new Error("sidecar down");
    }) as unknown as typeof fetch;
    const core = fakeCore();

    const wrapped = withSidecarWarmup(core, "http://127.0.0.1:8089", fetchImpl);
    const result = await wrapped.warmup();

    expect(result.ok).toBe(true);
    expect(core.warmups).toBe(1);
  });
});
