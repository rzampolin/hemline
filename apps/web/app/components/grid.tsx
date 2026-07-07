'use client';

/** Shared 2-col card grid wired to the profile store (saves, palette chips). */
import Link from 'next/link';
import type { RankedListing, SwipeEvent } from '@hemline/contracts';
import { ProductCard } from '@hemline/ui';
import { useMemo, useState } from 'react';
import { useProfile } from '../../lib/profile-store';
import { resolveImage } from '../../lib/img';
import { hexToFamily } from '../../lib/mock/data';
import { KEYS, readLocal } from '../../lib/local';

export function ListingGrid({
  items,
  context = 'feed',
  showStaleFlag = false,
  showPaletteChips = true,
}: {
  items: RankedListing[];
  context?: SwipeEvent['context'];
  showStaleFlag?: boolean;
  showPaletteChips?: boolean;
}) {
  const { profile, isSaved, toggleSave, paletteBoost, dismissPaletteChip } = useProfile();
  const [dismissedLocal, setDismissedLocal] = useState<string[]>(() =>
    readLocal<string[]>(KEYS.paletteDismissedCards, []),
  );

  const paletteFamilies = useMemo(
    () => new Set((profile?.palette ?? []).map((c) => hexToFamily(c.hex))),
    [profile?.palette],
  );

  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-6 lg:grid-cols-3 xl:grid-cols-4">
      {items.map(({ listing, hem }) => {
        const paletteMatch =
          showPaletteChips &&
          paletteBoost &&
          paletteFamilies.size > 0 &&
          !dismissedLocal.includes(listing.id) &&
          listing.colors.some((c) => paletteFamilies.has(c.family));
        return (
          <li key={listing.id}>
            <ProductCard
              listing={listing}
              hem={hem}
              imageSrc={resolveImage(listing.images[0] ?? '')}
              href={`/dress/${encodeURIComponent(listing.id)}`}
              LinkComponent={Link}
              saved={isSaved(listing.id)}
              onToggleSave={() => toggleSave(listing.id, context)}
              paletteMatch={paletteMatch}
              onRemovePaletteChip={() => {
                dismissPaletteChip(listing.id);
                setDismissedLocal((p) => [...p, listing.id]);
              }}
              showStaleFlag={showStaleFlag}
            />
          </li>
        );
      })}
    </ul>
  );
}
