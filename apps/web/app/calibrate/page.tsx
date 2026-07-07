'use client';

/**
 * Swipe calibration (PRODUCT_SPEC E1/E2): 10–15 real in-stock dresses in her
 * size/budget, diversity-sampled. Right = like, left = pass, heart = save.
 * Tap for a quick peek. Skippable after 5. Ends in "Building your rack…".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RankedListing, SwipeEvent } from '@hemline/contracts';
import {
  Button,
  ConfidenceTag,
  ErrorState,
  HemBadge,
  ProgressDots,
  Sheet,
  SourceBadge,
  Spinner,
  formatPrice,
  lengthClassLabel,
} from '@hemline/ui';
import { api } from '../../lib/api';
import { useProfile } from '../../lib/profile-store';
import { resolveImage } from '../../lib/img';
import { KEYS, readLocal, writeLocal } from '../../lib/local';

const DECK_SIZE = 12;

/** Diversity-sample the deck across length/silhouette/color so swipes carry signal. */
function sampleDeck(items: RankedListing[], n: number): RankedListing[] {
  const picked: RankedListing[] = [];
  const seen = new Set<string>();
  const pool = [...items];
  while (picked.length < n && pool.length > 0) {
    let idx = pool.findIndex((it) => {
      const key = `${it.listing.lengthClass}|${it.listing.silhouette}|${it.listing.colors[0]?.family}`;
      return !seen.has(key);
    });
    if (idx === -1) {
      seen.clear();
      idx = 0;
    }
    const [it] = pool.splice(idx, 1);
    seen.add(`${it.listing.lengthClass}|${it.listing.silhouette}|${it.listing.colors[0]?.family}`);
    picked.push(it);
  }
  return picked;
}

export default function CalibratePage() {
  const router = useRouter();
  const { profile, recordSwipes } = useProfile();
  const [deck, setDeck] = useState<RankedListing[] | null>(null);
  const [error, setError] = useState(false);
  const [index, setIndex] = useState(0);
  const [peek, setPeek] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState(0);
  const events = useRef<SwipeEvent[]>([]);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [flying, setFlying] = useState<'left' | 'right' | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!profile) return;
    const swiped = new Set(readLocal<string[]>(KEYS.swipedIds, []));
    api
      .rank({
        userId: profile.id,
        filters: {
          sizesNormalized: profile.sizesNormalized.length ? profile.sizesNormalized : undefined,
          priceMinCents: profile.budget.minCents ?? undefined,
          priceMaxCents: profile.budget.maxCents ?? undefined,
        },
        limit: 48,
        personalize: false,
      })
      .then((res) => {
        const fresh = res.items.filter((i) => !swiped.has(i.listing.id));
        setDeck(sampleDeck(fresh.length >= DECK_SIZE ? fresh : res.items, DECK_SIZE));
      })
      .catch(() => setError(true));
  }, [profile]);

  const finish = useCallback(async () => {
    setBuilding(true);
    const msgs = setInterval(() => setBuildMsg((m) => Math.min(m + 1, 2)), 800);
    const swiped = readLocal<string[]>(KEYS.swipedIds, []);
    writeLocal(KEYS.swipedIds, [...new Set([...swiped, ...events.current.map((e) => e.listingId)])]);
    try {
      await recordSwipes(events.current);
    } catch {
      /* taste vector update is best-effort */
    }
    await new Promise((r) => setTimeout(r, 2400));
    clearInterval(msgs);
    router.push('/feed');
  }, [recordSwipes, router]);

  const swipe = useCallback(
    (verdict: 'like' | 'dislike' | 'save') => {
      if (!deck || index >= deck.length || flying) return;
      const item = deck[index];
      events.current.push({ listingId: item.listing.id, verdict, context: 'calibration' });
      setFlying(verdict === 'dislike' ? 'left' : 'right');
      setTimeout(() => {
        setFlying(null);
        setDrag(null);
        if (index + 1 >= deck.length) void finish();
        else setIndex(index + 1);
      }, 260);
    },
    [deck, index, flying, finish],
  );

  /* pointer-drag swiping */
  const onPointerDown = (e: React.PointerEvent) => {
    startRef.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!startRef.current) return;
    setDrag({ dx: e.clientX - startRef.current.x, dy: e.clientY - startRef.current.y });
  };
  const onPointerUp = () => {
    const dx = drag?.dx ?? 0;
    startRef.current = null;
    if (Math.abs(dx) > 80) swipe(dx > 0 ? 'like' : 'dislike');
    else if (Math.abs(dx) < 6) setPeek(true);
    else setDrag(null);
  };

  if (building) {
    const messages = ['Reading your swipes…', 'Scoring 150 in-stock dresses…', 'Building your rack…'];
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-8 text-center">
        <Spinner label="Building your rack" className="scale-150" />
        <div aria-live="polite">
          <h1 className="font-display text-2xl text-ink animate-fade" key={buildMsg}>
            {messages[buildMsg]}
          </h1>
          <p className="mt-2 text-sm text-ink-soft">Personalizing for your height, size and taste.</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <ErrorState title="Couldn’t load your deck">
          <Button onClick={() => location.reload()}>Try again</Button>
        </ErrorState>
      </main>
    );
  }

  if (!profile || deck === null) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
        <Spinner label="Finding dresses in your size" />
        <p className="text-sm text-ink-soft">Pulling in-stock dresses in your size…</p>
      </main>
    );
  }

  const current = deck[index];
  const swipedCount = index;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 pt-4 pb-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl text-ink">Yes or no?</h1>
          <p className="text-xs text-ink-soft">Swipe right to like, left to pass. Tap to peek.</p>
        </div>
        <span className="text-xs tabular-nums text-ink-faint">
          {Math.min(index + 1, deck.length)} / {deck.length}
        </span>
      </header>

      <div className="relative mt-4 flex-1" style={{ touchAction: 'pan-y' }}>
        {/* next card underneath */}
        {deck[index + 1] && (
          <SwipeCard item={deck[index + 1]} className="absolute inset-0 scale-[0.96] opacity-60" />
        )}
        {current && (
          <div
            data-testid="swipe-card"
            className="absolute inset-0 cursor-grab select-none active:cursor-grabbing"
            style={{
              transform: flying
                ? `translateX(${flying === 'right' ? 480 : -480}px) rotate(${flying === 'right' ? 24 : -24}deg)`
                : drag
                  ? `translateX(${drag.dx}px) translateY(${drag.dy * 0.2}px) rotate(${drag.dx / 18}deg)`
                  : undefined,
              transition: flying ? 'transform 0.26s ease-in' : drag ? 'none' : 'transform 0.2s ease',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <SwipeCard item={current} className="h-full" />
            {/* verdict stamps */}
            <span
              aria-hidden="true"
              className="absolute top-6 left-5 -rotate-12 rounded-lg border-2 border-moss px-3 py-1 font-display text-xl text-moss transition-opacity"
              style={{ opacity: Math.max(0, Math.min(1, ((drag?.dx ?? 0) - 24) / 60)) }}
            >
              LIKE
            </span>
            <span
              aria-hidden="true"
              className="absolute top-6 right-5 rotate-12 rounded-lg border-2 border-accent px-3 py-1 font-display text-xl text-accent transition-opacity"
              style={{ opacity: Math.max(0, Math.min(1, (-(drag?.dx ?? 0) - 24) / 60)) }}
            >
              PASS
            </span>
          </div>
        )}
      </div>

      <ProgressDots count={deck.length} active={index} className="mt-4" />

      <div className="mt-4 flex items-center justify-center gap-5">
        <button
          type="button"
          aria-label="Pass"
          data-testid="swipe-pass"
          onClick={() => swipe('dislike')}
          className="flex size-14 items-center justify-center rounded-full border border-line bg-card shadow-card transition-transform active:scale-90"
        >
          <svg viewBox="0 0 20 20" className="size-6 text-ink-soft" aria-hidden="true">
            <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Save to rack"
          data-testid="swipe-save"
          onClick={() => swipe('save')}
          className="flex size-12 items-center justify-center rounded-full border border-accent/30 bg-accent-soft shadow-card transition-transform active:scale-90"
        >
          <svg viewBox="0 0 24 24" className="size-5 text-accent" aria-hidden="true">
            <path
              d="M12 20.3 4.8 13a4.6 4.6 0 0 1 0-6.6 4.7 4.7 0 0 1 6.6 0l.6.6.6-.6a4.7 4.7 0 0 1 6.6 0 4.6 4.6 0 0 1 0 6.6L12 20.3Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Like"
          data-testid="swipe-like"
          onClick={() => swipe('like')}
          className="flex size-14 items-center justify-center rounded-full bg-ink shadow-lift transition-transform active:scale-90"
        >
          <svg viewBox="0 0 20 20" className="size-6 text-cream" aria-hidden="true">
            <path d="M3 10.5l4.5 4.5L17 5.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-4 min-h-11 text-center">
        {swipedCount >= 5 && (
          <Button variant="ghost" onClick={finish} data-testid="deck-done">
            Take me to my rack →
          </Button>
        )}
      </div>

      {current && (
        <Sheet open={peek} onClose={() => setPeek(false)} title={current.listing.brand ?? 'One of a kind'}>
          <PeekContent item={current} />
        </Sheet>
      )}
    </main>
  );
}

function SwipeCard({ item, className }: { item: RankedListing; className?: string }) {
  const { listing, hem } = item;
  return (
    <div className={`overflow-hidden rounded-3xl bg-parchment shadow-lift ${className ?? ''}`}>
      <div className="relative h-full">
        <img
          src={resolveImage(listing.images[0] ?? '')}
          alt={listing.title}
          draggable={false}
          className="h-full w-full object-cover"
        />
        <SourceBadge sourceId={listing.sourceId} brand={listing.brand} className="absolute top-3 left-3" />
        <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-ink/80 via-ink/30 to-transparent p-4 pt-12">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-semibold tracking-widest text-cream/85 uppercase">
              {listing.brand ?? 'One of a kind'}
            </span>
            <span className="font-display text-lg text-cream">{formatPrice(listing.priceCents)}</span>
          </div>
          <p className="truncate text-sm text-cream/80">{listing.title}</p>
          <HemBadge hem={hem} invert data-testid="hem-badge" className="mt-1.5" />
        </div>
      </div>
    </div>
  );
}

function PeekContent({ item }: { item: RankedListing }) {
  const { listing, hem } = item;
  const m = listing.measurements;
  return (
    <div className="space-y-3 pb-2">
      <p className="font-display text-lg leading-snug text-ink">{listing.title}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{formatPrice(listing.priceCents)}</span>
        <SourceBadge sourceId={listing.sourceId} brand={listing.brand} />
        {listing.lengthClass && (
          <span className="text-xs text-ink-soft">labeled {lengthClassLabel[listing.lengthClass]}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <HemBadge hem={hem} />
        <ConfidenceTag hem={hem} />
      </div>
      {(m.bust ?? m.waist ?? m.length) != null && (
        <p className="text-xs text-ink-soft">
          {m.bust != null && `Bust ${m.bust}″ · `}
          {m.waist != null && `Waist ${m.waist}″ · `}
          {m.length != null && `Length ${m.length}″`}
        </p>
      )}
      <p className="text-xs text-ink-faint">
        Sizes: {listing.sizeLabels.join(', ')} {listing.isVintage && '· vintage'}
      </p>
    </div>
  );
}
