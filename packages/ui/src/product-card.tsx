'use client';

/**
 * The product card (PRODUCT_SPEC B2). Every card shows: image, brand, price,
 * source badge, freshness, save heart, and THE HEM BADGE — never blank.
 */
import type { ElementType } from 'react';
import type { HemResult, Listing } from '@hemline/contracts';
import { FreshnessBadge, SourceBadge, formatAgo, isStale } from './badges';
import { HemBadge } from './hem';
import { RemovableChip } from './chip';
import { cn } from './cn';

export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function HeartButton({
  saved,
  onToggle,
  className,
}: {
  saved: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={saved ? 'Remove from rack' : 'Save to rack'}
      aria-pressed={saved}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'flex size-9 items-center justify-center rounded-full bg-cream/90 shadow-card backdrop-blur transition-transform active:scale-90',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className={cn('size-5', saved ? 'text-accent' : 'text-ink')} aria-hidden="true">
        <path
          d="M12 20.3 4.8 13a4.6 4.6 0 0 1 0-6.6 4.7 4.7 0 0 1 6.6 0l.6.6.6-.6a4.7 4.7 0 0 1 6.6 0 4.6 4.6 0 0 1 0 6.6L12 20.3Z"
          fill={saved ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function ProductCard({
  listing,
  hem,
  imageSrc,
  href,
  LinkComponent = 'a',
  saved,
  onToggleSave,
  paletteMatch = false,
  onRemovePaletteChip,
  showStaleFlag = false,
  className,
}: {
  listing: Listing;
  hem: HemResult;
  imageSrc: string;
  href: string;
  LinkComponent?: ElementType;
  saved: boolean;
  onToggleSave: () => void;
  paletteMatch?: boolean;
  onRemovePaletteChip?: () => void;
  showStaleFlag?: boolean;
  className?: string;
}) {
  const Link = LinkComponent;
  const stale = isStale(listing.lastSeenAt);

  return (
    <article data-testid="product-card" className={cn('group relative', className)}>
      <Link href={href} className="block focus-visible:outline-accent" aria-label={listing.title}>
        <div className="relative overflow-hidden rounded-2xl bg-parchment shadow-card">
          <img
            src={imageSrc}
            alt={listing.title}
            loading="lazy"
            className="aspect-[3/4] w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
          <SourceBadge sourceId={listing.sourceId} brand={listing.brand} className="absolute top-2 left-2" />
          {paletteMatch && onRemovePaletteChip && (
            <RemovableChip
              onRemove={onRemovePaletteChip}
              removeLabel="Remove palette boost from this dress"
              className="absolute bottom-2 left-2 shadow-card"
            >
              in your palette
            </RemovableChip>
          )}
        </div>

        <div className="space-y-1 pt-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
              {listing.brand ?? 'One of a kind'}
            </span>
            <span className="shrink-0 text-sm font-semibold text-ink">{formatPrice(listing.priceCents)}</span>
          </div>
          <p className="truncate text-xs text-ink-soft">{listing.title}</p>
          <HemBadge hem={hem} data-testid="hem-badge" />
          <div className="flex items-center justify-between">
            <FreshnessBadge lastSeenAt={listing.lastSeenAt} />
            {listing.isVintage && (
              <span className="text-[10px] tracking-wide text-ink-faint uppercase">vintage</span>
            )}
          </div>
          {showStaleFlag && stale && (
            <p className="text-[11px] text-accent">
              Possibly sold — last seen {formatAgo(listing.lastSeenAt)}
            </p>
          )}
        </div>
      </Link>
      <HeartButton saved={saved} onToggle={onToggleSave} className="absolute top-2 right-2" />
    </article>
  );
}
