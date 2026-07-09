/**
 * Fixture corpus conformance — every fixture entry must satisfy the frozen
 * contracts, since seed, tests, and the zero-key demo all depend on it.
 */
import { describe, expect, it } from 'vitest';
import { ExtractedAttributesSchema, RawListingSchema } from '@hemline/contracts';
import { loadFixtureEntries } from './index';

describe('fixture listings', () => {
  const entries = loadFixtureEntries();

  it('contains 151 listings', () => {
    // 150 original + 1 GBP-priced entry (QA P1 #3: currency handling must be
    // exercised by the zero-key corpus — display £, filter in USD-equivalent)
    expect(entries).toHaveLength(151);
  });

  it('includes a non-USD (GBP) listing so currency handling stays exercised', () => {
    expect(entries.some((e) => e.raw.currency === 'GBP')).toBe(true);
  });

  it('every raw listing satisfies RawListingSchema', () => {
    for (const e of entries) {
      const res = RawListingSchema.safeParse(e.raw);
      expect(res.success, `invalid RawListing: ${e.raw.sourceListingId}`).toBe(true);
    }
  });

  it('every pre-baked extraction satisfies ExtractedAttributesSchema', () => {
    for (const e of entries) {
      const res = ExtractedAttributesSchema.safeParse(e.extraction);
      expect(res.success, `invalid extraction: ${e.raw.sourceListingId}`).toBe(true);
    }
  });

  it('mixes fixture:shopify and fixture:ebay sources', () => {
    const shopify = entries.filter((e) => e.raw.sourceId === 'fixture:shopify');
    const ebay = entries.filter((e) => e.raw.sourceId === 'fixture:ebay');
    expect(shopify.length).toBeGreaterThan(50);
    expect(ebay.length).toBeGreaterThan(50);
  });

  it('meets moat coverage targets (≥85% length-classified, some unknown)', () => {
    const classified = entries.filter((e) => e.extraction.lengthClass != null);
    const measured = entries.filter((e) => e.extraction.lengthInches != null);
    const unknown = entries.filter(
      (e) => e.extraction.lengthClass == null && e.extraction.lengthInches == null,
    );
    expect(classified.length / entries.length).toBeGreaterThanOrEqual(0.85);
    expect(measured.length / entries.length).toBeGreaterThanOrEqual(0.4);
    expect(unknown.length).toBeGreaterThan(0); // "Length unverified" path must be exercised
  });

  it('has unique listing ids and freshness offsets', () => {
    const ids = new Set(entries.map((e) => `${e.raw.sourceId}:${e.raw.sourceListingId}`));
    expect(ids.size).toBe(entries.length);
    for (const e of entries) {
      expect(e.lastSeenHoursAgo).toBeGreaterThanOrEqual(0);
      expect(e.firstSeenDaysAgo).toBeGreaterThan(0);
      expect(e.sizeNormalized.length).toBeGreaterThan(0);
    }
  });
});
