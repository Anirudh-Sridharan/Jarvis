/**
 * Voice CLI (features 7+8, push-to-talk mode): talk to Jarvis, hear it reply.
 *
 *   npm run voice            (requires `npm run core` and `npm run sidecar:voice`)
 *
 * Flow per exchange: press Enter → speak → pause → Jarvis replies aloud
 * (Kokoro bm_fable — British English) while the transcript streams in the
 * terminal. Speaking while Jarvis is talking barges in and cuts it off.
 *
 * Env:
 *   CORE_URL            default http://127.0.0.1:8080
 *   VOICE_SIDECAR_URL   default http://127.0.0.1:8089
 *   JARVIS_TTS_VOICE    override Kokoro voice (default: sidecar's bm_fable)
 *   JARVIS_MIC          avfoundation device, default ":default" (":0" = first mic)
 *
 * macOS will prompt for microphone access for your terminal app on first run.
 */
import "../loadEnv.js"; // MUST be first

import { createInterface } from "node:readline";
import { createVoiceOrchestrator } from "@jarvis/voice";
import type { OrchestratorEvent } from "@jarvis/voice";
import { buildVoiceDeps, VOICE_TURN_CONFIG } from "../voice/buildVoiceDeps.js";
import { PttWakeSource } from "../voice/pttWake.js";

const corePort = process.env["CORE_PORT"] ?? "8080";
const CORE_URL = process.env["CORE_URL"] ?? `http://127.0.0.1:${corePort}`;
const SIDECAR_URL = process.env["VOICE_SIDECAR_URL"] ?? "http://127.0.0.1:8089";

async function checkHealth(): Promise<void> {
  try {
    const res = await fetch(`${CORE_URL}/healthz`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`✗ Jarvis core is not reachable at ${CORE_URL}.`);
    console.error("  Start it first:  npm run core");
    process.exit(1);
  }

  try {
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = (await res.json()) as { state?: string };
    if (health.state === "error") {
      console.error(`✗ Voice sidecar reports error state. Check its logs.`);
      process.exit(1);
    }
  } catch {
    console.error(`✗ Voice sidecar is not reachable at ${SIDECAR_URL}.`);
    console.error("  Start it first:  npm run sidecar:voice");
    console.error("  (first start downloads STT/TTS models — allow a few minutes)");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await checkHealth();

  const ptt = new PttWakeSource();
  const orchestrator = createVoiceOrchestrator(
    {
      wakeWord: ptt,
      ...buildVoiceDeps({ coreUrl: CORE_URL, sidecarUrl: SIDECAR_URL }),
    },
    VOICE_TURN_CONFIG,
  );

  let lastPartialLen = 0;
  const overwriteLine = (text: string): void => {
    process.stdout.write("\r" + " ".repeat(lastPartialLen) + "\r" + text);
    lastPartialLen = text.length;
  };

  orchestrator.on((event: OrchestratorEvent) => {
    switch (event.type) {
      case "state_change":
        if (event.state === "listening") {
          console.log("\n🎙  Listening — speak now (pause to finish)…");
        }
        break;
      case "partial_transcript":
        overwriteLine(`   you: ${event.text}`);
        break;
      case "final_transcript":
        overwriteLine(`   you: ${event.text}`);
        process.stdout.write("\n");
        process.stdout.write("jarvis: ");
        break;
      case "token":
        process.stdout.write(event.text);
        break;
      case "barge_in":
        console.log("\n   (barged in — go ahead)");
        break;
      case "turn_complete": {
        const t = event.turn.timings;
        console.log(
          `\n   ⏱  ${t.eosToFirstAudioMs}ms to first audio · turn ${t.totalTurnMs}ms` +
            (event.turn.bargedIn ? " · barged-in" : ""),
        );
        console.log("\nPress Enter to talk again, or Ctrl+C to quit.");
        break;
      }
      case "error":
        console.error(`\n✗ ${event.message}`);
        break;
    }
  });

  orchestrator.start();

  console.log("Jarvis voice — push-to-talk");
  console.log(`  core:    ${CORE_URL}`);
  console.log(`  sidecar: ${SIDECAR_URL} (voice: ${process.env["JARVIS_TTS_VOICE"] ?? "bm_fable (British)"})`);
  console.log("\nPress Enter to talk. Ctrl+C to quit.");

  const rl = createInterface({ input: process.stdin });
  rl.on("line", () => {
    if (orchestrator.state === "idle") {
      ptt.trigger();
    }
    // Mid-session Enter is ignored — barge in by just speaking.
  });

  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down…");
    rl.close();
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
