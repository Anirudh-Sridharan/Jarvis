/**
 * buildVoiceDeps — the one place that wires the real (live) voice pipeline
 * dependencies for @jarvis/voice. Used by both the PTT CLI (cli/voice.ts) and
 * the dashboard voice session (voiceSessionManager.ts) so mic/TTS/core wiring
 * and turn tuning can't drift between the two entry points.
 */
import type { CoreClient, OrchestratorConfig, OrchestratorDeps } from "@jarvis/voice";
import { createVoiceOrchestrator } from "@jarvis/voice";
import { SidecarSttEngine } from "./sidecarStt.js";
import { SidecarTtsEngine } from "./sidecarTts.js";
import { CoreHttpClient } from "./coreVoiceClient.js";
import { VoiceSessionManager } from "./voiceSessionManager.js";
import type { HttpWakeSource } from "./httpWakeSource.js";

export interface VoiceDepsOptions {
  coreUrl: string;
  sidecarUrl: string;
}

/**
 * Wrap a CoreClient so warmup() also fires the voice sidecar's /warmup in
 * parallel (loads + JIT-warms whisper/Kokoro). Sidecar warmup is best-effort:
 * its failure must never block the wake path — core's warmup result wins.
 */
export function withSidecarWarmup(
  core: CoreClient,
  sidecarUrl: string,
  fetchImpl: typeof fetch = fetch,
): CoreClient {
  return {
    warmup: async () => {
      const sidecar = fetchImpl(`${sidecarUrl}/warmup`, { method: "POST" }).catch(
        () => undefined,
      );
      const result = await core.warmup();
      await sidecar;
      return result;
    },
    chatStream: (message, conversationId, signal) =>
      core.chatStream(message, conversationId, signal),
  };
}

/** Everything the orchestrator needs except the wake source (entry-point specific). */
export function buildVoiceDeps(
  opts: VoiceDepsOptions,
  fetchImpl: typeof fetch = fetch,
): Omit<OrchestratorDeps, "wakeWord"> {
  return {
    stt: new SidecarSttEngine({
      sidecarUrl: opts.sidecarUrl,
      micDevice: process.env["JARVIS_MIC"] ?? ":default",
    }),
    tts: new SidecarTtsEngine({
      sidecarUrl: opts.sidecarUrl,
      voice: process.env["JARVIS_TTS_VOICE"], // undefined → sidecar default (British blend)
      speed: process.env["JARVIS_TTS_SPEED"]
        ? Number(process.env["JARVIS_TTS_SPEED"])
        : undefined, // undefined → engine default 0.95
    }),
    core: withSidecarWarmup(
      new CoreHttpClient(opts.coreUrl, fetchImpl),
      opts.sidecarUrl,
      fetchImpl,
    ),
  };
}

/**
 * Shared turn tuning. The sidecar reports honest silenceMs on speech_end
 * (VAD hangover + Whisper time), so the orchestrator no longer re-waits
 * silence the VAD already observed; 800ms matches the feature-7 stop-secs
 * default. Chunk sizes: the first chunk flushes at the first sentence
 * terminator (fast first audio); later chunks merge short sentences
 * (~2-sentence prosody — Kokoro sounds flat on fragments).
 */
export const VOICE_TURN_CONFIG: OrchestratorConfig = {
  silenceThresholdMs: 800,
  forceEndMs: 2_500,
  minCharsPerChunk: 60,
  maxCharsPerChunk: 240,
};

/** Resolve core/sidecar URLs from env exactly like the CLI does. */
export function voiceUrlsFromEnv(): VoiceDepsOptions {
  const corePort = process.env["CORE_PORT"] ?? "8080";
  return {
    coreUrl: process.env["CORE_URL"] ?? `http://127.0.0.1:${corePort}`,
    sidecarUrl: process.env["VOICE_SIDECAR_URL"] ?? "http://127.0.0.1:8089",
  };
}

/** The real session manager wired for live use — engines built per start(). */
export function createDefaultVoiceSessionManager(): VoiceSessionManager {
  const urls = voiceUrlsFromEnv();
  return new VoiceSessionManager({
    sidecarUrl: urls.sidecarUrl,
    orchestratorFactory: (wakeSource: HttpWakeSource) =>
      createVoiceOrchestrator(
        { wakeWord: wakeSource, ...buildVoiceDeps(urls) },
        VOICE_TURN_CONFIG,
      ),
  });
}
