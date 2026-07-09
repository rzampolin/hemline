/**
 * Swipe-deck sampling (PRODUCT_SPEC E1): the deck exists to harvest
 * calibration signal, so it must be diversity-sampled — a monoculture deck
 * teaches the taste vector nothing.
 *
 * 2026-07-09 (docs/decisions-matching.md): the sampler now stratifies
 * explicitly across SOURCES and BRANDS (round-robin over sources, and over
 * each source's brand queues — so a store whose "brands" are collection
 * labels can't flood the deck), preferring an unseen silhouette, then an
 * unseen length|silhouette|color combo, within each brand's turn. Ranked
 * order is preserved inside every brand queue. A 12-card deck therefore shows
 * min(#brands, 12) distinct brands even when the upstream pool is skewed by
 * one store's crawl.
 */
import type { RankedListing } from '@hemline/contracts';

export const DECK_SIZE = 12;

/** Brand key: normalized brand, falling back to source so brandless items group per store. */
function brandKey(item: RankedListing): string {
  const brand = item.listing.brand?.trim().toLowerCase();
  return brand ? brand : `source:${item.listing.sourceId}`;
}

function silhouetteKey(item: RankedListing): string {
  return item.listing.silhouette ?? 'unknown';
}

function comboKey(item: RankedListing): string {
  const l = item.listing;
  return `${l.lengthClass}|${l.silhouette}|${l.colors[0]?.family}`;
}

/** Rotating cursor over a source's brand queues. */
interface SourceQueues {
  brandQueues: RankedListing[][];
  cursor: number;
}

/**
 * Diversity-sample `n` cards across source, brand, silhouette, length and
 * color. Two-level round-robin (sources → each source's brands, both in
 * first-appearance = rank order); within a brand's turn, prefer an unseen
 * silhouette, then an unseen length|silhouette|color combo, then the brand's
 * best remaining card.
 */
export function sampleDeck(items: RankedListing[], n: number): RankedListing[] {
  // source → brand → ranked queue (insertion order = rank order throughout)
  const bySource = new Map<string, Map<string, RankedListing[]>>();
  for (const item of items) {
    let brands = bySource.get(item.listing.sourceId);
    if (!brands) {
      brands = new Map();
      bySource.set(item.listing.sourceId, brands);
    }
    const key = brandKey(item);
    const q = brands.get(key);
    if (q) q.push(item);
    else brands.set(key, [item]);
  }
  const sources: SourceQueues[] = [...bySource.values()].map((brands) => ({
    brandQueues: [...brands.values()],
    cursor: 0,
  }));

  const picked: RankedListing[] = [];
  const seenSilhouettes = new Set<string>();
  const seenCombos = new Set<string>();

  const pickFrom = (q: RankedListing[]): RankedListing => {
    let idx = q.findIndex((it) => !seenSilhouettes.has(silhouetteKey(it)));
    if (idx === -1) idx = q.findIndex((it) => !seenCombos.has(comboKey(it)));
    if (idx === -1) idx = 0;
    const [item] = q.splice(idx, 1);
    seenSilhouettes.add(silhouetteKey(item));
    seenCombos.add(comboKey(item));
    return item;
  };

  while (picked.length < n) {
    let progressed = false;
    for (const source of sources) {
      if (picked.length >= n) break;
      // this source's turn: next non-empty brand queue in rotation
      for (let step = 0; step < source.brandQueues.length; step++) {
        const q = source.brandQueues[source.cursor % source.brandQueues.length];
        source.cursor++;
        if (q.length === 0) continue;
        picked.push(pickFrom(q));
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return picked;
}
