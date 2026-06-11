import type { Metadata } from "next";
import { JetBrains_Mono, Michroma, Rajdhani } from "next/font/google";
import "./globals.css";
import BootSequence from "./components/BootSequence";
import ModelStatusBadge from "./components/ModelStatusBadge";
import Nav from "./components/Nav";
import SystemClock from "./components/SystemClock";
import TelemetryTicker from "./components/TelemetryTicker";

// Self-hosted at build time via next/font — no runtime font requests.
const michroma = Michroma({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-michroma",
  display: "swap",
});

const rajdhani = Rajdhani({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-rajdhani",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "J.A.R.V.I.S.",
  description: "Jarvis — local-first personal AI assistant. Life-metrics command center.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${michroma.variable} ${rajdhani.variable} ${jetbrainsMono.variable}`}
    >
      {/* suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
          data-* attributes into <body> before React hydrates — benign, but noisy. */}
      <body suppressHydrationWarning>
        <div className="shell">
          {/* Ambient HUD layer: scanlines, sweep band, reticle rings, vignette */}
          <div className="ambient-scanlines" aria-hidden="true" />
          <div className="ambient-sweep" aria-hidden="true" />
          <div className="ambient-reticle" aria-hidden="true" />
          <div className="ambient-reticle--inner" aria-hidden="true" />
          <div className="ambient-vignette" aria-hidden="true" />
          <svg
            className="ambient-corner-rings"
            viewBox="0 0 200 200"
            aria-hidden="true"
          >
            <circle cx="100" cy="100" r="96" fill="none" stroke="#7fdcff" strokeWidth="1" strokeDasharray="3 6" />
            <circle cx="100" cy="100" r="78" fill="none" stroke="#7fdcff" strokeWidth="4" strokeDasharray="1 14" />
            <circle cx="100" cy="100" r="58" fill="none" stroke="#7fdcff" strokeWidth="1" strokeDasharray="70 120" />
          </svg>

          <header className="topbar">
            <div>
              <div className="topbar__brand">J.A.R.V.I.S.</div>
              <div className="topbar__sub">JUST A RATHER VERY INTELLIGENT SYSTEM</div>
            </div>
            <div className="topbar__right">
              <ModelStatusBadge />
              <SystemClock />
            </div>
          </header>

          <div className="shell__body">
            <Nav />
            <main className="shell__content">
              {children}
            </main>
          </div>

          <TelemetryTicker />
        </div>
        <BootSequence />
      </body>
    </html>
  );
}
