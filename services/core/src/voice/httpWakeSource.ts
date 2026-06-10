/**
 * HttpWakeSource — WakeWordSource fed by HTTP callbacks.
 *
 * The Python voice sidecar's openWakeWord listener captures the system mic and
 * POSTs a wake payload to core's /voice/wake endpoint; the handler maps it to a
 * WakeEvent and calls dispatch(). The orchestrator handles it identically to a
 * PTT or in-process detection. Events dispatched while the source is not
 * running (before orchestrator.start(), after stop()) are dropped, so a
 * late-arriving sidecar callback can't trigger a turn on a dead session.
 */
import type { WakeEvent, WakeWordSource } from "@jarvis/voice";

export class HttpWakeSource implements WakeWordSource {
  private listeners: Array<(event: WakeEvent) => void> = [];
  private running = false;

  onWake(listener: (event: WakeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  /** Deliver an externally-built wake event. Returns false (dropped) unless running. */
  dispatch(event: WakeEvent): boolean {
    if (!this.running) return false;
    for (const listener of this.listeners) listener(event);
    return true;
  }
}
