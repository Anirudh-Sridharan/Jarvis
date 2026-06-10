/**
 * Shared empty/error/skeleton/placeholder state components.
 * Used by every data-bearing page/widget.
 */

export function EmptyState({
  title,
  message,
  ctaLabel,
  ctaHref,
}: {
  title?: string;
  message: string;
  ctaLabel?: string;
  ctaHref?: string;
}) {
  return (
    <div className="card state-card">
      {title && <div className="card__title">{title}</div>}
      <p className="text-dim">{message}</p>
      {ctaLabel && ctaHref && (
        <a href={ctaHref} className="link-cta">{ctaLabel}</a>
      )}
    </div>
  );
}

export function ErrorState({
  title,
  message,
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="card card--error state-card">
      {title && <div className="card__title">{title}</div>}
      <p className="text-error">{message ?? "Something went wrong."}</p>
    </div>
  );
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="card skeleton-card" aria-busy="true" aria-label="Loading…">
      <div className="skeleton-line skeleton-line--title" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${65 + (i % 3) * 10}%` }} />
      ))}
    </div>
  );
}

export function PlaceholderCard({ title, message }: { title: string; message?: string }) {
  return (
    <div className="card placeholder-card">
      <div className="placeholder-card__ribbon">Planned for v2</div>
      <div className="card__title">{title}</div>
      <p className="text-dim">{message ?? "Coming in a future release."}</p>
    </div>
  );
}
