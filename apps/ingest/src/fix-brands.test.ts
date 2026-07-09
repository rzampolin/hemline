/**
 * Brand-fix migration tests: a temp db seeded with the real production junk
 * (christydawn SP26B, staud collection labels, PUP codes, sisterjane
 * collections) PLUS extraction + embedding rows keyed by content_hash —
 * proving the migration corrects brands without orphaning either table,
 * is dry-run by default, and is idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { contentHashFor, type Db } from '@hemline/db';
import { fixBrands, formatBrandFixReport } from './fix-brands';
import { createTestDb } from './testing/test-db';

let db: Db;
let cleanup: () => void;

interface SeedListing {
  sourceId: string;
  listingId: string;
  brand: string | null;
  title?: string;
}

const SEED: SeedListing[] = [
  { sourceId: 'shopify:christydawn.com', listingId: 'cd1', brand: 'SP26B' },
  { sourceId: 'shopify:christydawn.com', listingId: 'cd2', brand: 'SP25' },
  {
    sourceId: 'shopify:christydawn.com',
    listingId: 'cd3',
    brand: 'OSHADI COLLECTIVE (OPC) PRIVATE LIMITED',
  },
  { sourceId: 'shopify:staud.clothing', listingId: 'st1', brand: 'STAUD FALL 2023' },
  { sourceId: 'shopify:staud.clothing', listingId: 'st2', brand: 'STAUD HOLIDAY SALE 2024' },
  { sourceId: 'shopify:staud.clothing', listingId: 'st3', brand: 'STAUD' }, // already correct
  { sourceId: 'shopify:petalandpup.com', listingId: 'pp1', brand: 'PUP129' },
  { sourceId: 'shopify:petalandpup.com', listingId: 'pp2', brand: 'pup3' },
  { sourceId: 'shopify:sisterjane.com', listingId: 'sj1', brand: 'Playback by Ghospell' },
  { sourceId: 'shopify:sisterjane.com', listingId: 'sj2', brand: 'DREAM Voyage Voyage' },
  { sourceId: 'jsonld:lulus.com', listingId: 'lu1', brand: 'Free People' }, // multi-brand: kept
  { sourceId: 'jsonld:lulus.com', listingId: 'lu2', brand: 'LU123' },
  { sourceId: 'ebay', listingId: 'eb1', brand: 'Gunne Sax' }, // never touched
];

function hashFor(l: SeedListing): string {
  return contentHashFor({
    title: l.title ?? `Dress ${l.listingId}`,
    description: 'desc',
    priceCents: 12800,
    imageUrls: [`https://cdn.test/${l.listingId}.jpg`],
    sizeLabels: ['S', 'M'],
  });
}

beforeEach(() => {
  ({ db, cleanup } = createTestDb());
  const sourceIds = [...new Set(SEED.map((l) => l.sourceId))];
  for (const sid of sourceIds) {
    db.run(
      sql`INSERT INTO sources (id, kind, display_name, cadence_cron) VALUES (${sid}, ${sid.split(':')[0]}, ${sid}, '0 6 * * *')`,
    );
  }
  for (const l of SEED) {
    const id = `${l.sourceId}:${l.listingId}`;
    const hash = hashFor(l);
    db.run(
      sql`INSERT INTO listings (id, source_id, source_listing_id, source_url, title, brand, price_cents, currency, content_hash, first_seen_at, last_seen_at)
          VALUES (${id}, ${l.sourceId}, ${l.listingId}, ${'https://x.test/' + l.listingId}, ${l.title ?? `Dress ${l.listingId}`}, ${l.brand}, 12800, 'USD', ${hash}, 1, 1)`,
    );
    // every listing has a cached extraction (~$20 of Haiku) and a vector
    db.run(
      sql`INSERT INTO extractions (content_hash, listing_id, model, extracted_at) VALUES (${hash}, ${id}, 'claude-haiku-4-5-20251001', 1)`,
    );
    db.run(
      sql`INSERT INTO listing_embeddings (content_hash, model, listing_id, dim, vector, embedded_at)
          VALUES (${hash}, 'marqo-fashionSigLIP', ${id}, 4, ${Buffer.from(new Float32Array([1, 0, 0, 0]).buffer)}, 1)`,
    );
  }
});

afterEach(() => cleanup());

const brandOf = (sourceId: string, listingId: string): string | null =>
  (
    db.get(
      sql`SELECT brand FROM listings WHERE id = ${`${sourceId}:${listingId}`}`,
    ) as { brand: string | null }
  ).brand;

describe('fixBrands', () => {
  it('dry-run (default) reports the rewrites but writes nothing', () => {
    const report = fixBrands(db);
    expect(report.applied).toBe(false);
    expect(report.changed).toBe(10); // everything except st3, lu1, and ebay
    expect(brandOf('shopify:christydawn.com', 'cd1')).toBe('SP26B'); // untouched
    expect(report.perStore['shopify:staud.clothing']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ before: 'STAUD FALL 2023', after: 'STAUD', count: 1 }),
      ]),
    );
    const text = formatBrandFixReport(report);
    expect(text).toContain('DRY RUN');
    expect(text).toContain('"PUP129" -> "Petal & Pup"');
  });

  it('--apply rewrites every junk brand via the connector strategy', () => {
    const report = fixBrands(db, { apply: true });
    expect(report.applied).toBe(true);
    expect(report.changed).toBe(10);

    expect(brandOf('shopify:christydawn.com', 'cd1')).toBe('Christy Dawn');
    expect(brandOf('shopify:christydawn.com', 'cd2')).toBe('Christy Dawn');
    expect(brandOf('shopify:christydawn.com', 'cd3')).toBe('Christy Dawn');
    expect(brandOf('shopify:staud.clothing', 'st1')).toBe('STAUD');
    expect(brandOf('shopify:staud.clothing', 'st2')).toBe('STAUD');
    expect(brandOf('shopify:staud.clothing', 'st3')).toBe('STAUD');
    expect(brandOf('shopify:petalandpup.com', 'pp1')).toBe('Petal & Pup');
    expect(brandOf('shopify:petalandpup.com', 'pp2')).toBe('Petal & Pup');
    expect(brandOf('shopify:sisterjane.com', 'sj1')).toBe('Ghospell');
    expect(brandOf('shopify:sisterjane.com', 'sj2')).toBe('Sister Jane');
    // multi-brand store: genuine third-party vendor preserved, code fixed
    expect(brandOf('jsonld:lulus.com', 'lu1')).toBe('Free People');
    expect(brandOf('jsonld:lulus.com', 'lu2')).toBe('Lulus');
    // non-store sources are never touched
    expect(brandOf('ebay', 'eb1')).toBe('Gunne Sax');
  });

  it('never orphans extractions or embeddings (content_hash untouched)', () => {
    const hashesBefore = db.all(sql`SELECT id, content_hash FROM listings ORDER BY id`);
    const report = fixBrands(db, { apply: true });

    expect(report.integrity.extractionsAfter).toBe(SEED.length);
    expect(report.integrity.embeddingsAfter).toBe(SEED.length);
    expect(report.integrity.orphanedExtractions).toBe(0);
    expect(report.integrity.orphanedEmbeddings).toBe(0);

    // content hashes byte-for-byte identical → the caches stay warm
    const hashesAfter = db.all(sql`SELECT id, content_hash FROM listings ORDER BY id`);
    expect(hashesAfter).toEqual(hashesBefore);
    const stillJoined = db.get(
      sql`SELECT COUNT(*) AS n FROM extractions e JOIN listings l ON l.content_hash = e.content_hash`,
    ) as { n: number };
    expect(stillJoined.n).toBe(SEED.length);
    const vectorsJoined = db.get(
      sql`SELECT COUNT(*) AS n FROM listing_embeddings e JOIN listings l ON l.content_hash = e.content_hash`,
    ) as { n: number };
    expect(vectorsJoined.n).toBe(SEED.length);
  });

  it('is idempotent: a second apply finds nothing to do', () => {
    fixBrands(db, { apply: true });
    const second = fixBrands(db, { apply: true });
    expect(second.changed).toBe(0);
    expect(second.perStore).toEqual({});
  });

  it('re-ingesting a migrated listing computes the same content_hash (no churn)', () => {
    // brand is not part of the recipe — identical inputs, identical hash
    const before = hashFor(SEED[0]);
    fixBrands(db, { apply: true });
    expect(hashFor(SEED[0])).toBe(before);
  });
});
