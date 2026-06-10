/**
 * GatewayEmbedder — implements @jarvis/memory's Embedder interface by calling
 * the MLX sidecar's POST /v1/embeddings endpoint via MlxProvider.embed().
 *
 * The embedding model ref is resolved from the registry (kind="embedding").
 * If no embedding entry is configured or the sidecar is unavailable, throws a
 * clear error so callers can catch and degrade gracefully.
 */

import type { Embedder } from "@jarvis/memory";
import type { MlxProvider } from "../inference/providers/mlxProvider.js";
import type { Registry } from "../inference/registry.js";

export class GatewayEmbedder implements Embedder {
  private readonly modelRef: string;

  constructor(
    private readonly mlx: MlxProvider,
    registry: Registry,
  ) {
    // Resolve the embedding model from the registry.  Throws (config error)
    // if no "embedding" entry is present — the operator must add one.
    const entry = registry.getByKind("embedding")[0];
    if (!entry) {
      throw new Error(
        "GatewayEmbedder: no 'embedding' model entry found in config/models.yaml. " +
          "Add an entry with kind: embedding and provider: mlx.",
      );
    }
    this.modelRef = entry.modelRef;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.mlx.embed(this.modelRef, texts);
  }
}
