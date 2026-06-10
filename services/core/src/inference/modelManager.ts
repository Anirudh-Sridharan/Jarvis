/**
 * ModelManager (feature 1): load/unload state machine for the LOCAL chat model.
 *
 * State machine (deterministic):
 *   unloaded -> loading -> ready -> generating -> (ready) -> unloaded
 *                       \-> error
 *
 * Invariants:
 *  - Concurrent ensureReady() callers await ONE shared load promise; never spawn
 *    two sidecars for one model.
 *  - The idle timer only arms from `ready` with no in-flight requests; it can
 *    never fire mid-generation.
 *  - Only the chat model auto-unloads on idle. Embedding/reranker + HF have no
 *    local lifecycle here.
 *
 * Lifecycle is driven through the MLX provider's /load, /unload, /health calls.
 * The sidecar process itself is supervised externally (sidecar/mlx/run.sh);
 * if /load fails (sidecar down or OOM) the manager moves to `error` and the
 * caller falls back to HF.
 */
import type { LifecycleConfig } from "../config.js";
import type { EventBus } from "./events.js";
import type { MlxProvider } from "./providers/mlxProvider.js";
import type { RamProbe } from "./ram.js";
import type { ModelState, Target } from "./types.js";

export class ModelManager {
  private state: ModelState = "unloaded";
  private loadPromise: Promise<void> | null = null; // shared in-flight load
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private active = 0; // in-flight request count
  private currentModelId = "";
  private fallbackActive = false;

  constructor(
    private readonly mlx: MlxProvider,
    private readonly events: EventBus,
    private readonly ram: RamProbe,
    private readonly cfg: LifecycleConfig,
  ) {}

  getState(): ModelState {
    return this.state;
  }

  getCurrentModelId(): string {
    return this.currentModelId;
  }

  isFallbackActive(): boolean {
    return this.fallbackActive;
  }

  setFallbackActive(v: boolean): void {
    this.fallbackActive = v;
  }

  /**
   * Drive the local model to `ready`. Resolves when ready; rejects (state ->
   * error) when the load fails so the caller can fall back to HF.
   */
  async ensureReady(modelId: string, modelRef: string): Promise<void> {
    this.currentModelId = modelId;

    if (this.state === "ready" || this.state === "generating") return;

    // collapse concurrent callers onto ONE load — never spawn two sidecars
    if (this.state === "loading" && this.loadPromise) return this.loadPromise;

    this.setState("loading"); // UI shows "waking up…"

    this.loadPromise = this.mlx
      .load(modelRef)
      .then(() => {
        this.setState("ready");
        // A load with no request behind it (e.g. POST /warmup) must still
        // honor the ~10-min idle-unload invariant — endRequest() will never
        // run, so arm the timer here. beginRequest() clears it immediately
        // when a real request follows.
        if (this.active === 0) this.armIdle();
      })
      .catch((err: unknown) => {
        this.setState("error"); // caller falls back to HF for this request
        throw err;
      })
      .finally(() => {
        this.loadPromise = null;
      });

    return this.loadPromise;
  }

  /** Mark a request in-flight: clears idle timer, enters `generating`. */
  beginRequest(): void {
    this.active++;
    this.clearIdle();
    if (this.state === "ready") this.setState("generating");
  }

  /** Mark a request finished: on the last one, re-arm idle + return to `ready`. */
  endRequest(): void {
    if (this.active > 0) this.active--;
    if (this.active === 0 && this.state === "generating") {
      this.setState("ready");
      this.armIdle();
    }
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      // never fires mid-generation: guarded by active === 0 && state === ready
      if (this.active === 0 && this.state === "ready") {
        void this.unload();
      }
    }, this.cfg.idleMs);
    // Don't keep the event loop alive solely for the idle timer.
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Manual or idle-triggered unload. Deferred if a request is in-flight. */
  async unload(): Promise<void> {
    this.clearIdle();
    if (this.active > 0) {
      // Manual override during generation: defer; endRequest() re-arms idle.
      return;
    }
    try {
      await this.mlx.unload();
    } catch {
      // Even if the sidecar /unload errors, we consider the model gone locally.
    }
    this.setState("unloaded");
  }

  /** Manual "Load now" lifecycle override. */
  async forceLoad(modelId: string, modelRef: string): Promise<void> {
    if (this.state === "ready" || this.state === "loading") return;
    return this.ensureReady(modelId, modelRef);
  }

  private setState(s: ModelState): void {
    this.state = s;
    this.events.emit({
      modelId: this.currentModelId,
      state: s,
      target: "local" as Target,
      ramHeadroomGB: this.ram.headroomGB(),
      fallbackActive: this.fallbackActive,
      ts: Date.now(),
    });
  }
}
