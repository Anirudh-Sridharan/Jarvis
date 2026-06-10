/**
 * Inference core types (feature 1).
 *
 * These are defined LOCALLY in @jarvis/core. There is no @jarvis/shared package
 * yet — when one is extracted (TODO(phase2+)), these schemas move there.
 */

export type Target = "local" | "hf";

export type TaskHint =
  | "voice"
  | "chat"
  | "agent"
  | "reasoning"
  | "consolidation"
  | "embedding"
  | "rerank";

export type ModelKind = "chat" | "embedding" | "reranker";

export type ModelState =
  | "unloaded"
  | "loading"
  | "ready"
  | "generating"
  | "error";

export type Provider = "mlx" | "hf" | "lmstudio";

export type Quant = "4bit" | "8bit" | "fp16";

/** OpenAI-compatible chat message. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

/** Minimal OpenAI-style tool spec (consumed in full by feature 16). */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface RegistryEntry {
  id: string; // e.g. "qwen-local-chat"
  kind: ModelKind;
  provider: Provider;
  modelRef: string; // mlx repo id or HF endpoint model name
  quant?: Quant;
  ctxWindow: number;
  approxRamGB?: number; // local memory budget hint
  endpointUrl?: string; // hf only
  default?: boolean; // default for its kind
}

export interface JarvisInferenceRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  stream: boolean; // default true
  taskHint: TaskHint;
  maxTokens?: number;
  forceTarget?: Target; // escape hatch / tests
}

export type RoutingReason =
  | "task-cloud"
  | "task-local"
  | "token-overflow"
  | "forced"
  | "local-unavailable-fallback"
  | "oom-fallback";

export interface RoutingDecision {
  target: Target;
  modelId: string;
  reason: RoutingReason;
  estPromptTokens: number;
}

export interface ModelStatusEvent {
  modelId: string;
  state: ModelState;
  target: Target;
  ramHeadroomGB: number;
  fallbackActive: boolean;
  ts: number;
}

/** A single streamed unit re-emitted by the gateway to callers. */
export type InferenceStreamChunk =
  | { type: "status"; state: ModelState }
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Provider-facing options for a single dispatch. */
export interface DispatchOptions {
  modelRef: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * A provider streams OpenAI-style content deltas as plain text fragments.
 * The gateway wraps these in InferenceStreamChunk { type: "token" }.
 */
export interface ChatProvider {
  /** Stream text deltas for a chat completion. */
  streamChat(opts: DispatchOptions): AsyncGenerator<string, void, unknown>;
}
