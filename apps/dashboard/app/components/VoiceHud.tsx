"use client";

/**
 * VoiceHud — hands-free voice mode for the home page.
 *
 * Renders as a slim "voice interface" strip; engaging it arms the wake-word
 * listener and opens the full-screen takeover (orb, ripples, live state,
 * waveform, transcript, streaming reply).
 *
 * Wire protocol (unchanged): Engage → POST core /voice/start (core enables the
 * sidecar wake-word listener on the system mic) and attach to GET /voice/events
 * (SSE). Say "Hey Jarvis" → live state + transcript render here while audio
 * plays on the Mac's speakers. Disengage (✕ or Esc) → POST /voice/stop. The
 * session lives in core, so a reloaded tab reattaches to a running session
 * (GET /voice/status on mount) instead of restarting it. Frames carry a
 * monotonic `seq`; replayed frames after a reconnect are deduped against the
 * last seen seq.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CORE_URL, uid } from "@/app/lib/clientEnv";
import Orb from "./Orb";

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

// Deterministic waveform bars (no Math.random — SSR-safe, stable captures).
const WAVE_BARS = Array.from({ length: 28 }, (_, i) => ({
  delay: `${(i * 0.05).toFixed(2)}s`,
  dur: `${(0.7 + ((i * 37) % 55) / 100).toFixed(2)}s`,
  h: 10 + ((i * 53) % 30),
}));

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
                setError("Voice session lost — engage again.");
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
        // core not running — HUD stays disengaged
      }
    })();
    return () => {
      cancelled = true;
      armedRef.current = false;
      abortRef.current?.abort();
    };
  }, [attach]);

  // Esc disengages while the takeover is open.
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void disarm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, disarm]);

  const displayState = armed ? voiceState : "inactive";
  const label = STATE_LABEL[displayState] ?? displayState.toUpperCase();
  const waveLive = displayState === "listening" || displayState === "speaking";
  const lastReply = [...feed].reverse().find((e) => e.role === "assistant" && e.content !== "");
  const logLines = feed.slice(-3);

  return (
    <>
      <section className={`voice-strip${armed ? " voice-strip--armed" : ""}`}>
        <Orb size={46} id="strip" />
        <div className="voice-strip__text">
          <div className="voice-strip__eyebrow">Voice Interface</div>
          <div className="voice-strip__status">
            {armed ? (
              <>Live — say <em>&ldquo;Hey Jarvis&rdquo;</em>, it&rsquo;s listening</>
            ) : (
              <>Standby — engage to arm the <em>&ldquo;Hey Jarvis&rdquo;</em> wake-word</>
            )}
          </div>
          {error ? <div className="voice-strip__error">{error}</div> : null}
        </div>
        <span
          className={`voice-strip__chip${armed ? " voice-strip__chip--live" : ""}`}
          role="status"
          aria-live="polite"
        >
          {label}
        </span>
        <button
          className="voice-strip__engage"
          disabled={busy}
          aria-pressed={armed}
          onClick={() => void (armed ? disarm() : arm())}
        >
          <span
            className={`voice-strip__engage-dot${armed ? " voice-strip__engage-dot--live" : ""}`}
            aria-hidden
          />
          {armed ? "Disengage" : "Engage Voice"}
        </button>
      </section>

      {armed ? (
        <div className="voice-takeover" role="dialog" aria-label="Voice interface">
          <div className="voice-takeover__session">Voice Interface — Hands-Free</div>
          <button
            className="voice-takeover__close"
            onClick={() => void disarm()}
            aria-label="Disengage voice mode"
            autoFocus
          >
            ✕
          </button>

          <div className="voice-takeover__stage">
            <div className="voice-takeover__ripple" />
            <div className="voice-takeover__ripple" />
            <div className="voice-takeover__ripple" />
            <div className="voice-takeover__glow" />
            <Orb size={280} id="takeover" />
          </div>

          <div className="voice-takeover__state-row">
            <span className="voice-takeover__rule voice-takeover__rule--l" />
            <span
              className={`voice-takeover__state${displayState === "error" ? " voice-takeover__state--error" : ""}`}
              role="status"
              aria-live="polite"
            >
              {label}
            </span>
            <span className="voice-takeover__rule voice-takeover__rule--r" />
          </div>

          <div className={`voice-takeover__wave${waveLive ? "" : " voice-takeover__wave--idle"}`} aria-hidden>
            {WAVE_BARS.map((b, i) => (
              <div
                key={i}
                className="voice-takeover__bar"
                style={{ height: b.h, animationDuration: b.dur, animationDelay: b.delay }}
              />
            ))}
          </div>

          <div className="voice-takeover__partial">
            {partial ? <>&ldquo;…{partial}&rdquo;</> : null}
          </div>

          {lastReply ? (
            <div className="voice-takeover__reply">
              <div className="voice-takeover__reply-label">
                Jarvis{displayState === "thinking" || displayState === "speaking" ? " — streaming" : ""}
              </div>
              <div className="voice-takeover__reply-text">{lastReply.content}</div>
            </div>
          ) : null}

          <div className={`voice-takeover__hint${barged || reconnecting ? " voice-takeover__hint--warn" : ""}`}>
            {error
              ? error
              : barged
                ? "BARGE-IN — GO AHEAD"
                : reconnecting
                  ? "RECONNECTING…"
                  : "BARGE-IN ENABLED — SPEAK ANYTIME · ESC TO DISENGAGE"}
          </div>

          {logLines.length > 0 ? (
            <div className="voice-takeover__log" aria-hidden>
              {logLines.map((entry) => (
                <div
                  key={entry.id}
                  className={`voice-takeover__log-line${entry.role === "assistant" ? " voice-takeover__log-line--bright" : ""}`}
                >
                  {entry.role === "user" ? "YOU" : "JARVIS"} · {entry.content || "…"}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
