/**
 * Test fakes for @jarvis/voice — scriptable doubles for all injected interfaces.
 *
 * FakeWakeWordSource  — programmatically fire wake events
 * FakeSttEngine       — script a sequence of STT/VAD events
 * FakeTtsEngine       — records spoken sentences; supports cancel
 * FakeCoreClient      — scriptable token stream; records warmup calls
 */

import type {
  WakeWordSource,
  WakeEvent,
  SttEngine,
  SttEvent,
  TtsEngine,
  CoreClient,
  WarmupResult,
} from "../interfaces.js";

// ---------------------------------------------------------------------------
// FakeWakeWordSource
// ---------------------------------------------------------------------------

export class FakeWakeWordSource implements WakeWordSource {
  private listeners: Array<(event: WakeEvent) => void> = [];
  public started = false;
  public stopped = false;

  onWake(listener: (event: WakeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Test helper: fire a wake event to all listeners. */
  fire(partial?: Partial<WakeEvent>): void {
    const event: WakeEvent = {
      id: partial?.id ?? "fake-wake-1",
      source: partial?.source ?? "wakeword",
      phrase: "Hey Jarvis",
      confidence: partial?.confidence ?? 0.95,
      timestamp: partial?.timestamp ?? Date.now(),
      deviceId: partial?.deviceId ?? "fake-device",
      warmTriggered: partial?.warmTriggered ?? false,
    };
    for (const l of this.listeners) {
      l(event);
    }
  }
}

// ---------------------------------------------------------------------------
// FakeSttEngine
// ---------------------------------------------------------------------------

export class FakeSttEngine implements SttEngine {
  private script: SttEvent[] = [];
  private stopped = false;
  private _streaming = false;
  private resolve: (() => void) | null = null;
  /** Number of startStream() iterations currently active. */
  public activeStreams = 0;
  /** Highest number of concurrently active streams ever observed. */
  public maxConcurrentStreams = 0;
  /** Total number of startStream() calls. */
  public streamCount = 0;
  /**
   * When true, the stream stays open after the script is exhausted until
   * stop() is called — like a real engine that keeps listening through
   * silence. Lets tests exercise silence-timeout paths.
   */
  public holdOpenAfterScript = false;

  /** Set the script of events to emit when startStream() is called. */
  setScript(events: SttEvent[]): void {
    this.script = [...events];
  }

  get isStreaming(): boolean {
    return this._streaming;
  }

  async *startStream(): AsyncGenerator<SttEvent> {
    this._streaming = true;
    this.stopped = false;
    this.streamCount++;
    this.activeStreams++;
    this.maxConcurrentStreams = Math.max(
      this.maxConcurrentStreams,
      this.activeStreams,
    );
    try {
      for (const event of this.script) {
        if (this.stopped) break;
        yield event;
        // Tiny yield to allow event loop to process between events
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      if (this.holdOpenAfterScript && !this.stopped) {
        await new Promise<void>((r) => {
          this.resolve = r;
        });
      }
    } finally {
      this.activeStreams--;
      this._streaming = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this._streaming = false;
    this.resolve?.();
    this.resolve = null;
  }
}

// ---------------------------------------------------------------------------
// FakeTtsEngine
// ---------------------------------------------------------------------------

export interface TtsSpeakCall {
  sentences: string[];
  wasCancelled: boolean;
}

export class FakeTtsEngine implements TtsEngine {
  public calls: TtsSpeakCall[] = [];
  public cancelCount = 0;
  private _speaking = false;
  private _cancelRequested = false;
  /** If set, speak() will take this many ms per sentence (for timing tests). */
  public msPerSentence = 0;

  get isSpeaking(): boolean {
    return this._speaking;
  }

  async speak(sentences: AsyncIterable<string>, signal?: AbortSignal): Promise<void> {
    this._speaking = true;
    this._cancelRequested = false;
    const collected: string[] = [];

    try {
      for await (const sentence of sentences) {
        if (this._cancelRequested || signal?.aborted) break;
        collected.push(sentence);
        if (this.msPerSentence > 0) {
          await new Promise<void>((r) => setTimeout(r, this.msPerSentence));
        }
      }
    } finally {
      this._speaking = false;
      this.calls.push({
        sentences: collected,
        wasCancelled: this._cancelRequested || (signal?.aborted ?? false),
      });
    }
  }

  cancel(): void {
    this.cancelCount++;
    this._cancelRequested = true;
    this._speaking = false;
  }

  /** Return the last speak call's sentences. */
  get lastSpokenSentences(): string[] {
    return this.calls[this.calls.length - 1]?.sentences ?? [];
  }
}

// ---------------------------------------------------------------------------
// FakeCoreClient
// ---------------------------------------------------------------------------

export class FakeCoreClient implements CoreClient {
  public warmupCalls = 0;
  /** Messages passed to chatStream, in order. */
  public chatCalls: string[] = [];
  public warmupResult: WarmupResult = { ok: true, state: "ready" };
  public tokenScript: string[] = [];
  /** If non-null, warmup() rejects with this error. */
  public warmupError: Error | null = null;
  /** If non-null, chatStream() rejects after this many tokens. */
  public chatErrorAfterTokens: number | null = null;

  async warmup(): Promise<WarmupResult> {
    this.warmupCalls++;
    if (this.warmupError) throw this.warmupError;
    return this.warmupResult;
  }

  async *chatStream(
    message: string,
    _conversationId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    this.chatCalls.push(message);
    let count = 0;
    for (const token of this.tokenScript) {
      if (signal?.aborted) return;
      if (
        this.chatErrorAfterTokens !== null &&
        count >= this.chatErrorAfterTokens
      ) {
        throw new Error("FakeCoreClient: scripted chat error");
      }
      yield token;
      count++;
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
}
