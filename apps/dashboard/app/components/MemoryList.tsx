import type { MemoryContract, WidgetEnvelope } from "@/app/lib/contracts";

interface MemoryListProps {
  envelope: WidgetEnvelope<MemoryContract[]>;
}

const KIND_LABEL: Record<string, string> = {
  episode: "ep",
  entity: "ent",
  fact: "fact",
};

export default function MemoryList({ envelope }: MemoryListProps) {
  if (envelope.state === "error") {
    return (
      <div className="card card--error">
        <div className="card__title">Memories</div>
        <p className="text-error text-sm">{envelope.error?.message ?? "Failed to load memories"}</p>
      </div>
    );
  }

  const memories = envelope.data ?? [];

  if (memories.length === 0) {
    return (
      <div className="card">
        <div className="card__title">Recent Memories</div>
        <p className="text-dim">No memories captured yet.</p>
        <a href="/settings/integrations" className="link-cta">Connect sources</a>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card__title">Recent Memories</div>
      <ul className="memory-list">
        {memories.map((m) => (
          <li key={m.memoryId} className="memory-list__item">
            <span className={`badge-kind badge-kind--${m.kind}`}>
              {KIND_LABEL[m.kind] ?? m.kind}
            </span>
            <span className="memory-list__text">{m.text}</span>
            <span className="memory-list__score">
              {(m.fusedScore * 100).toFixed(0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
