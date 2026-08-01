/**
 * Model registry (feature 1): holds registry entries, resolves defaults per kind,
 * and maps a routing target to a concrete entry.
 */
import type { ModelKind, RegistryEntry, Target } from "./types.js";

export class Registry {
  private readonly entries: RegistryEntry[];

  constructor(entries: RegistryEntry[]) {
    this.entries = entries;
  }

  all(): readonly RegistryEntry[] {
    return this.entries;
  }

  getById(id: string): RegistryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  getByKind(kind: ModelKind): RegistryEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /** Provider that backs a given routing target. */
  private static providerForTarget(target: Target): RegistryEntry["provider"][] {
    // 'local' is served by mlx (or lmstudio in dev); each cloud target is
    // served by its own same-named provider (fireworks/anthropic).
    switch (target) {
      case "local":
        return ["mlx", "lmstudio"];
      case "fireworks":
        return ["fireworks"];
      case "anthropic":
        return ["anthropic"];
      default:
        // Runtime guard (WR-03): normalize() performs no runtime validation,
        // so a stale forceTarget (e.g. the deleted "hf") can reach here at
        // runtime despite the exhaustive compile-time switch. Name the bad
        // target instead of surfacing an opaque TypeError downstream.
        throw new Error(
          `Unknown routing target "${String(target)}" — valid targets: local, fireworks, anthropic.`,
        );
    }
  }

  /**
   * Default registry entry for a (kind, target). Prefers an entry flagged
   * `default: true`; otherwise the first matching entry. Throws if none match —
   * a misconfiguration the operator must fix.
   */
  defaultFor(kind: ModelKind, target: Target): RegistryEntry {
    const providers = Registry.providerForTarget(target);
    const candidates = this.entries.filter(
      (e) => e.kind === kind && providers.includes(e.provider),
    );
    if (candidates.length === 0) {
      throw new Error(
        `No registry entry for kind="${kind}" target="${target}". Check config/models.yaml.`,
      );
    }
    const flagged = candidates.find((e) => e.default);
    // candidates is non-empty (guarded above); index 0 is safe.
    return flagged ?? (candidates[0] as RegistryEntry);
  }
}
