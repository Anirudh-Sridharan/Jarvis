/**
 * Tiny in-process event bus for ModelStatusEvents (feature 1).
 *
 * The menu-bar app + dashboard subscribe to these (TODO(phase3): bridge to a
 * WebSocket/SSE status feed). Phase 1 keeps it in-process; /status reads the
 * latest snapshot directly.
 */
import type { ModelStatusEvent } from "./types.js";

type Listener = (e: ModelStatusEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ModelStatusEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a bad listener must not break emission */
      }
    }
  }
}
