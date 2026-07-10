import { describe, expect, it } from 'vitest';
import type { Listing, RankedListing, Silhouette, SwipeEvent } from '@hemline/contracts';
import {
  DECK_CARD_CAP,
  DECK_EXTENSION_SIZE,
  DECK_LIKE_TARGET,
  DECK_SIZE,
  deckCompletionReason,
  deriveExclusions,
  exploredAttributes,
  nextBatchSize,
  positiveCount,
  sampleDeck,
} from './deck';

const SILHOUETTES: Silhouette[] = ['slip', 'a_line', 'wrap', 'sheath', 'fit_and_flare', 'shirt'];

function ranked(
  id: string,
  brand: string | null,
  overrides: Partial<Listing> = {},
): RankedListing {
  const listing: Listing = {
    id,
    sourceId: 'shopify:test.com',
    sourceUrl: `https://example.com/${id}`,
    affiliateUrl: null,
    title: `Dress ${id}`,
    brand,
    priceCents: 15000,
    currency: 'USD',
    images: [],
    sizeLabels: ['8'],
    sizeNormalized: [8],
    availability: {},
    condition: 'new',
    isVintage: false,
    era: null,
    colors: [{ name: 'navy', family: 'blue', hex: '#000080' }],
    lengthClass: 'midi',
    lengthInches: 44,
    measurements: { bust: null, waist: null, hip: null, length: 44 },
    fabric: 'silk',
    neckline: 'v_neck',
    silhouette: 'slip',
    extractionConfidence: 0.9,
    lastSeenAt: 1_750_000_000_000,
    firstSeenAt: 1_749_000_000_000,
    ...overrides,
  };
  return {
    listing,
    hem: { position: 'mid_calf', hemAboveFloorInches: 14, basis: 'measured_length', confidence: 'high' },
    score: 0.5,
    whyItWorks: null,
    freshnessDecay: 0.9,
  };
}

describe('sampleDeck — brand AND silhouette stratification (E1)', () => {
  it('monoculture pool of 48 with 4 brands → deck of 12 has ≥4 brands', () => {
    // shape the deck actually sees post-crawl: 36 of brand A ranked first
    const items: RankedListing[] = [];
    for (let i = 0; i < 36; i++) {
      items.push(ranked(`a${i}`, 'Brand A', { silhouette: SILHOUETTES[i % 6] }));
    }
    for (const b of ['Brand B', 'Brand C', 'Brand D']) {
      for (let i = 0; i < 4; i++) {
        items.push(ranked(`${b}-${i}`, b, { silhouette: SILHOUETTES[i % 6] }));
      }
    }
    const deck = sampleDeck(items, DECK_SIZE);
    expect(deck).toHaveLength(DECK_SIZE);
    const brands = new Set(deck.map((d) => d.listing.brand));
    expect(brands.size).toBeGreaterThanOrEqual(4);
  });

  it('stratifies across silhouettes too, not just brands', () => {
    const items: RankedListing[] = [];
    for (let i = 0; i < 24; i++) {
      items.push(
        ranked(`x${i}`, `Brand ${i % 4}`, { silhouette: SILHOUETTES[Math.floor(i / 4) % 6] }),
      );
    }
    const deck = sampleDeck(items, DECK_SIZE);
    const silhouettes = new Set(deck.map((d) => d.listing.silhouette));
    expect(silhouettes.size).toBeGreaterThanOrEqual(4);
  });

  it('single-brand pool still fills the deck (variety by silhouette/length/color)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      ranked(`a${i}`, 'Only Brand', {
        silhouette: SILHOUETTES[i % 6],
        lengthClass: i % 2 ? 'midi' : 'mini',
      }),
    );
    const deck = sampleDeck(items, DECK_SIZE);
    expect(deck).toHaveLength(DECK_SIZE);
  });

  it('short pool: returns everything without duplicates', () => {
    const items = [ranked('a', 'A'), ranked('b', 'B'), ranked('c', null)];
    const deck = sampleDeck(items, DECK_SIZE);
    expect(deck).toHaveLength(3);
    expect(new Set(deck.map((d) => d.listing.id)).size).toBe(3);
  });

  it('brandless items group by source, not into one anonymous mega-brand per item', () => {
    const items = [
      ranked('s1a', null, { sourceId: 'shopify:one.com' }),
      ranked('s1b', null, { sourceId: 'shopify:one.com' }),
      ranked('s2a', null, { sourceId: 'shopify:two.com' }),
    ];
    const deck = sampleDeck(items, 2);
    const sources = new Set(deck.map((d) => d.listing.sourceId));
    expect(sources.size).toBe(2);
  });

  it('a store with noisy collection labels cannot flood the deck (source round-robin)', () => {
    const items: RankedListing[] = [];
    for (let i = 0; i < 36; i++) {
      items.push(
        ranked(`n${i}`, `Collection ${i}`, {
          sourceId: 'shopify:noisy.com',
          silhouette: SILHOUETTES[i % 6],
        }),
      );
    }
    for (let i = 0; i < 12; i++) {
      items.push(
        ranked(`h${i}`, 'Honest Brand', {
          sourceId: 'shopify:honest.com',
          silhouette: SILHOUETTES[i % 6],
        }),
      );
    }
    const deck = sampleDeck(items, DECK_SIZE);
    const noisy = deck.filter((d) => d.listing.sourceId === 'shopify:noisy.com').length;
    expect(noisy).toBe(DECK_SIZE / 2); // strict source round-robin: half each
  });

  it('rank order preserved within a brand (best card of each brand first)', () => {
    const items = [
      ranked('a0', 'A'),
      ranked('a1', 'A', { silhouette: 'wrap' }),
      ranked('b0', 'B'),
    ];
    const deck = sampleDeck(items, 3);
    expect(deck[0].listing.id).toBe('a0');
    expect(deck.findIndex((d) => d.listing.id === 'a0')).toBeLessThan(
      deck.findIndex((d) => d.listing.id === 'a1'),
    );
  });
});

/* ── adaptive calibration (2026-07-10, docs/decisions-deck.md) ───────────── */

function swipes(...verdicts: SwipeEvent['verdict'][]): SwipeEvent[] {
  return verdicts.map((verdict, i) => ({
    listingId: `l${i}`,
    verdict,
    context: 'calibration' as const,
  }));
}

describe('positiveCount — likes + saves are the signal', () => {
  it('counts likes and saves, ignores dislikes and skips', () => {
    expect(positiveCount(swipes('like', 'save', 'dislike', 'skip', 'like'))).toBe(3);
    expect(positiveCount([])).toBe(0);
  });
});

describe('deckCompletionReason — positive-signal completion', () => {
  it('2 likes is not a style: keeps going after a full batch with few likes', () => {
    expect(deckCompletionReason(2, DECK_SIZE)).toBeNull();
  });

  it('completes on the like target', () => {
    expect(deckCompletionReason(DECK_LIKE_TARGET, 7)).toBe('target');
    expect(deckCompletionReason(DECK_LIKE_TARGET + 3, 20)).toBe('target');
  });

  it('never traps the user: completes at the card cap even with zero likes', () => {
    expect(deckCompletionReason(0, DECK_CARD_CAP)).toBe('cap');
    expect(deckCompletionReason(0, DECK_CARD_CAP + 5)).toBe('cap');
  });

  it('target wins over cap when both hold', () => {
    expect(deckCompletionReason(DECK_LIKE_TARGET, DECK_CARD_CAP)).toBe('target');
  });
});

describe('nextBatchSize — extension batches trimmed to the cap', () => {
  it('full extension while far from the cap', () => {
    expect(nextBatchSize(DECK_SIZE)).toBe(DECK_EXTENSION_SIZE);
  });

  it('12 → 19 → 26 → 30: the last batch is trimmed, never overshooting', () => {
    let seen = DECK_SIZE;
    const batches: number[] = [];
    while (seen < DECK_CARD_CAP) {
      const b = nextBatchSize(seen);
      batches.push(b);
      seen += b;
    }
    expect(batches).toEqual([7, 7, 4]);
    expect(seen).toBe(DECK_CARD_CAP);
  });

  it('at/past the cap yields zero', () => {
    expect(nextBatchSize(DECK_CARD_CAP)).toBe(0);
    expect(nextBatchSize(DECK_CARD_CAP + 3)).toBe(0);
  });
});

describe('deriveExclusions — ≥2 dislikes on an attribute, unless also liked', () => {
  const byId = (items: RankedListing[]) => new Map(items.map((i) => [i.listing.id, i]));

  it('excludes a silhouette after two dislikes with no likes', () => {
    const items = [
      ranked('l0', 'A', { silhouette: 'slip' }),
      ranked('l1', 'B', { silhouette: 'slip' }),
      ranked('l2', 'C', { silhouette: 'wrap' }),
    ];
    const events: SwipeEvent[] = [
      { listingId: 'l0', verdict: 'dislike', context: 'calibration' },
      { listingId: 'l1', verdict: 'dislike', context: 'calibration' },
      { listingId: 'l2', verdict: 'like', context: 'calibration' },
    ];
    const ex = deriveExclusions(events, byId(items));
    expect(ex.silhouettes.has('slip')).toBe(true);
    expect(ex.silhouettes.has('wrap')).toBe(false);
  });

  it('a single dislike is not a pattern', () => {
    const items = [ranked('l0', 'A', { silhouette: 'sheath' })];
    const events: SwipeEvent[] = [{ listingId: 'l0', verdict: 'dislike', context: 'calibration' }];
    expect(deriveExclusions(events, byId(items)).silhouettes.size).toBe(0);
  });

  it('mixed signal is never excluded (2 dislikes + 1 like on the same silhouette)', () => {
    const items = [
      ranked('l0', 'A', { silhouette: 'slip' }),
      ranked('l1', 'B', { silhouette: 'slip' }),
      ranked('l2', 'C', { silhouette: 'slip' }),
    ];
    const events: SwipeEvent[] = [
      { listingId: 'l0', verdict: 'dislike', context: 'calibration' },
      { listingId: 'l1', verdict: 'dislike', context: 'calibration' },
      { listingId: 'l2', verdict: 'save', context: 'calibration' },
    ];
    expect(deriveExclusions(events, byId(items)).silhouettes.size).toBe(0);
  });

  it('excludes a heavily-disliked primary color family', () => {
    const red = { name: 'crimson', family: 'red', hex: '#dc143c' };
    const items = [
      ranked('l0', 'A', { colors: [red], silhouette: 'slip' }),
      ranked('l1', 'B', { colors: [red], silhouette: 'wrap' }),
    ];
    const events: SwipeEvent[] = [
      { listingId: 'l0', verdict: 'dislike', context: 'calibration' },
      { listingId: 'l1', verdict: 'dislike', context: 'calibration' },
    ];
    const ex = deriveExclusions(events, byId(items));
    expect(ex.colorFamilies.has('red')).toBe(true);
    // one dislike each on slip/wrap — below threshold
    expect(ex.silhouettes.size).toBe(0);
  });

  it('ignores swipes for listings we cannot resolve', () => {
    const events: SwipeEvent[] = [
      { listingId: 'ghost', verdict: 'dislike', context: 'calibration' },
      { listingId: 'ghost2', verdict: 'dislike', context: 'calibration' },
    ];
    const ex = deriveExclusions(events, new Map());
    expect(ex.silhouettes.size).toBe(0);
    expect(ex.colorFamilies.size).toBe(0);
  });
});

describe('sampleDeck options — exclusion + exploration bias (additive)', () => {
  it('excluded silhouettes are filtered out when the pool can afford it', () => {
    const items: RankedListing[] = [];
    for (let i = 0; i < 12; i++) items.push(ranked(`s${i}`, `B${i % 4}`, { silhouette: 'slip' }));
    for (let i = 0; i < 12; i++) items.push(ranked(`w${i}`, `B${i % 4}`, { silhouette: 'wrap' }));
    const batch = sampleDeck(items, 6, { exclude: { silhouettes: new Set(['slip']) } });
    expect(batch).toHaveLength(6);
    expect(batch.every((d) => d.listing.silhouette === 'wrap')).toBe(true);
  });

  it('excluded color families are filtered out', () => {
    const red = { name: 'red', family: 'red', hex: '#f00' };
    const blue = { name: 'navy', family: 'blue', hex: '#000080' };
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ranked(`r${i}`, `B${i % 3}`, { colors: [red] })),
      ...Array.from({ length: 8 }, (_, i) => ranked(`b${i}`, `B${i % 3}`, { colors: [blue] })),
    ];
    const batch = sampleDeck(items, 5, { exclude: { colorFamilies: new Set(['red']) } });
    expect(batch.every((d) => d.listing.colors[0]?.family === 'blue')).toBe(true);
  });

  it('exclusion is SOFT: a thin pool tops up from excluded items rather than starving', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) => ranked(`w${i}`, `B${i}`, { silhouette: 'wrap' })),
      ...Array.from({ length: 9 }, (_, i) => ranked(`s${i}`, `B${i % 3}`, { silhouette: 'slip' })),
    ];
    const batch = sampleDeck(items, 6, { exclude: { silhouettes: new Set(['slip']) } });
    expect(batch).toHaveLength(6);
    // the non-excluded items all made it in first
    const wraps = batch.filter((d) => d.listing.silhouette === 'wrap');
    expect(wraps).toHaveLength(3);
  });

  it('explored silhouettes are deprioritized: unexplored ones surface first', () => {
    const items = [
      ranked('a0', 'A', { silhouette: 'slip' }),
      ranked('a1', 'A', { silhouette: 'wrap' }),
      ranked('b0', 'B', { silhouette: 'slip' }),
      ranked('b1', 'B', { silhouette: 'sheath' }),
    ];
    const batch = sampleDeck(items, 2, { explored: { silhouettes: ['slip'] } });
    // both picks avoid the already-explored slip
    expect(batch.map((d) => d.listing.silhouette).sort()).toEqual(['sheath', 'wrap']);
  });

  it('no options → identical behavior to the classic sampler', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      ranked(`x${i}`, `Brand ${i % 4}`, { silhouette: SILHOUETTES[i % 6] }),
    );
    expect(sampleDeck(items, DECK_SIZE)).toEqual(sampleDeck(items, DECK_SIZE, {}));
  });
});

describe('exploredAttributes', () => {
  it('collects shown silhouettes and combos', () => {
    const shown = [
      ranked('a', 'A', { silhouette: 'slip' }),
      ranked('b', 'B', { silhouette: 'wrap', lengthClass: 'mini' }),
    ];
    const explored = exploredAttributes(shown);
    expect(explored.silhouettes).toEqual(new Set(['slip', 'wrap']));
    expect(explored.combos.size).toBe(2);
  });
});
