import { cn } from './cn';

/** Human freshness from `lastSeenAt` (epoch ms) — "Seen 2h ago". */
export function formatAgo(epochMs: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - epochMs) / 60_000));
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Stale when unseen past the freshness window (default 48h). */
export function isStale(lastSeenAt: number, windowHours = 48, now: number = Date.now()): boolean {
  return now - lastSeenAt > windowHours * 3_600_000;
}

export function FreshnessBadge({
  lastSeenAt,
  className,
}: {
  lastSeenAt: number;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] text-ink-faint', className)}>
      <span className="size-1.5 rounded-full bg-moss" aria-hidden="true" />
      Seen {formatAgo(lastSeenAt)}
    </span>
  );
}

/** Resale vs. brand-site provenance. sourceId: 'ebay' | 'fixture:ebay' | 'shopify:staud.clothing' | 'fixture:shopify' */
export function sourceKind(sourceId: string): 'resale' | 'brand' {
  return sourceId.includes('ebay') ? 'resale' : 'brand';
}

export function sourceLabel(sourceId: string, brand?: string | null): string {
  if (sourceKind(sourceId) === 'resale') return 'eBay';
  return brand ?? 'Brand';
}

export function SourceBadge({
  sourceId,
  brand,
  className,
}: {
  sourceId: string;
  brand?: string | null;
  className?: string;
}) {
  const kind = sourceKind(sourceId);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
        kind === 'resale' ? 'bg-ink/80 text-cream' : 'bg-cream/90 text-ink ring-1 ring-line',
        className,
      )}
    >
      {kind === 'resale' ? 'eBay · resale' : sourceLabel(sourceId, brand)}
    </span>
  );
}
