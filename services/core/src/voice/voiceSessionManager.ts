/**
 * VoiceSessionManager — hosts the dashboard's hands-free voice session in core.
 *
 * Lifecycle: start() health-checks the voice sidecar, enables its openWakeWord
 * listener (system mic), and starts a VoiceOrchestrator wired with an
 * HttpWakeSource. The sidecar POSTs wake detections to core's /voice/wake,
 * which calls dispatchWake(). Orchestrator events are buffered (ring buffer,
 * for SSE replay after a tab reload) and broadcast to live subscribers.
 *
 * The orchestrator factory is injected so tests run against @jarvis/voice
 * fakes — no network, no audio processes.
 */
import type { OrchestratorEvent, VoiceOrchestrator, WakeEvent } from "@jarvis/voice";
import { HttpWakeSource } from "./httpWakeSource.js";

export interface VoiceSessionStatus {
  active: boolean;
  /** Orchestrator session state, or "inactive" when no session is running. */
  state: string;
  lastWakeAt: number | null;
}

export interface VoiceEventFrame {
  seq: number;
  ts: number;
  event: OrchestratorEvent;
}

export type VoiceStartResult =
  | { ok: true; status: VoiceSessionStatus }
  | { ok: false; error: string; status: VoiceSessionStatus };

export interface VoiceSessionOptions {
  sidecarUrl: string;
  orchestratorFactory: (wakeSource: HttpWakeSource) => VoiceOrchestrator;
  fetchImpl?: typeof fetch;
  /** Ring buffer size for SSE replay. Default 200. */
  bufferSize?: number;
}

export class VoiceSessionManager {
  private readonly sidecarUrl: string;
  private readonly orchestratorFactory: (wakeSource: HttpWakeSource) => VoiceOrchestrator;
  private readonly fetchImpl: typeof fetch;
  private readonly bufferSize: number;

  private readonly wakeSource = new HttpWakeSource();
  private orchestrator: VoiceOrchestrator | null = null;
  private unsubscribeOrchestrator: (() => void) | null = null;
  private frames: VoiceEventFrame[] = [];
  private seq = 0;
  private lastWakeAt: number | null = null;
  private readonly listeners = new Set<(frame: VoiceEventFrame) => void>();

  constructor(opts: VoiceSessionOptions) {
    this.sidecarUrl = opts.sidecarUrl.replace(/\/$/, "");
    this.orchestratorFactory = opts.orchestratorFactory;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.bufferSize = opts.bufferSize ?? 200;
  }

  /** Idempotent: starting an active session returns current status. */
  async start(): Promise<VoiceStartResult> {
    if (this.orchestrator) return { ok: true, status: this.status() };

    try {
      const res = await this.fetchImpl(`${this.sidecarUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      return {
        ok: false,
        error: `Voice sidecar unreachable at ${this.sidecarUrl} — start it with: npm run sidecar:voice`,
        status: this.status(),
      };
    }

    try {
      const res = await this.fetchImpl(`${this.sidecarUrl}/wake/enable`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      return {
        ok: false,
        error: `Could not enable the wake-word listener: ${err instanceof Error ? err.message : String(err)}`,
        status: this.status(),
      };
    }

    const orchestrator = this.orchestratorFactory(this.wakeSource);
    this.unsubscribeOrchestrator = orchestrator.on((event) => this.push(event));
    orchestrator.start(); // starts the wake source (arms dispatch)
    this.orchestrator = orchestrator;
    return { ok: true, status: this.status() };
  }

  /** Disable sidecar wake listener (best effort) and stop the orchestrator. */
  async stop(): Promise<VoiceSessionStatus> {
    const orchestrator = this.orchestrator;
    if (!orchestrator) return this.status();
    this.orchestrator = null; // reject dispatchWake immediately
    this.unsubscribeOrchestrator?.();
    this.unsubscribeOrchestrator = null;
    try {
      await this.fetchImpl(`${this.sidecarUrl}/wake/disable`, {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Best effort — the sidecar may already be down.
    }
    await orchestrator.stop(); // cancels in-flight TTS/LLM, disarms wake source
    return this.status();
  }

  /** Deliver a wake event from the sidecar. Returns false if no active session. */
  dispatchWake(event: WakeEvent): boolean {
    if (!this.orchestrator) return false;
    this.lastWakeAt = Date.now();
    return this.wakeSource.dispatch(event);
  }

  status(): VoiceSessionStatus {
    return {
      active: this.orchestrator !== null,
      state: this.orchestrator?.state ?? "inactive",
      lastWakeAt: this.lastWakeAt,
    };
  }

  /** Live event feed. Returns an unsubscribe function. */
  subscribe(listener: (frame: VoiceEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Buffered frames (oldest first) for SSE replay on (re)connect. */
  recentEvents(): VoiceEventFrame[] {
    return [...this.frames];
  }

  private push(event: OrchestratorEvent): void {
    const frame: VoiceEventFrame = { seq: ++this.seq, ts: Date.now(), event };
    this.frames.push(frame);
    if (this.frames.length > this.bufferSize) {
      this.frames.splice(0, this.frames.length - this.bufferSize);
    }
    for (const listener of this.listeners) listener(frame);
  }
}

// ── Module singleton (same pattern as agentSystem.ts) ────────────────────────
// Server endpoints resolve the manager per request; tests inject a fake-built
// one with setVoiceSessionManager() before/after importing server.ts.

let singleton: VoiceSessionManager | null = null;

export function setVoiceSessionManager(manager: VoiceSessionManager | null): void {
  singleton = manager;
}

/** Get the singleton, lazily creating it via `factory` if provided. */
export function getVoiceSessionManager(
  factory?: () => VoiceSessionManager,
): VoiceSessionManager | null {
  if (!singleton && factory) singleton = factory();
  return singleton;
}

export function resetVoiceSessionManager(): void {
  singleton = null;
}
