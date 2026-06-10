import type { Metadata } from "next";
import "./globals.css";
import ModelStatusBadge from "./components/ModelStatusBadge";
import Nav from "./components/Nav";

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
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="topbar__brand">
              <span>◆</span> Jarvis
            </div>
            <ModelStatusBadge />
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
