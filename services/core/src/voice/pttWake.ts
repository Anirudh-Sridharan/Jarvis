/**
 * PttWakeSource — push-to-talk WakeWordSource for the voice CLI.
 *
 * No always-on mic, no openWakeWord dependency: the CLI calls trigger() when
 * the user presses Enter, which emits a synthetic WakeEvent (source "ptt",
 * confidence 1.0). The orchestrator handles it identically to a real
 * "Hey Jarvis" detection.
 */

import { randomUUID } from "node:crypto";
import type { WakeEvent, WakeWordSource } from "@jarvis/voice";

export class PttWakeSource implements WakeWordSource {
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

  /** Fire a push-to-talk wake. No-op unless start() has been called. */
  trigger(): void {
    if (!this.running) return;
    const event: WakeEvent = {
      id: randomUUID(),
      source: "ptt",
      phrase: "Hey Jarvis",
      confidence: 1.0,
      timestamp: Date.now(),
      deviceId: "cli",
      warmTriggered: true,
    };
    for (const listener of this.listeners) listener(event);
  }
}
