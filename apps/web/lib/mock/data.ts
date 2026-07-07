/**
 * Mock catalog — derived from packages/connectors/src/fixtures/listings.json
 * by scripts/derive-mock-listings.mjs (run it to refresh). Freshness offsets
 * are converted to epoch ms at module load so the feed always looks live.
 */
import type { Listing } from '@hemline/contracts';
import raw from './mock-listings.json';

interface MockEntry {
  listing: Omit<Listing, 'lastSeenAt' | 'firstSeenAt'>;
  lastSeenHoursAgo: number;
  firstSeenDaysAgo: number;
  attributeVector: Record<string, number>;
}

const NOW = Date.now();

export interface CatalogEntry {
  listing: Listing;
  attributeVector: Record<string, number>;
}

export const CATALOG: CatalogEntry[] = (raw as unknown as MockEntry[]).map((e) => ({
  listing: {
    ...e.listing,
    lastSeenAt: NOW - e.lastSeenHoursAgo * 3_600_000,
    firstSeenAt: NOW - e.firstSeenDaysAgo * 86_400_000,
  } as Listing,
  attributeVector: e.attributeVector,
}));

export const BY_ID = new Map(CATALOG.map((e) => [e.listing.id, e]));

/** Sparse-vector cosine similarity (attribute vectors / learned styleTags). */
export function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k in a) {
    na += a[k] * a[k];
    if (k in b) dot += a[k] * b[k];
  }
  for (const k in b) nb += b[k] * b[k];
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Rough hex → color-family mapping so palette hexes can match listing color families. */
export function hexToFamily(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.08) {
    if (l > 0.88) return 'white';
    if (l < 0.16) return 'black';
    return 'gray';
  }
  let hue = 0;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  const sat = d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.25 && l < 0.45 && hue >= 15 && hue <= 75) return 'brown';
  if (hue < 15 || hue >= 345) return l > 0.75 ? 'pink' : 'red';
  if (hue < 42) return l < 0.4 ? 'brown' : 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 255) return 'blue';
  if (hue < 300) return 'purple';
  return 'pink';
}
