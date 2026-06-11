"use client";

import { useState } from "react";
import type { BriefingContract, WidgetEnvelope } from "@/app/lib/contracts";
import { localDateStr } from "@/app/lib/dates";

interface BriefingCardProps {
  envelope: WidgetEnvelope<BriefingContract>;
}

/** Minimal markdown → HTML: bolds, italics, list items, line breaks. */
function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n/g, "<br />");
}

export default function BriefingCard({ envelope: initialEnvelope }: BriefingCardProps) {
  // Server-fetched envelope seeds the card; "Generate now" re-fetches the same
  // briefing endpoint client-side (it assembles fresh on every GET) and swaps
  // the result in without a page navigation.
  const [envelope, setEnvelope] = useState(initialEnvelope);
  const [generating, setGenerating] = useState(false);

  const generateNow = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/briefing?date=${localDateStr()}`, {
        cache: "no-store",
      });
      setEnvelope((await res.json()) as WidgetEnvelope<BriefingContract>);
    } catch {
      // Keep the current (empty) state — the card already explains itself.
    } finally {
      setGenerating(false);
    }
  };

  if (envelope.state === "error") {
    return (
      <div className="card card--error">
        <div className="card__title">Morning Briefing</div>
        <p className="text-dim">Couldn&apos;t build today&apos;s brief.</p>
        <p className="text-error text-sm">{envelope.error?.message}</p>
      </div>
    );
  }

  if (envelope.state === "empty" || !envelope.data) {
    return (
      <div className="card">
        <div className="card__title">Morning Briefing</div>
        <p className="text-dim">
          Your brief will be ready after tonight&apos;s review.
        </p>
        <button
          type="button"
          className="link-cta"
          onClick={() => void generateNow()}
          disabled={generating}
        >
          {generating ? "Generating…" : "Generate now"}
        </button>
      </div>
    );
  }

  const { data } = envelope;
  const generatedAt = new Date(data.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="card briefing-card">
      <div className="card__title">Morning Briefing</div>
      <div
        className="briefing-card__body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(data.markdown) }}
      />
      <div className="briefing-card__footer">
        Generated {generatedAt} · {data.generatedBy === "template" ? "Template" : "AI"}
        {envelope.state === "stale" && <span className="badge-stale ml">T+1</span>}
      </div>
    </div>
  );
}
