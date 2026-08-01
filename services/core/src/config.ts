/**
 * Config loader (feature 1): reads config/models.yaml + environment, zod-validated.
 *
 * The models.yaml lives at the repo root under config/. We resolve it relative to
 * this file so it works whether run via tsx (src/) or compiled (dist/).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CloudTarget, RegistryEntry } from "./inference/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Expand ${VAR} references in yaml string values from process.env. */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    return process.env[name] ?? "";
  });
}

const modelEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["chat", "embedding", "reranker"]),
  provider: z.enum(["mlx", "fireworks", "anthropic", "lmstudio"]),
  modelRef: z.string().min(1),
  quant: z.enum(["4bit", "8bit", "fp16"]).optional(),
  // ctxWindow is meaningful for chat models. Embedding/reranker entries in
  // config/models.yaml omit it, so default it rather than rejecting the config.
  ctxWindow: z.number().int().positive().optional().default(8192),
  approxRamGB: z.number().positive().optional(),
  endpointUrl: z
    .string()
    .optional()
    .transform((v) => (v ? expandEnv(v) : v)),
  default: z.boolean().optional(),
});

const routingSchema = z.object({
  agentLocalTokenCap: z.number().int().positive().default(12_000),
  // Must fit the LOCAL model's ctxWindow (16384) minus reply headroom —
  // a ceiling above the context can never fire before overflow.
  localCtxSafe: z.number().int().positive().default(14_000),
  /** RAM floor (GB): below this a local pick is downgraded to cloud. 0 disables the guard. */
  ramFloorGB: z.number().nonnegative().default(2),
  /**
   * Heuristic latency budget knob for agent loops. When an agent request is
   * expected to exceed this, the router escalates to cloud.
   * TODO(phase4: feature 16) refine with real loop-latency telemetry.
   */
  agentLatencyBudgetMs: z.number().int().positive().default(8_000),
  /**
   * Config-driven per-task-class cloud provider (D-04): which cloud provider
   * serves each task hint that escalates to cloud. Rebalance here as credits
   * deplete or providers change — zero code change.
   */
  cloudTaskProviders: z
    .object({
      consolidation: z.enum(["fireworks", "anthropic"]).default("fireworks"),
      reasoning: z.enum(["fireworks", "anthropic"]).default("anthropic"),
      agent: z.enum(["fireworks", "anthropic"]).default("anthropic"),
    })
    .default({}),
  /**
   * Fallback cloud target for token-overflow / RAM-guard escalation on task
   * hints with no explicit entry in cloudTaskProviders above (RESEARCH.md
   * Pitfall 2 / Assumptions Log A1).
   */
  defaultCloudProvider: z.enum(["fireworks", "anthropic"]).default("fireworks"),
  /**
   * When true, the `agent` task class runs on its configured cloud provider
   * BY DEFAULT rather than local-first-with-escalation (D-04: agent is
   * quality-critical). When false, restores the previous local-first
   * behavior with escalation on token/latency budget. Defaults to true —
   * a deliberate, documented, user-facing cost/behavior change (RESEARCH.md
   * Assumptions Log A5): every agent run now spends cloud credits by default.
   */
  agentPreferCloud: z.boolean().default(true),
});

const modelsFileSchema = z.object({
  idleTimeoutSeconds: z.number().int().positive().default(600),
  routing: routingSchema.default({}),
  models: z.array(modelEntrySchema).min(1),
});

export interface RoutingConfig {
  agentLocalTokenCap: number;
  localCtxSafe: number;
  ramFloorGB: number;
  agentLatencyBudgetMs: number;
  cloudTaskProviders: Record<"consolidation" | "reasoning" | "agent", CloudTarget>;
  defaultCloudProvider: CloudTarget;
  agentPreferCloud: boolean;
}

export interface LifecycleConfig {
  idleMs: number;
  /** Kill the sidecar process on unload (reclaim full RAM) vs park it. */
  killOnUnload: boolean;
}

export interface EnvConfig {
  corePort: number;
  mlxSidecarUrl: string;
  fireworksApiKey: string | undefined;
  fireworksEndpointUrl: string | undefined;
  anthropicApiKey: string | undefined;
  anthropicEndpointUrl: string | undefined;
}

export interface AppConfig {
  registry: RegistryEntry[];
  routing: RoutingConfig;
  lifecycle: LifecycleConfig;
  env: EnvConfig;
}

const envSchema = z.object({
  CORE_PORT: z.coerce.number().int().positive().default(8080),
  MLX_SIDECAR_URL: z.string().url().default("http://127.0.0.1:8088"),
  FIREWORKS_API_KEY: z.string().optional(),
  FIREWORKS_ENDPOINT_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_ENDPOINT_URL: z.string().optional(),
});

/**
 * Resolve config/models.yaml. Walks up from this file to the repo root.
 * src/config.ts -> services/core -> services -> <root>/config/models.yaml
 */
function resolveModelsYamlPath(): string {
  const fromEnv = process.env["JARVIS_MODELS_CONFIG"];
  if (fromEnv) return fromEnv;
  return resolve(__dirname, "..", "..", "..", "config", "models.yaml");
}

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);

  const yamlPath = resolveModelsYamlPath();
  const raw = readFileSync(yamlPath, "utf8");
  const parsed = modelsFileSchema.parse(parseYaml(raw));

  const routing: RoutingConfig = {
    agentLocalTokenCap: parsed.routing.agentLocalTokenCap,
    localCtxSafe: parsed.routing.localCtxSafe,
    ramFloorGB: parsed.routing.ramFloorGB,
    agentLatencyBudgetMs: parsed.routing.agentLatencyBudgetMs,
    cloudTaskProviders: parsed.routing.cloudTaskProviders,
    defaultCloudProvider: parsed.routing.defaultCloudProvider,
    agentPreferCloud: parsed.routing.agentPreferCloud,
  };

  const lifecycle: LifecycleConfig = {
    idleMs: parsed.idleTimeoutSeconds * 1_000,
    killOnUnload: true,
  };

  return {
    registry: parsed.models,
    routing,
    lifecycle,
    env: {
      corePort: env.CORE_PORT,
      mlxSidecarUrl: env.MLX_SIDECAR_URL,
      fireworksApiKey: env.FIREWORKS_API_KEY || undefined,
      fireworksEndpointUrl: env.FIREWORKS_ENDPOINT_URL || undefined,
      anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
      anthropicEndpointUrl: env.ANTHROPIC_ENDPOINT_URL || undefined,
    },
  };
}
