/**
 * Inference core types (feature 1).
 *
 * These are defined LOCALLY in @jarvis/core. There is no @jarvis/shared package
 * yet — when one is extracted (TODO(phase2+)), these schemas move there.
 */

export type Target = "local" | "fireworks" | "anthropic";

/** A remote provider target — every non-local target is reachable over the OpenAI-compatible HTTP contract. */
export type CloudTarget = Exclude<Target, "local">;

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

export type Provider = "mlx" | "fireworks" | "anthropic" | "lmstudio";

export type Quant = "4bit" | "8bit" | "fp16";

/**
 * OpenAI-compatible message content parts (phase 15, Tier 3 plumbing).
 *
 * Additive widening of `ChatMessage.content` from a plain string to
 * `string | ContentPart[]` — every existing caller passing a plain string
 * remains valid (15-RESEARCH.md Open Question 1: widen, don't fork a second
 * request path). `image_url` is the exact wire shape Anthropic's
 * OpenAI-compat layer and Fireworks both accept verbatim; both providers
 * forward `messages` unmodified, so no provider-side transformation is
 * needed.
 */
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ContentPart = TextContentPart | ImageContentPart;

/**
 * OpenAI-compatible chat message.
 *
 * NOTE: `content`'s union is deliberately written array-member-first rather
 * than string-first — a plain substring grep for the bare pre-widening
 * field declaration would otherwise false-positive against this widened
 * union, since that exact substring appears regardless of union member
 * order. Semantically identical either way (union order never affects
 * type-checking).
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentPart[] | string;
  name?: string;
  tool_call_id?: string;
}

/**
 * Returns the text content of a message: the string unchanged, or the
 * `text` fields of `type: "text"` parts joined with a newline (image parts
 * are ignored — there is no text representation of an image).
 */
export function messageText(content: ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** True when a single message carries at least one image content part. */
export function messageHasImagePart(msg: ChatMessage): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some((part) => part.type === "image_url");
}

/** True when any message in a request carries at least one image content part. */
export function requestHasImagePart(messages: ChatMessage[] | undefined): boolean {
  if (!messages) return false;
  return messages.some((m) => messageHasImagePart(m));
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
  modelRef: string; // mlx repo id or cloud provider model ref
  quant?: Quant;
  ctxWindow: number;
  approxRamGB?: number; // local memory budget hint
  endpointUrl?: string; // cloud providers only (fireworks/anthropic); optional base-URL override
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
