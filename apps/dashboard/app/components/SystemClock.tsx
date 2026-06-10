"use client";

import { useEffect, useState } from "react";

/**
 * Live HUD clock for the topbar: "TUE 09 JUN · 14:05:33".
 * Renders empty on the server and hydrates on mount so the
 * server/client markup never mismatches.
 */
export default function SystemClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!now) return <span className="sysclock" aria-hidden="true" />;

  const date = now
    .toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" })
    .replace(/,/g, "")
    .toUpperCase();
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <span className="sysclock">
      {date} · {time}
    </span>
  );
}
