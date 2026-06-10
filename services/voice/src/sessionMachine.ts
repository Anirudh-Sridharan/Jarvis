/**
 * Voice-session state machine (feature 7).
 *
 * States: idle → waking → listening → thinking → speaking → (listening|idle)
 * Any state → error → idle
 *
 * The only backwards edge is barge-in: speaking → listening.
 * All transitions are validated; invalid ones throw (or are ignored in lenient mode).
 *
 * Pure observable: callers subscribe to state changes via onTransition().
 */

export type VoiceSessionState =
  | "idle"
  | "waking"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type TransitionEvent =
  | "WAKE"
  | "MODELS_READY"
  | "SPEECH_START"
  | "TURN_COMPLETE"
  | "FIRST_TOKEN"
  | "FIRST_AUDIO"
  | "REPLY_DONE"
  | "BARGE_IN"
  | "ERROR"
  | "RECOVER"
  | "PTT_PRESS"
  | "FORCE_IDLE";

export interface StateTransition {
  from: VoiceSessionState;
  event: TransitionEvent;
  to: VoiceSessionState;
  ts: number;
}

type TransitionListener = (t: StateTransition) => void;

// Legal transitions. Each row: [from, event, to]
const TRANSITIONS: ReadonlyArray<
  [VoiceSessionState, TransitionEvent, VoiceSessionState]
> = [
  // Wake → warming up models
  ["idle", "WAKE", "waking"],
  // PTT can jump straight to listening from idle (no cold start needed for ptt shortcut)
  ["idle", "PTT_PRESS", "waking"],

  // Models loaded → start capturing
  ["waking", "MODELS_READY", "listening"],
  ["waking", "ERROR", "error"],

  // Listening → user finishes speaking
  ["listening", "TURN_COMPLETE", "thinking"],
  ["listening", "ERROR", "error"],
  // Wake during listening is a no-op re: state, but we allow a FORCE_IDLE
  ["listening", "FORCE_IDLE", "idle"],

  // Thinking → LLM streaming
  ["thinking", "FIRST_TOKEN", "speaking"],
  ["thinking", "REPLY_DONE", "idle"], // empty reply edge
  ["thinking", "ERROR", "error"],
  ["thinking", "BARGE_IN", "listening"], // barge-in during thinking

  // Speaking → barge-in (the key backwards edge)
  ["speaking", "BARGE_IN", "listening"],
  ["speaking", "REPLY_DONE", "idle"],
  ["speaking", "ERROR", "error"],

  // Error recovery
  ["error", "RECOVER", "idle"],
  ["error", "FORCE_IDLE", "idle"],

  // Any state → error (catch-all for unexpected faults)
  ["idle", "ERROR", "error"],

  // Any state force-idle
  ["idle", "FORCE_IDLE", "idle"],
  ["thinking", "FORCE_IDLE", "idle"],
  ["speaking", "FORCE_IDLE", "idle"],
  ["waking", "FORCE_IDLE", "idle"],
];

/** Build a Map<"from:event", to> for O(1) lookup. */
const TRANSITION_MAP = new Map<string, VoiceSessionState>(
  TRANSITIONS.map(([from, event, to]) => [`${from}:${event}`, to]),
);

export class SessionMachine {
  private _state: VoiceSessionState = "idle";
  private _listeners: TransitionListener[] = [];
  private _history: StateTransition[] = [];

  get state(): VoiceSessionState {
    return this._state;
  }

  get history(): ReadonlyArray<StateTransition> {
    return this._history;
  }

  /** Subscribe to transitions. Returns unsubscribe function. */
  onTransition(listener: TransitionListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Attempt a transition given an event.
   * Returns the new state on success; throws if the transition is illegal.
   */
  send(event: TransitionEvent): VoiceSessionState {
    const key = `${this._state}:${event}`;
    const next = TRANSITION_MAP.get(key);
    if (next === undefined) {
      throw new Error(
        `[SessionMachine] Illegal transition: ${this._state} --${event}--> (no target)`,
      );
    }
    const transition: StateTransition = {
      from: this._state,
      event,
      to: next,
      ts: Date.now(),
    };
    this._state = next;
    this._history.push(transition);
    for (const l of this._listeners) {
      try {
        l(transition);
      } catch {
        // listeners must not crash the machine
      }
    }
    return next;
  }

  /**
   * Like send() but returns null instead of throwing on invalid transitions.
   * Useful for event-driven code where some events arrive spuriously.
   */
  trySend(event: TransitionEvent): VoiceSessionState | null {
    try {
      return this.send(event);
    } catch {
      return null;
    }
  }

  /** Check whether an event is valid from the current state. */
  canSend(event: TransitionEvent): boolean {
    return TRANSITION_MAP.has(`${this._state}:${event}`);
  }

  /** Reset to idle (for tests / daemon restart). */
  reset(): void {
    this._state = "idle";
    this._history = [];
  }
}
