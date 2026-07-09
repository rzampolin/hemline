import { describe, expect, it } from 'vitest';
import type { Listing, RankedListing, Silhouette } from '@hemline/contracts';
import { DECK_SIZE, sampleDeck } from './deck';

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
