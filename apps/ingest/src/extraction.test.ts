import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedAttributes, Logger } from '@hemline/contracts';
import { extractions, type Db } from '@hemline/db';
import { buildPendingExtractionInputs, deleteMockExtractions, runExtraction } from './extraction';
import { runPipeline } from './pipeline';
import { createTestDb } from './testing/test-db';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const fakeAttrs = (confidence = 0.9): ExtractedAttributes => ({
  lengthClass: 'midi',
  lengthInches: 44,
  measurements: { bust: null, waist: null, hip: null, length: 44 },
  colors: [{ name: 'white', family: 'white', hex: null }],
  fabric: 'linen',
  neckline: 'off_shoulder',
  silhouette: 'a_line',
  sleeve: null,
  pattern: null,
  occasions: ['vacation'],
  attributeVector: { 'length:midi': 1 },
  confidence,
});

vi.mock('@hemline/ai', () => ({
  createExtractionService: vi.fn(),
}));

/** Minimal run-observability shape (ExtractionServiceWithStats additions). */
const emptyStats = () => ({
  liveCalls: 0,
  retries: 0,
  retrySuccesses: 0,
  coercions: 0,
  fallbacks: 0,
  mockExtractions: 0,
  imageUrlFailures: 0,
  imageFetchFailures: 0,
  cacheHits: 0,
});
const withStats = (
  service: import('@hemline/contracts').ExtractionService,
): import('@hemline/ai').ExtractionServiceWithStats => ({
  ...service,
  stats: emptyStats(),
  costUsd: () => 0,
});

let db: Db;
let cleanup: () => void;
beforeEach(async () => {
  ({ db, cleanup } = createTestDb());
  vi.clearAllMocks();
});
afterEach(() => cleanup());

async function seedTwoListings(): Promise<void> {
  await runPipeline(
    db,
    {
      id: 'test-src',
      kind: 'test',
      defaultCadence: '0 6 * * *',
      isConfigured: () => true,
      fetchListings: async () => ({
        listings: [
          {
            sourceId: 'test-src',
            sourceListingId: 'A',
            sourceUrl: 'https://example.com/a',
            title: 'Linen Midi Dress',
            description: 'Breezy.',
            brand: 'B1',
            priceCents: 100,
            currency: 'USD',
            imageUrls: ['https://cdn/a-main.jpg', 'https://cdn/a-alt.jpg'],
            sizeLabels: ['S'],
            availability: { S: true },
            seenAt: 1000,
          },
          {
            sourceId: 'test-src',
            sourceListingId: 'B',
            sourceUrl: 'https://example.com/b',
            title: 'Silk Slip',
            priceCents: 200,
            currency: 'USD',
            imageUrls: [],
            sizeLabels: ['M'],
            seenAt: 1000,
          },
        ],
        stats: { fetched: 2, errors: 0 },
      }),
    },
    { logger: silent, extract: false, embed: false, prune: false },
  );
}

describe('extraction queue', () => {
  it('builds inputs only for listings without an extraction row', async () => {
    await seedTwoListings();
    const inputs = buildPendingExtractionInputs(db, ['test-src']);
    expect(inputs).toHaveLength(2);
    const a = inputs.find((i) => i.listingId === 'test-src:A')!;
    expect(a).toMatchObject({
      title: 'Linen Midi Dress',
      description: 'Breezy.',
      brand: 'B1',
      primaryImageUrl: 'https://cdn/a-main.jpg', // position 0 only
      sizeLabels: ['S'],
    });
    const b = inputs.find((i) => i.listingId === 'test-src:B')!;
    expect(b.primaryImageUrl).toBeNull();
    expect(b.description).toBeNull();
  });

  it('writes extraction rows via the ExtractionService and drains the queue', async () => {
    await seedTwoListings();
    const { createExtractionService } = await import('@hemline/ai');
    vi.mocked(createExtractionService).mockReturnValue(withStats({
      mode: 'mock',
      extractBatch: async (inputs) =>
        new Map(inputs.map((i) => [i.contentHash, fakeAttrs()])),
    }));

    const inputs = buildPendingExtractionInputs(db, ['test-src']);
    const outcome = await runExtraction(db, inputs, silent);
    expect(outcome).toMatchObject({ extracted: 2, pending: 0 });

    const rows = db.select().from(extractions).all();
    expect(rows).toHaveLength(2);
    expect(rows[0].model).toBe('mock');
    expect(rows.map((r) => r.lengthClass)).toEqual(['midi', 'midi']);

    // queue drained: nothing pending, idempotent on re-run
    expect(buildPendingExtractionInputs(db, ['test-src'])).toHaveLength(0);
  });

  it('records the live model name when the service is live', async () => {
    await seedTwoListings();
    const { createExtractionService } = await import('@hemline/ai');
    vi.mocked(createExtractionService).mockReturnValue(withStats({
      mode: 'live',
      extractBatch: async (inputs) =>
        new Map(inputs.map((i) => [i.contentHash, fakeAttrs()])),
    }));
    await runExtraction(db, buildPendingExtractionInputs(db, ['test-src']), silent, {
      EXTRACTION_MODEL: 'claude-haiku-4-5-20251001',
    } as NodeJS.ProcessEnv);
    const row = db.select().from(extractions).all()[0];
    expect(row.model).toBe('claude-haiku-4-5-20251001');
  });

  it('leaves listings pending when the service throws (stub-safe)', async () => {
    await seedTwoListings();
    const { createExtractionService } = await import('@hemline/ai');
    vi.mocked(createExtractionService).mockReturnValue(withStats({
      mode: 'mock',
      extractBatch: async () => {
        throw new Error('not yet implemented (ai-eng)');
      },
    }));

    const inputs = buildPendingExtractionInputs(db, ['test-src']);
    const outcome = await runExtraction(db, inputs, silent);
    expect(outcome).toMatchObject({ extracted: 0, pending: 2 });
    expect(db.select().from(extractions).all()).toHaveLength(0);
    // still queued for the next run
    expect(buildPendingExtractionInputs(db, ['test-src'])).toHaveLength(2);
  });

  it('never overwrites an existing extraction row (ai-eng owns the cache)', async () => {
    await seedTwoListings();
    const { createExtractionService } = await import('@hemline/ai');
    vi.mocked(createExtractionService).mockReturnValue(withStats({
      mode: 'mock',
      extractBatch: async (inputs) =>
        new Map(inputs.map((i) => [i.contentHash, fakeAttrs(0.1)])),
    }));
    const inputs = buildPendingExtractionInputs(db, ['test-src']);
    await runExtraction(db, inputs, silent);

    // simulate ai-eng re-running with better results — our rerun must not clobber
    db.update(extractions).set({ extractionConfidence: 0.95 }).run();
    await runExtraction(db, inputs, silent);
    const rows = db.select().from(extractions).all();
    expect(rows.every((r) => r.extractionConfidence === 0.95)).toBe(true);
  });
});

describe('pipeline extraction integration', () => {
  it('reports pending counts in the run stats', async () => {
    const { createExtractionService } = await import('@hemline/ai');
    vi.mocked(createExtractionService).mockImplementation(() => {
      throw new Error('not yet implemented (ai-eng)');
    });

    const result = await runPipeline(
      db,
      {
        id: 'test-src',
        kind: 'test',
        defaultCadence: '0 6 * * *',
        isConfigured: () => true,
        fetchListings: async () => ({
          listings: [
            {
              sourceId: 'test-src',
              sourceListingId: 'A',
              sourceUrl: 'https://example.com/a',
              title: 'Dress',
              priceCents: 100,
              currency: 'USD',
              imageUrls: [],
              sizeLabels: [],
              seenAt: 1000,
            },
          ],
          stats: { fetched: 1, errors: 0 },
        }),
      },
      { logger: silent, embed: false, prune: false },
    );

    expect(result.status).toBe('ok'); // extraction failure never fails ingest
    expect(result.stats.extracted).toBe(0);
    expect(result.stats.extractionPending).toBe(1);
  });

  it('deleteMockExtractions re-queues mock rows but never manual or fixture rows', async () => {
    await seedTwoListings();
    const { createExtractionService } = await import('@hemline/ai');
    vi.mocked(createExtractionService).mockReturnValue(withStats({
      mode: 'mock',
      extractBatch: async (inputs) =>
        new Map(inputs.map((i) => [i.contentHash, fakeAttrs()])),
    }));
    // both listings get mock rows; then hand-correct listing A (spec G2)
    await runExtraction(db, buildPendingExtractionInputs(db, ['test-src']), silent);
    db.update(extractions)
      .set({ model: 'manual' })
      .where(eq(extractions.listingId, 'test-src:A'))
      .run();

    // upgrade path: only B's mock row is cleared and re-queued
    expect(deleteMockExtractions(db, ['test-src'])).toBe(1);
    const pending = buildPendingExtractionInputs(db, ['test-src']);
    expect(pending.map((p) => p.listingId)).toEqual(['test-src:B']);
    // A's manual correction is untouched
    const rows = db.select().from(extractions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('manual');
    // scoped: other sources' rows are never touched
    expect(deleteMockExtractions(db, ['other-src'])).toBe(0);
  });
});
