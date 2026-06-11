"use client";

import { useEffect, useRef } from "react";

/**
 * Live HUD clock for the topbar: big HH:MM:SS over a small "WED · JUN 10 · 2026".
 * Renders empty placeholders on the server and fills them on mount, so
 * server/client markup never mismatches. Updates are direct DOM writes (no
 * per-second setState) — per the design-template rendering notes, the React
 * tree is never re-rendered by the clock.
 */

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export default function SystemClock() {
  const timeRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const time = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
      const date = `${DAYS[n.getDay()]} · ${MONTHS[n.getMonth()]} ${pad(n.getDate())} · ${n.getFullYear()}`;
      if (timeRef.current && timeRef.current.textContent !== time) {
        timeRef.current.textContent = time;
      }
      if (dateRef.current && dateRef.current.textContent !== date) {
        dateRef.current.textContent = date;
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="sysclock">
      <div className="sysclock__time" ref={timeRef} />
      <div className="sysclock__date" ref={dateRef} />
    </div>
  );
}
