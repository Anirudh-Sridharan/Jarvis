/**
 * buildVoiceDeps — the one place that wires the real (live) voice pipeline
 * dependencies for @jarvis/voice. Used by both the PTT CLI (cli/voice.ts) and
 * the dashboard voice session (voiceSessionManager.ts) so mic/TTS/core wiring
 * and turn tuning can't drift between the two entry points.
 */
import type { OrchestratorConfig, OrchestratorDeps } from "@jarvis/voice";
import { SidecarSttEngine } from "./sidecarStt.js";
import { SidecarTtsEngine } from "./sidecarTts.js";
import { CoreHttpClient } from "./coreVoiceClient.js";

export interface VoiceDepsOptions {
  coreUrl: string;
  sidecarUrl: string;
}

/** Everything the orchestrator needs except the wake source (entry-point specific). */
export function buildVoiceDeps(opts: VoiceDepsOptions): Omit<OrchestratorDeps, "wakeWord"> {
  return {
    stt: new SidecarSttEngine({
      sidecarUrl: opts.sidecarUrl,
      micDevice: process.env["JARVIS_MIC"] ?? ":default",
    }),
    tts: new SidecarTtsEngine({
      sidecarUrl: opts.sidecarUrl,
      voice: process.env["JARVIS_TTS_VOICE"], // undefined → sidecar default (bm_fable)
    }),
    core: new CoreHttpClient(opts.coreUrl),
  };
}

/**
 * Shared turn tuning: whisper finals arrive after VAD speech_end, so the
 * wall-clock silence timer owns end-of-turn (the sidecar sends silenceMs: 0).
 */
export const VOICE_TURN_CONFIG: OrchestratorConfig = {
  silenceThresholdMs: 900,
  forceEndMs: 2_500,
};

/** Resolve core/sidecar URLs from env exactly like the CLI does. */
export function voiceUrlsFromEnv(): VoiceDepsOptions {
  const corePort = process.env["CORE_PORT"] ?? "8080";
  return {
    coreUrl: process.env["CORE_URL"] ?? `http://127.0.0.1:${corePort}`,
    sidecarUrl: process.env["VOICE_SIDECAR_URL"] ?? "http://127.0.0.1:8089",
  };
}
