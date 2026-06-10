/**
 * InferenceGateway (feature 1): the single entry point all callers use.
 *
 * chat(req):
 *   1. normalize -> JarvisInferenceRequest (defaults: stream=true)
 *   2. Router.resolve() -> RoutingDecision {target, modelId, reason}
 *   3. local: ModelManager.ensureReady(); on load failure fall back to HF once
 *   4. dispatch to the chosen provider, stream content deltas
 *   5. on local runtime error mid-generation BEFORE first token, retry on HF once
 *      (oom-fallback); idle timer reset on completion
 *   6. on HF runtime error BEFORE first token, retry on the local model once
 *      (cloud-unavailable fallback: depleted credits/402, network, 5xx)
 *
 * Emits a unified InferenceStreamChunk stream (status/token/done/error).
 */
import type { AppConfig } from "../config.js";
import { EventBus } from "./events.js";
import { HfProvider } from "./providers/hfProvider.js";
import { MlxProvider } from "./providers/mlxProvider.js";
import { OsRamProbe, type RamProbe } from "./ram.js";
import { Registry } from "./registry.js";
import { Router } from "./router.js";
import { ModelManager } from "./modelManager.js";
import { TurnTimer } from "./telemetry.js";
import type {
  ChatProvider,
  InferenceStreamChunk,
  JarvisInferenceRequest,
  ModelState,
  RegistryEntry,
  Target,
} from "./types.js";

export interface GatewayStatus {
  id: string;
  state: ModelState;
  target: Target;
  ramHeadroomGB: number;
  fallbackActive: boolean;
}

export class InferenceGateway {
  readonly registry: Registry;
  readonly router: Router;
  readonly modelManager: ModelManager;
  readonly events: EventBus;
  /** Exposed so memory adapters (GatewayEmbedder) can call /v1/embeddings. */
  readonly mlx: MlxProvider;
  private readonly ram: RamProbe;
  private readonly hf: HfProvider;

  constructor(private readonly cfg: AppConfig) {
    this.registry = new Registry(cfg.registry);
    this.ram = new OsRamProbe();
    this.events = new EventBus();
    this.mlx = new MlxProvider(cfg.env.mlxSidecarUrl);
    this.router = new Router(this.registry, this.ram, cfg.routing);
    this.modelManager = new ModelManager(this.mlx, this.events, this.ram, cfg.lifecycle);

    // HF provider is constructed lazily-ish: endpoint may be empty if unconfigured.
    const hfEntry = cfg.registry.find((e) => e.provider === "hf");
    const endpoint = cfg.env.hfEndpointUrl ?? hfEntry?.endpointUrl ?? "";
    this.hf = new HfProvider(endpoint, cfg.env.hfToken);
  }

  /** Normalize an incoming request, filling defaults. */
  normalize(req: Partial<JarvisInferenceRequest>): JarvisInferenceRequest {
    return {
      messages: req.messages ?? [],
      tools: req.tools,
      stream: req.stream ?? true,
      taskHint: req.taskHint ?? "chat",
      maxTokens: req.maxTokens,
      forceTarget: req.forceTarget,
    };
  }

  status(): GatewayStatus {
    const chatDefaultLocal = this.tryDefault("local");
    return {
      id: this.modelManager.getCurrentModelId() || chatDefaultLocal?.id || "",
      state: this.modelManager.getState(),
      target: "local",
      ramHeadroomGB: Number(this.ram.headroomGB().toFixed(2)),
      fallbackActive: this.modelManager.isFallbackActive(),
    };
  }

  private tryDefault(target: Target): RegistryEntry | undefined {
    try {
      return this.registry.defaultFor("chat", target);
    } catch {
      return undefined;
    }
  }

  private providerFor(target: Target): ChatProvider {
    return target === "local" ? this.mlx : this.hf;
  }

  /**
   * Run a chat request and yield unified stream chunks. Pure async generator —
   * the HTTP layer turns these into SSE `data:` frames.
   */
  async *chat(
    rawReq: Partial<JarvisInferenceRequest>,
    signal?: AbortSignal,
  ): AsyncGenerator<InferenceStreamChunk, void, unknown> {
    const req = this.normalize(rawReq);
    const decision = this.router.resolve(req);

    let target = decision.target;
    let modelId = decision.modelId;
    let entry = this.registry.getById(modelId);
    if (!entry) {
      yield { type: "error", message: `Unknown model id "${modelId}"` };
      return;
    }

    // --- Lifecycle gate (local only) -----------------------------------------
    if (target === "local") {
      // Only surface "waking up…" when the model actually has to load —
      // emitting it unconditionally makes the CLI print it on every turn.
      const mmState = this.modelManager.getState();
      if (mmState !== "ready" && mmState !== "generating") {
        yield { type: "status", state: "loading" };
      }
      try {
        await this.modelManager.ensureReady(entry.id, entry.modelRef);
        this.modelManager.setFallbackActive(false);
        yield { type: "status", state: "ready" };
      } catch (err) {
        // Load failure -> fall back to HF for this request (local-unavailable-fallback).
        const hfEntry = this.tryDefault("hf");
        if (!hfEntry) {
          yield {
            type: "error",
            message: `Local model failed to load and no HF fallback is configured: ${errMsg(err)}`,
          };
          return;
        }
        target = "hf";
        modelId = hfEntry.id;
        entry = hfEntry;
        this.modelManager.setFallbackActive(true);
        yield { type: "status", state: "error" };
      }
    }

    // --- Dispatch + stream ---------------------------------------------------
    const timer = new TurnTimer();
    let firstTokenSeen = false;
    let localRequestOpen = false;
    const provider = this.providerFor(target);

    if (target === "local") {
      this.modelManager.beginRequest();
      localRequestOpen = true;
    }
    try {
      for await (const text of provider.streamChat({
        modelRef: entry.modelRef,
        messages: req.messages,
        tools: req.tools,
        maxTokens: req.maxTokens,
        signal,
      })) {
        firstTokenSeen = true;
        timer.recordToken();
        yield { type: "token", text };
      }
      timer.finish({ modelId, target, fallbackActive: this.modelManager.isFallbackActive() });
      yield { type: "done" };
    } catch (err) {
      // Runtime failure on the LOCAL path BEFORE any token -> retry once on HF
      // (oom-fallback). After tokens have flown we cannot cleanly restart.
      if (target === "local" && !firstTokenSeen && !signal?.aborted) {
        const hfEntry = this.tryDefault("hf");
        if (hfEntry) {
          // Close out the local request bookkeeping before retrying on HF.
          this.modelManager.endRequest();
          localRequestOpen = false;
          this.modelManager.setFallbackActive(true);
          yield { type: "status", state: "error" };
          try {
            for await (const text of this.hf.streamChat({
              modelRef: hfEntry.modelRef,
              messages: req.messages,
              tools: req.tools,
              maxTokens: req.maxTokens,
              signal,
            })) {
              timer.recordToken();
              yield { type: "token", text };
            }
            timer.finish({ modelId: hfEntry.id, target: "hf", fallbackActive: true });
            yield { type: "done" };
            return;
          } catch (hfErr) {
            yield { type: "error", message: `Cloud fallback failed: ${errMsg(hfErr)}` };
            return;
          }
        }
      }
      // Runtime failure on the HF path BEFORE any token -> retry once locally
      // (cloud-unavailable fallback: depleted credits (402), network down, 5xx).
      // The local 4B model is weaker, but a degraded answer beats a dead turn;
      // telemetry records fallbackActive so the quality drop is visible.
      if (target === "hf" && !firstTokenSeen && !signal?.aborted) {
        const localEntry = this.tryDefault("local");
        if (localEntry) {
          yield { type: "status", state: "error" };
          try {
            const mmState = this.modelManager.getState();
            if (mmState !== "ready" && mmState !== "generating") {
              yield { type: "status", state: "loading" };
            }
            await this.modelManager.ensureReady(localEntry.id, localEntry.modelRef);
            this.modelManager.beginRequest();
            localRequestOpen = true;
            this.modelManager.setFallbackActive(true);
            yield { type: "status", state: "ready" };
            for await (const text of this.mlx.streamChat({
              modelRef: localEntry.modelRef,
              messages: req.messages,
              tools: req.tools,
              maxTokens: req.maxTokens,
              signal,
            })) {
              timer.recordToken();
              yield { type: "token", text };
            }
            timer.finish({ modelId: localEntry.id, target: "local", fallbackActive: true });
            yield { type: "done" };
            return;
          } catch (localErr) {
            yield {
              type: "error",
              message: `HF failed (${errMsg(err)}); local fallback also failed: ${errMsg(localErr)}`,
            };
            return;
          }
        }
      }
      yield { type: "error", message: errMsg(err) };
    } finally {
      if (localRequestOpen) this.modelManager.endRequest();
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
