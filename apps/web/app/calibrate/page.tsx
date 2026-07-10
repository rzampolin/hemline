'use client';

/**
 * Swipe calibration (PRODUCT_SPEC E1/E2): real in-stock dresses in her
 * size/budget, diversity-sampled. Right = like, left = pass, heart = save.
 * Tap for a quick peek. Skippable after 5. Ends in "Building your rack…".
 *
 * 2026-07-10 (docs/decisions-deck.md):
 * - ADAPTIVE COMPLETION: the deck completes on POSITIVE signal (≥5
 *   likes/saves) or a hard cap of 30 cards — never on raw card count. Between
 *   batches an encouraging interstitial offers 6–8 more cards, sampled to
 *   avoid heavily-disliked silhouettes/colors and explore new ones.
 * - IMAGE RESILIENCE: card images fall back position-by-position on
 *   error/5s stall, then to an editorial placeholder + a spare candidate
 *   swap. Known gray placeholder URLs (fixture listings) render as editorial
 *   SVGs built from the listing's real colors. Next 3 card images preload.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Listing, RankedListing, SwipeEvent } from '@hemline/contracts';
import {
  Button,
  ConfidenceTag,
  ErrorState,
  HeartsProgress,
  HemBadge,
  Sheet,
  Skeleton,
  SourceBadge,
  Spinner,
  formatPrice,
  lengthClassLabel,
} from '@hemline/ui';
import { api } from '../../lib/api';
import { track } from '../../lib/analytics';
import { useProfile } from '../../lib/profile-store';
import { editorialPlaceholder, isPlaceholderImage, resolveImage } from '../../lib/img';
import { KEYS, readLocal, writeLocal } from '../../lib/local';
// Diversity sampling + adaptive-completion logic — lib/deck.ts (unit-tested).
import {
  DECK_LIKE_TARGET,
  DECK_SIZE,
  DECK_SPARES,
  deckCompletionReason,
  deriveExclusions,
  exploredAttributes,
  nextBatchSize,
  positiveCount,
  sampleDeck,
} from '../../lib/deck';

type FinishReason = 'target' | 'cap' | 'skip' | 'exhausted';

export default function CalibratePage() {
  const router = useRouter();
  const { profile, recordSwipes } = useProfile();
  const [deck, setDeck] = useState<RankedListing[] | null>(null);
  const [error, setError] = useState(false);
  const [index, setIndex] = useState(0);
  const [batch, setBatch] = useState(0);
  const [positives, setPositives] = useState(0);
  const [extending, setExtending] = useState(false);
  const [peek, setPeek] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState(0);
  const [finishedWithFewLikes, setFinishedWithFewLikes] = useState(false);
  const events = useRef<SwipeEvent[]>([]);
  const pool = useRef<RankedListing[]>([]);
  const spares = useRef<RankedListing[]>([]);
  const usedIds = useRef<Set<string>>(new Set());
  const indexRef = useRef(0);
  indexRef.current = index;
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
        const candidates = fresh.length >= DECK_SIZE ? fresh : res.items;
        pool.current = candidates;
        // N + spares in one sample: the extras become seamless dead-card swaps
        const sampled = sampleDeck(candidates, DECK_SIZE + DECK_SPARES);
        const initial = sampled.slice(0, DECK_SIZE);
        spares.current = sampled.slice(DECK_SIZE);
        for (const item of sampled) usedIds.current.add(item.listing.id);
        setDeck(initial);
      })
      .catch(() => setError(true));
  }, [profile]);

  const finish = useCallback(
    async (reason: FinishReason) => {
      const likes = positiveCount(events.current);
      track({
        type: 'deck_completed',
        props: {
          likes: Math.min(likes, 99),
          cardsSeen: Math.min(events.current.length, 99),
          reason,
        },
      });
      setFinishedWithFewLikes(likes < DECK_LIKE_TARGET);
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
    },
    [recordSwipes, router],
  );

  /** Append an adaptive extension batch, avoiding heavily-disliked attributes. */
  const extendDeck = useCallback(() => {
    if (!deck) return;
    const size = nextBatchSize(events.current.length);
    const candidates = pool.current.filter((i) => !usedIds.current.has(i.listing.id));
    const byId = new Map(deck.map((d) => [d.listing.id, d]));
    const extra = sampleDeck(candidates, size, {
      exclude: deriveExclusions(events.current, byId),
      explored: exploredAttributes(deck),
    });
    if (size === 0 || extra.length === 0) {
      void finish('exhausted');
      return;
    }
    for (const item of extra) usedIds.current.add(item.listing.id);
    setDeck([...deck, ...extra]);
    setBatch((b) => b + 1);
    setIndex(deck.length);
    setExtending(false);
  }, [deck, finish]);

  const swipe = useCallback(
    (verdict: 'like' | 'dislike' | 'save') => {
      if (!deck || index >= deck.length || flying || extending) return;
      const item = deck[index];
      events.current.push({ listingId: item.listing.id, verdict, context: 'calibration' });
      track({
        type: 'deck_swipe',
        props: { verdict, index: Math.min(index, 99), batch: Math.min(batch, 9) },
      });
      const likes = positiveCount(events.current);
      setPositives(likes);
      setFlying(verdict === 'dislike' ? 'left' : 'right');
      setTimeout(() => {
        setFlying(null);
        setDrag(null);
        const reason = deckCompletionReason(likes, events.current.length);
        if (reason === 'target') {
          void finish('target');
        } else if (index + 1 >= deck.length) {
          // batch exhausted without enough positive signal
          if (reason === 'cap') void finish('cap');
          else if (pool.current.some((i) => !usedIds.current.has(i.listing.id))) setExtending(true);
          else void finish('exhausted');
        } else {
          setIndex(index + 1);
        }
      }, 260);
    },
    [deck, index, flying, extending, batch, finish],
  );

  /**
   * A card's entire image gallery failed → swap in a spare candidate
   * seamlessly (the card itself is already showing an editorial placeholder,
   * so there is never a dead gray card even with no spares left).
   */
  const replaceExhaustedCard = useCallback((listingId: string) => {
    setDeck((prev) => {
      if (!prev) return prev;
      const at = prev.findIndex((d) => d.listing.id === listingId);
      if (at === -1 || at < indexRef.current) return prev; // already swiped past
      const spare = spares.current.shift();
      if (!spare) return prev;
      const next = [...prev];
      next[at] = spare;
      return next;
    });
  }, []);

  /* perceived speed: warm the next 2–3 card images while the current shows */
  useEffect(() => {
    if (!deck || typeof window === 'undefined') return;
    for (const item of deck.slice(index + 1, index + 4)) {
      const url = firstCardImage(item.listing);
      if (url && !url.startsWith('data:')) {
        const img = new window.Image();
        img.src = url;
      }
    }
  }, [deck, index]);

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
          <p className="mt-2 text-sm text-ink-soft">
            {finishedWithFewLikes
              ? 'We’ll keep learning as you browse — every like and save sharpens your picks.'
              : 'Personalizing for your height, size and taste.'}
          </p>
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
  const swipedCount = events.current.length;

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
        {extending ? (
          <div
            data-testid="deck-interstitial"
            className="flex h-full flex-col items-center justify-center gap-4 rounded-3xl bg-parchment p-8 text-center shadow-lift"
          >
            <HeartsProgress filled={positives} total={DECK_LIKE_TARGET} />
            <h2 className="font-display text-2xl text-ink">Still learning your style</h2>
            <p className="max-w-xs text-sm text-ink-soft">
              A few more — your likes teach us far more than your passes.
            </p>
            <Button onClick={extendDeck} data-testid="deck-more">
              Show me a few more
            </Button>
          </div>
        ) : (
          <>
            {/* next card underneath */}
            {deck[index + 1] && (
              <SwipeCard
                item={deck[index + 1]}
                className="absolute inset-0 scale-[0.96] opacity-60"
              />
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
                <SwipeCard
                  item={current}
                  className="h-full"
                  active
                  onImagesExhausted={replaceExhaustedCard}
                />
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
          </>
        )}
      </div>

      <HeartsProgress filled={positives} total={DECK_LIKE_TARGET} className="mt-4" />

      <div className="mt-4 flex items-center justify-center gap-5">
        <button
          type="button"
          aria-label="Pass"
          data-testid="swipe-pass"
          disabled={extending}
          onClick={() => swipe('dislike')}
          className="flex size-14 items-center justify-center rounded-full border border-line bg-card shadow-card transition-transform active:scale-90 disabled:opacity-40"
        >
          <svg viewBox="0 0 20 20" className="size-6 text-ink-soft" aria-hidden="true">
            <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Save to rack"
          data-testid="swipe-save"
          disabled={extending}
          onClick={() => swipe('save')}
          className="flex size-12 items-center justify-center rounded-full border border-accent/30 bg-accent-soft shadow-card transition-transform active:scale-90 disabled:opacity-40"
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
          disabled={extending}
          onClick={() => swipe('like')}
          className="flex size-14 items-center justify-center rounded-full bg-ink shadow-lift transition-transform active:scale-90 disabled:opacity-40"
        >
          <svg viewBox="0 0 20 20" className="size-6 text-cream" aria-hidden="true">
            <path d="M3 10.5l4.5 4.5L17 5.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="mt-4 min-h-11 text-center">
        {swipedCount >= 5 && (
          <Button variant="ghost" onClick={() => void finish('skip')} data-testid="deck-done">
            Take me to my rack →
          </Button>
        )}
      </div>

      {current && !extending && (
        <Sheet open={peek} onClose={() => setPeek(false)} title={current.listing.brand ?? 'One of a kind'}>
          <PeekContent item={current} />
        </Sheet>
      )}
    </main>
  );
}

/* ── card image fallback chain (docs/decisions-deck.md, 2026-07-10) ──────── */

interface CardImageSource {
  url: string;
  /** gallery position for telemetry; -1 for the synthetic final fallback */
  position: number;
  /** real network fetch (can fail) vs inline data-URI (cannot) */
  remote: boolean;
}

/**
 * The ordered fallback chain for a card: each gallery image in position
 * order (known gray placeholders rewritten to editorial SVGs), ending in a
 * synthetic editorial placeholder so a card can ALWAYS render something
 * on-brand — never a dead gray box.
 */
function cardImageSources(listing: Listing): CardImageSource[] {
  const sources: CardImageSource[] = listing.images.filter(Boolean).map((url, i) => {
    if (isPlaceholderImage(url)) {
      return { url: editorialPlaceholder(listing, i), position: i, remote: false };
    }
    const resolved = resolveImage(url);
    return { url: resolved, position: i, remote: resolved.startsWith('http') };
  });
  if (sources.length === 0 || sources[sources.length - 1].remote) {
    sources.push({ url: editorialPlaceholder(listing), position: -1, remote: false });
  }
  return sources;
}

/** First image the card will attempt — used for next-card preloading. */
function firstCardImage(listing: Listing): string | null {
  return cardImageSources(listing)[0]?.url ?? null;
}

const SLOW_LOAD_MS = 5000;

/**
 * Deck card image with resilience: branded shimmer while loading, onError or
 * a ~5s stall advances to the listing's next gallery image, and exhausting
 * every real image reports up (spare-card swap) while an editorial
 * placeholder keeps the card alive. Real failures emit `deck_image_error`.
 */
function CardImage({
  listing,
  active = false,
  onExhausted,
}: {
  listing: Listing;
  active?: boolean;
  onExhausted?: (listingId: string) => void;
}) {
  const sources = useMemo(() => cardImageSources(listing), [listing]);
  const [pos, setPos] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const exhausted = useRef(false);

  const fail = useCallback(
    (at: number) => {
      const src = sources[at];
      if (!src || !src.remote) return; // data-URIs don't fail; ignore stale events
      track({
        type: 'deck_image_error',
        props: { position: Math.max(0, Math.min(src.position, 19)) },
      });
      const next = at + 1;
      if (next < sources.length) {
        setPos(next);
        setLoaded(false);
        // moved onto the synthetic fallback → every real image is dead
        if (!sources[next].remote && sources[next].position === -1 && !exhausted.current) {
          exhausted.current = true;
          onExhausted?.(listing.id);
        }
      }
    },
    [sources, onExhausted, listing.id],
  );

  /* slow-load timeout: a stall counts as a failure (active card only) */
  useEffect(() => {
    if (loaded || !active || !sources[pos]?.remote) return;
    const t = setTimeout(() => fail(pos), SLOW_LOAD_MS);
    return () => clearTimeout(t);
  }, [pos, loaded, active, sources, fail]);

  const src = sources[pos];
  return (
    <>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {src && (
        <img
          src={src.url}
          alt={listing.title}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => fail(pos)}
          className={`h-full w-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </>
  );
}

function SwipeCard({
  item,
  className,
  active = false,
  onImagesExhausted,
}: {
  item: RankedListing;
  className?: string;
  active?: boolean;
  onImagesExhausted?: (listingId: string) => void;
}) {
  const { listing, hem } = item;
  return (
    <div className={`overflow-hidden rounded-3xl bg-parchment shadow-lift ${className ?? ''}`}>
      <div className="relative h-full">
        <CardImage
          key={listing.id}
          listing={listing}
          active={active}
          onExhausted={onImagesExhausted}
        />
        <SourceBadge sourceId={listing.sourceId} brand={listing.brand} className="absolute top-3 left-3" />
        <div className="absolute right-0 bottom-0 left-0 bg-gradient-to-t from-ink/80 via-ink/30 to-transparent p-4 pt-12">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-semibold tracking-widest text-cream/85 uppercase">
              {listing.brand ?? 'One of a kind'}
            </span>
            <span className="font-display text-lg text-cream">{formatPrice(listing.priceCents, listing.currency)}</span>
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
        <span className="font-semibold">{formatPrice(listing.priceCents, listing.currency)}</span>
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
