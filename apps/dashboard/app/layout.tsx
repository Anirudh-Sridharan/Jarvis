import type { Metadata } from "next";
import { Fira_Code, Share_Tech_Mono } from "next/font/google";
import "./globals.css";
import ModelStatusBadge from "./components/ModelStatusBadge";
import Nav from "./components/Nav";
import SystemClock from "./components/SystemClock";

// Self-hosted at build time via next/font — no runtime font requests.
const shareTechMono = Share_Tech_Mono({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-share-tech",
  display: "swap",
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  variable: "--font-fira",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Jarvis",
  description: "Jarvis — local-first personal AI assistant. Phase 4 life-metrics dashboard.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${shareTechMono.variable} ${firaCode.variable}`}>
      {/* suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
          data-* attributes into <body> before React hydrates — benign, but noisy. */}
      <body suppressHydrationWarning>
        <div className="shell">
          <header className="topbar">
            <div className="topbar__brand">
              <span>◆</span> Jarvis
            </div>
            <div className="topbar__right">
              <SystemClock />
              <ModelStatusBadge />
            </div>
          </header>
          <div className="shell__body">
            <Nav />
            <main className="shell__content">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
