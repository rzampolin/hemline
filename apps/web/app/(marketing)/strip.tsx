'use client';

/**
 * Live proof strip: real in-stock dresses with effective-length lines, plus a
 * height toggle showing the same dresses reclassified per height — the moat,
 * demonstrated before the quiz even starts.
 */
import { useEffect, useState } from 'react';
import type { RankedListing } from '@hemline/contracts';
import { CardSkeleton, HemBadge, formatPrice } from '@hemline/ui';
import { api } from '../../lib/api';
import { hemForUser } from '../../lib/hem';
import { resolveImage } from '../../lib/img';

const HEIGHTS = [
  { label: '5′2″', inches: 62 },
  { label: '5′5″', inches: 65 },
  { label: '5′10″', inches: 70 },
];

export function LandingStrip() {
  const [items, setItems] = useState<RankedListing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(HEIGHTS[0]);

  useEffect(() => {
    api
      .rank({ userId: 'preview', filters: {}, limit: 8, personalize: false })
      .then((res) => setItems(res.items.filter((i) => i.listing.lengthInches != null).slice(0, 6)))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-widest text-ink-soft uppercase">
          Live right now — where each hem hits
        </p>
        <div
          role="radiogroup"
          aria-label="Preview height"
          className="flex rounded-full border border-line bg-card p-0.5"
        >
          {HEIGHTS.map((h) => (
            <button
              key={h.label}
              role="radio"
              aria-checked={height.inches === h.inches}
              onClick={() => setHeight(h)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                height.inches === h.inches ? 'bg-ink text-cream' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {h.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="no-scrollbar -mx-6 flex snap-x snap-mandatory gap-3 overflow-x-auto px-6 pb-2 md:mx-0 md:px-0">
        {items === null
          ? Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="w-40 shrink-0 snap-start">
                <CardSkeleton />
              </li>
            ))
          : items.map(({ listing }) => {
              const hem = hemForUser(listing, height.inches);
              return (
                <li key={listing.id} className="w-40 shrink-0 snap-start">
                  <div className="overflow-hidden rounded-2xl bg-parchment shadow-card">
                    <img
                      src={resolveImage(listing.images[0] ?? '')}
                      alt={listing.title}
                      loading="lazy"
                      className="aspect-[3/4] w-full object-cover"
                    />
                  </div>
                  <div className="space-y-1 pt-2">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="truncate text-[10px] font-semibold tracking-widest text-ink-soft uppercase">
                        {listing.brand ?? 'One of a kind'}
                      </span>
                      <span className="text-xs font-semibold">{formatPrice(listing.priceCents)}</span>
                    </div>
                    <HemBadge hem={hem} />
                  </div>
                </li>
              );
            })}
      </ul>
      <p className="text-[11px] text-ink-faint">
        Same dresses, different body — the hem line updates with the height you pick.
      </p>
    </div>
  );
}
