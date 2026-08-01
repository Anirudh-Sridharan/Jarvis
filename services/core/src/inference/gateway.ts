/**
 * InferenceGateway (feature 1): the single entry point all callers use.
 *
 * chat(req):
 *   1. normalize -> JarvisInferenceRequest (defaults: stream=true)
 *   2. Router.resolve() -> RoutingDecision {target, modelId, reason}
 *   3. local: ModelManager.ensureReady(); on load failure fall back to the
 *      task hint's configured cloud provider once
 *   4. dispatch to the chosen provider, stream content deltas
 *   5. on local runtime error mid-generation BEFORE first token, retry once on
 *      the task hint's configured cloud provider (oom-fallback); idle timer
 *      reset on completion
 *   6. on a cloud runtime error BEFORE first token, retry on the local model
 *      once (cloud-unavailable fallback: depleted credits/402, network, 5xx)
 *
 * Emits a unified InferenceStreamChunk stream (status/token/done/error).
 */
import type { AppConfig } from "../config.js";
import { EventBus } from "./events.js";
import {
  ANTHROPIC_BASE_URL,
  FIREWORKS_BASE_URL,
  OpenAiCompatProvider,
} from "./providers/openAiCompatProvider.js";
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
  private readonly fireworks: OpenAiCompatProvider;
  private readonly anthropic: OpenAiCompatProvider;

  constructor(private readonly cfg: AppConfig) {
    this.registry = new Registry(cfg.registry);
    this.ram = new OsRamProbe();
    this.events = new EventBus();
    this.mlx = new MlxProvider(cfg.env.mlxSidecarUrl);
    this.router = new Router(this.registry, this.ram, cfg.routing);
    this.modelManager = new ModelManager(this.mlx, this.events, this.ram, cfg.lifecycle);

    // Cloud providers are constructed lazily-ish: endpoint may be empty if
    // unconfigured, in which case the built-in base URL is used. Note the
    // `||` chain (NOT `??`) — an `endpointUrl: ${FIREWORKS_ENDPOINT_URL}`
    // interpolation in models.yaml expands to an EMPTY STRING when the var is
    // unset, and `??` would not skip an empty string.
    const fireworksEntry = cfg.registry.find((e) => e.provider === "fireworks");
    const fireworksEndpoint =
      cfg.env.fireworksEndpointUrl || fireworksEntry?.endpointUrl || FIREWORKS_BASE_URL;
    this.fireworks = new OpenAiCompatProvider({
      endpointUrl: fireworksEndpoint,
      apiKey: cfg.env.fireworksApiKey,
      label: "fireworks",
    });

    const anthropicEntry = cfg.registry.find((e) => e.provider === "anthropic");
    const anthropicEndpoint =
      cfg.env.anthropicEndpointUrl || anthropicEntry?.endpointUrl || ANTHROPIC_BASE_URL;
    this.anthropic = new OpenAiCompatProvider({
      endpointUrl: anthropicEndpoint,
      apiKey: cfg.env.anthropicApiKey,
      defaultMaxTokens: 8192,
      label: "anthropic",
    });
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
    switch (target) {
      case "local":
        return this.mlx;
      case "fireworks":
        return this.fireworks;
      case "anthropic":
        return this.anthropic;
    }
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
        // WR-02: an explicit local pin is a privacy/cost contract — never
        // silently ship a forceTarget:"local" request to a cloud provider.
        // Fail loudly instead.
        if (req.forceTarget === "local") {
          yield {
            type: "error",
            message: `Local model failed to load and forceTarget="local" forbids cloud fallback: ${errMsg(err)}`,
          };
          return;
        }
        // Load failure -> fall back to the task hint's configured cloud
        // provider for this request (local-unavailable-fallback).
        const cloudTarget = this.router.cloudTargetFor(req.taskHint);
        const cloudEntry = this.tryDefault(cloudTarget);
        if (!cloudEntry) {
          yield {
            type: "error",
            message: `Local model failed to load and no ${cloudTarget} fallback is configured: ${errMsg(err)}`,
          };
          return;
        }
        target = cloudTarget;
        modelId = cloudEntry.id;
        entry = cloudEntry;
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
      // Runtime failure on the LOCAL path BEFORE any token -> retry once on
      // the task hint's configured cloud provider (oom-fallback). After
      // tokens have flown we cannot cleanly restart. forceTarget:"local"
      // requests are exempt (WR-02): an explicit local pin must never be
      // silently shipped to a cloud provider — they fall through to the
      // structured error below instead.
      if (
        target === "local" &&
        !firstTokenSeen &&
        !signal?.aborted &&
        req.forceTarget !== "local"
      ) {
        const cloudTarget = this.router.cloudTargetFor(req.taskHint);
        const cloudEntry = this.tryDefault(cloudTarget);
        if (cloudEntry) {
          // Close out the local request bookkeeping before retrying on cloud.
          this.modelManager.endRequest();
          localRequestOpen = false;
          this.modelManager.setFallbackActive(true);
          yield { type: "status", state: "error" };
          try {
            for await (const text of this.providerFor(cloudTarget).streamChat({
              modelRef: cloudEntry.modelRef,
              messages: req.messages,
              tools: req.tools,
              maxTokens: req.maxTokens,
              signal,
            })) {
              timer.recordToken();
              yield { type: "token", text };
            }
            timer.finish({ modelId: cloudEntry.id, target: cloudTarget, fallbackActive: true });
            yield { type: "done" };
            return;
          } catch (cloudErr) {
            yield {
              type: "error",
              message: `Cloud fallback (${cloudTarget}) failed: ${errMsg(cloudErr)}`,
            };
            return;
          }
        }
      }
      // Runtime failure on a CLOUD path BEFORE any token -> retry once
      // locally (cloud-unavailable fallback: depleted credits (402), network
      // down, 5xx). The local 4B model is weaker, but a degraded answer beats
      // a dead turn; telemetry records fallbackActive so the quality drop is
      // visible. `!== "local"` (not an explicit cloud-target list) so a
      // future fourth target needs no edit here.
      //
      // EXCEPTION — cloud-PINNED requests must fail loudly instead (CR-01):
      // consolidation output is PERSISTED into the permanent memory graph, so
      // silently substituting the local 4B's extraction would write degraded
      // facts as if the heavy lane produced them. Failing with a structured
      // error hands the failure to the consolidation pipeline's existing
      // retry/backoff/dead-letter machinery (GatewayLlm throws on error
      // chunks). Interactive chat/voice/agent turns keep the graceful local
      // fallback — there a degraded answer really does beat a dead turn.
      //
      // Also pinned (WR-01): a prompt whose estimate exceeds localCtxSafe
      // physically cannot fit the local ctxWindow — a local retry could only
      // hard-error after a wasted model load or silently truncate the prompt.
      // Deliberately keyed on estPromptTokens (not reason === "token-overflow"):
      // the agent latency-budget escalation reuses that reason with SMALL
      // prompts, and those retain a viable local fallback.
      const promptExceedsLocal = decision.estPromptTokens > this.cfg.routing.localCtxSafe;
      const cloudPinned = req.taskHint === "consolidation" || promptExceedsLocal;
      if (target !== "local" && !firstTokenSeen && !signal?.aborted && cloudPinned) {
        const pinReason = promptExceedsLocal
          ? `the prompt (~${decision.estPromptTokens} tokens) exceeds the local context ceiling`
          : `${req.taskHint} is cloud-pinned (local fallback would persist degraded output)`;
        yield {
          type: "error",
          message: `${target} failed and ${pinReason}: ${errMsg(err)}`,
        };
        return;
      }
      if (target !== "local" && !firstTokenSeen && !signal?.aborted) {
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
              message: `${target} failed (${errMsg(err)}); local fallback also failed: ${errMsg(localErr)}`,
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
