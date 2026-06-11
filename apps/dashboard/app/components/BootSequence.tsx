"use client";

/**
 * BootSequence — the JARVIS startup overlay: orb, wordmark, rolling init lines,
 * progress bar, then a fade-out. Plays once per browser session (sessionStorage
 * gate) and is skippable by click or Escape. Users with prefers-reduced-motion
 * never see it.
 *
 * Renders nothing on the server and on first client render (booted=false until
 * the mount effect decides), so there is no hydration mismatch and no frozen
 * opacity-0 first frame.
 */

import { useEffect, useRef, useState } from "react";
import Orb from "./Orb";

const SESSION_KEY = "jarvis-booted";

const LINES = [
  "JARVIS SHELL ....................... OK",
  "MEMORY STORE ....................... MOUNTED",
  "MLX SIDECAR LINK ................... CHECKING",
  "VOICE PIPELINE / WAKE-WORD ......... ARMED",
  "CONNECTOR MIRRORS .................. SYNCED",
  "SAFETY GATE ........................ ACTIVE",
  "ALL SYSTEMS NOMINAL",
];

const LINE_MS = 240;
const START_MS = 300;

export default function BootSequence() {
  const [phase, setPhase] = useState<"hidden" | "running" | "fading">("hidden");
  const [lineCount, setLineCount] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    setPhase("running");

    const timers = timersRef.current;
    LINES.forEach((_, i) => {
      timers.push(setTimeout(() => setLineCount(i + 1), START_MS + i * LINE_MS));
    });
    const total = START_MS + LINES.length * LINE_MS;
    timers.push(setTimeout(() => setPhase("fading"), total + 600));
    timers.push(setTimeout(() => setPhase("hidden"), total + 1100));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skip();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      timers.forEach(clearTimeout);
      timersRef.current = [];
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setPhase("hidden");
  };

  if (phase === "hidden") return null;

  const progress = Math.round((lineCount / LINES.length) * 100);

  return (
    <div
      className={`boot${phase === "fading" ? " boot--fading" : ""}`}
      onClick={skip}
      role="status"
      aria-label="Jarvis initializing"
    >
      <Orb size={170} id="boot" />
      <div className="boot__wordmark">J.A.R.V.I.S.</div>
      <div className="boot__status">INITIALIZING</div>
      <div className="boot__lines">
        {LINES.slice(0, lineCount).map((line) => (
          <div key={line} className="boot__line">{line}</div>
        ))}
      </div>
      <div className="boot__track">
        <div className="boot__progress" style={{ width: `${progress}%` }} />
      </div>
      <div className="boot__skip">CLICK TO SKIP</div>
    </div>
  );
}
