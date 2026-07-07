'use client';

/**
 * My Rack — saved items (PRODUCT_SPEC F1): standard cards with freshness +
 * effective length, stale flags, contextual (never walled) sync nudge stub.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { RankedListing } from '@hemline/contracts';
import { Button, CardSkeleton, EmptyState } from '@hemline/ui';
import { api } from '../../../lib/api';
import { useProfile } from '../../../lib/profile-store';
import { ListingGrid } from '../../components/grid';

export default function SavedPage() {
  const { savedIds } = useProfile();
  const [fetched, setFetched] = useState<RankedListing[] | null>(null);
  const [syncNudge, setSyncNudge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSaved()
      .then((res) => !cancelled && setFetched(res))
      .catch(() => !cancelled && setFetched([]));
    return () => {
      cancelled = true;
    };
  }, [savedIds]);

  // savedIds is the instant client truth; the refetch races the
  // fire-and-forget DELETE in toggleSave, so an unsaved card could otherwise
  // linger until the next reload. Filter so unsave removes the card at once.
  const items = fetched === null ? null : fetched.filter((i) => savedIds.includes(i.listing.id));

  return (
    <main className="px-4 pt-4">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl text-ink">Saved</h1>
        {items && items.length > 0 && <span className="text-xs text-ink-faint">{items.length} dresses</span>}
      </header>

      {items === null ? (
        <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-6 lg:grid-cols-3">
          {Array.from({ length: 4 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Your rack is empty"
          action={
            <Link href="/feed" className="inline-flex min-h-11 items-center rounded-full bg-ink px-6 text-sm font-medium text-cream">
              Browse your feed
            </Link>
          }
        >
          Tap the heart on any dress to keep it here — saves live on this device, no account needed.
        </EmptyState>
      ) : (
        <>
          <div className="mt-4">
            <ListingGrid items={items} context="feed" showStaleFlag />
          </div>

          {/* F3 contextual email nudge — stub, never a wall */}
          <div className="mt-8 mb-4 rounded-2xl border border-line bg-card p-4">
            <p className="font-display text-lg text-ink">Don’t lose your rack</p>
            <p className="mt-1 text-sm text-ink-soft">
              Add an email to sync saves across devices. No password — just a magic link.
            </p>
            {syncNudge ? (
              <p className="mt-3 text-sm font-medium text-moss" role="status">
                Sync is coming soon — your rack is safe on this device meanwhile.
              </p>
            ) : (
              <Button variant="outline" className="mt-3" onClick={() => setSyncNudge(true)}>
                Sync my rack
              </Button>
            )}
          </div>
        </>
      )}
    </main>
  );
}
