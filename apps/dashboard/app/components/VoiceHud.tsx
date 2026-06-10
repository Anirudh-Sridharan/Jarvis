"use client";

/**
 * VoiceHud — hands-free voice mode control for the home page.
 *
 * Arm → POST core /voice/start (core enables the sidecar wake-word listener on
 * the system mic) and attach to GET /voice/events (SSE). Say "Hey Jarvis" →
 * live state + transcript render here while audio plays on the Mac's speakers.
 * Disarm → POST /voice/stop. The session lives in core, so a reloaded tab
 * reattaches to a running session (GET /voice/status on mount) instead of
 * restarting it. Frames carry a monotonic `seq`; replayed frames after a
 * reconnect are deduped against the last seen seq.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const CORE_URL =
  process.env.NEXT_PUBLIC_CORE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8080";

// ---- Wire types (core /voice/* contract) -----------------------------------
type OrchestratorEvent =
  | { type: "wake" }
  | { type: "state_change"; state: string }
  | { type: "partial_transcript"; text: string }
  | { type: "final_transcript"; text: string }
  | { type: "token"; text: string }
  | { type: "sentence"; text: string }
  | { type: "turn_complete" }
  | { type: "barge_in" }
  | { type: "error"; message: string };

type VoiceFrame =
  | { type: "voice_status"; active: boolean; state: string; lastWakeAt: number | null }
  | { type: "voice_event"; seq: number; ts: number; event: OrchestratorEvent };

interface FeedEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const STATE_LABEL: Record<string, string> = {
  inactive: "OFFLINE",
  idle: "STANDBY",
  waking: "WAKING",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  error: "ERROR",
};

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function VoiceHud() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voiceState, setVoiceState] = useState("inactive");
  const [reconnecting, setReconnecting] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [barged, setBarged] = useState(false);

  const armedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const attachGenRef = useRef(0);
  const lastSeqRef = useRef(0);
  const assistantIdRef = useRef<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [feed, partial]);

  const handleEvent = useCallback((event: OrchestratorEvent) => {
    switch (event.type) {
      case "state_change":
        setVoiceState(event.state);
        break;
      case "partial_transcript":
        setPartial(event.text);
        break;
      case "final_transcript": {
        setPartial("");
        const assistantId = uid();
        assistantIdRef.current = assistantId;
        setFeed((prev) => [
          ...prev,
          { id: uid(), role: "user", content: event.text },
          { id: assistantId, role: "assistant", content: "" },
        ]);
        break;
      }
      case "token": {
        const id = assistantIdRef.current;
        if (!id) break;
        setFeed((prev) =>
          prev.map((e) => (e.id === id ? { ...e, content: e.content + event.text } : e)),
        );
        break;
      }
      case "turn_complete":
        assistantIdRef.current = null;
        break;
      case "barge_in":
        setBarged(true);
        setTimeout(() => setBarged(false), 1200);
        break;
      case "error":
        setError(event.message);
        break;
      default:
        break; // wake / sentence — no UI
    }
  }, []);

  // Attach to /voice/events; reconnect with backoff while armed.
  const attach = useCallback(async () => {
    const gen = ++attachGenRef.current;
    let backoffMs = 1000;
    while (armedRef.current && attachGenRef.current === gen) {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`${CORE_URL}/voice/events`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`core responded ${res.status}`);
        setReconnecting(false);
        backoffMs = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const payload = raw
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n")
              .trim();
            if (!payload) continue; // heartbeat comment frames have no data: lines
            let frame: VoiceFrame;
            try {
              frame = JSON.parse(payload) as VoiceFrame;
            } catch {
              continue;
            }
            if (frame.type === "voice_status") {
              if (!frame.active && armedRef.current) {
                // Core restarted or the session died out from under us: its seq
                // counter restarts, so our dedupe high-water mark is stale.
                lastSeqRef.current = 0;
                armedRef.current = false;
                setArmed(false);
                setVoiceState("inactive");
                setError("Voice session lost — arm again.");
                abortRef.current?.abort();
                break;
              }
              setVoiceState(frame.active ? frame.state : "inactive");
            } else if (frame.type === "voice_event") {
              if (frame.seq <= lastSeqRef.current) continue; // replay dedupe
              lastSeqRef.current = frame.seq;
              handleEvent(frame.event);
            }
          }
        }
      } catch {
        // fall through to retry/exit below
      } finally {
        abortRef.current = null;
      }
      if (!armedRef.current || attachGenRef.current !== gen) break;
      setReconnecting(true);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
    if (attachGenRef.current === gen) setReconnecting(false);
  }, [handleEvent]);

  const arm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${CORE_URL}/voice/start`, { method: "POST" });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        setError(body.error ?? "Could not start voice mode.");
        return;
      }
      armedRef.current = true;
      setArmed(true);
      void attach();
    } catch {
      setError("Could not reach Jarvis core.");
    } finally {
      setBusy(false);
    }
  }, [attach]);

  const disarm = useCallback(async () => {
    setBusy(true);
    armedRef.current = false;
    abortRef.current?.abort();
    setVoiceState("inactive");
    setPartial("");
    try {
      await fetch(`${CORE_URL}/voice/stop`, { method: "POST" });
    } catch {
      // core unreachable — nothing to stop
    } finally {
      setArmed(false);
      setBusy(false);
    }
  }, []);

  // On mount: reattach if a session is already running; abort stream on unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${CORE_URL}/voice/status`);
        const body = (await res.json()) as { ok: boolean; status?: { active: boolean } };
        if (!cancelled && body.ok && body.status?.active && abortRef.current === null) {
          armedRef.current = true;
          setArmed(true);
          void attach();
        }
      } catch {
        // core not running — HUD stays disarmed
      }
    })();
    return () => {
      cancelled = true;
      armedRef.current = false;
      abortRef.current?.abort();
    };
  }, [attach]);

  const displayState = armed ? voiceState : "inactive";
  const label = STATE_LABEL[displayState] ?? displayState.toUpperCase();

  return (
    <section className={`voice-hud${armed ? " voice-hud--armed" : ""}`}>
      <div className="voice-hud__bar">
        <button
          className="voice-hud__toggle"
          disabled={busy}
          aria-pressed={armed}
          onClick={() => void (armed ? disarm() : arm())}
        >
          ◉ VOICE {armed ? "ON" : "OFF"}
        </button>
        <span className={`voice-hud__ring voice-hud__ring--${displayState}`} aria-hidden />
        <span className="voice-hud__state" role="status" aria-live="polite">{label}</span>
        {barged ? <span className="voice-hud__barge">BARGE-IN</span> : null}
        {reconnecting ? <span className="voice-hud__conn">RECONNECTING…</span> : null}
        {error ? <span className="voice-hud__error">{error}</span> : null}
        {armed && !error ? (
          <span className="voice-hud__hint">say “Hey Jarvis”</span>
        ) : null}
      </div>

      {armed && partial ? <div className="voice-hud__partial">{partial}</div> : null}

      {armed && feed.length > 0 ? (
        <div className="voice-hud__feed" ref={feedRef}>
          {feed.map((entry) => (
            <div key={entry.id} className={`voice-hud__line voice-hud__line--${entry.role}`}>
              <span className="voice-hud__who">
                {entry.role === "user" ? "🎙 you" : "jarvis"}
              </span>
              {entry.content}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
