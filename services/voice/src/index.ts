/**
 * @jarvis/voice — public API
 *
 * Exports:
 *   - createVoiceOrchestrator(deps, config?) → VoiceOrchestrator
 *   - All interface types
 *   - SessionMachine (for UI state display)
 *   - SentenceChunker utility
 *   - BargeInPolicy
 *   - TurnLatencyTracker + computeLatency
 *   - DefaultTurnDetector
 */

// Interfaces (the injected boundary)
export type {
  WakeWordSource,
  WakeEvent,
  SttEngine,
  SttEvent,
  TurnDetector,
  TurnDetectorConfig,
  TurnDetectorInput,
  TurnDetectorOutput,
  TtsEngine,
  CoreClient,
  WarmupResult,
  VoiceTurn,
  TurnTimings,
} from "./interfaces.js";

// Core orchestration
export {
  createVoiceOrchestrator,
  VoiceOrchestrator,
} from "./voiceOrchestrator.js";
export type {
  OrchestratorConfig,
  OrchestratorDeps,
  OrchestratorEvent,
} from "./voiceOrchestrator.js";

// State machine
export { SessionMachine } from "./sessionMachine.js";
export type {
  VoiceSessionState,
  TransitionEvent,
  StateTransition,
} from "./sessionMachine.js";

// Sentence chunker
export { chunkSentences, collectSentences } from "./sentenceChunker.js";
export type { ChunkerConfig } from "./sentenceChunker.js";

// Echo filter (self-echo transcript detection for confirmed barge-in)
export { speechTokens, isLikelyEcho } from "./echoFilter.js";

// Barge-in
export { BargeInPolicy } from "./bargeIn.js";
export type {
  BargeInConfig,
  BargeInHooks,
  BargeInDecision,
} from "./bargeIn.js";

// Latency accounting
export { TurnLatencyTracker, computeLatency } from "./latency.js";
export type { TurnLatency, BudgetThresholds } from "./latency.js";

// Turn detector
export { DefaultTurnDetector } from "./turnDetector.js";
