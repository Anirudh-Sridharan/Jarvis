import type { BriefingContract, WidgetEnvelope } from "@/app/lib/contracts";

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

export default function BriefingCard({ envelope }: BriefingCardProps) {
  if (envelope.state === "error") {
    return (
      <div className="card card--error">
        <div className="card__title">Daily Briefing</div>
        <p className="text-dim">Couldn&apos;t build today&apos;s brief.</p>
        <p className="text-error text-sm">{envelope.error?.message}</p>
      </div>
    );
  }

  if (envelope.state === "empty" || !envelope.data) {
    return (
      <div className="card">
        <div className="card__title">Daily Briefing</div>
        <p className="text-dim">
          Your brief will be ready after tonight&apos;s review.
        </p>
        <a href="/api/briefing?generate=1" className="link-cta">Generate now</a>
      </div>
    );
  }

  const { data } = envelope;

  return (
    <div className="card briefing-card">
      <div className="card__header">
        <div className="card__title">Today&apos;s Brief</div>
        <div className="card__meta">
          {data.generatedBy === "template" ? "template" : "AI"} &middot;{" "}
          {new Date(data.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          {envelope.state === "stale" && <span className="badge-stale ml">T+1</span>}
        </div>
      </div>
      <div
        className="briefing-card__body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(data.markdown) }}
      />
    </div>
  );
}
