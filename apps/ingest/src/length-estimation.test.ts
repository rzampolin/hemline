/**
 * Length-estimation queue tests: idempotent selection + in-place updates with
 * a mocked estimator (Task 2, 2026-07-07).
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@hemline/contracts';
import type { LengthEstimator } from '@hemline/ai';
import { extractions, listingImages, listings, sources, type Db } from '@hemline/db';
import {
  buildLengthEstimateTargets,
  lengthCoverage,
  runLengthEstimation,
} from './length-estimation';
import { createTestDb } from './testing/test-db';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let db: Db;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = createTestDb()));
afterEach(() => cleanup());

interface SeedRow {
  id: string;
  lengthInches?: number | null;
  lengthBasis?: string | null;
  lengthClass?: string | null;
  model?: string;
  image?: boolean;
  removed?: boolean;
}

function seed(rows: SeedRow[]): void {
  db.insert(sources)
    .values({ id: 'src', kind: 'test', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
  for (const row of rows) {
    db.insert(listings)
      .values({
        id: `src:${row.id}`,
        sourceId: 'src',
        sourceListingId: row.id,
        sourceUrl: `https://example.com/${row.id}`,
        title: `Dress ${row.id}`,
        priceCents: 100,
        currency: 'USD',
        contentHash: `hash-${row.id}`,
        firstSeenAt: 1000,
        lastSeenAt: 1000,
        removedAt: row.removed ? 2000 : null,
      })
      .run();
    if (row.image !== false) {
      db.insert(listingImages)
        .values({ listingId: `src:${row.id}`, url: `https://cdn/${row.id}.jpg`, position: 0 })
        .run();
    }
    db.insert(extractions)
      .values({
        contentHash: `hash-${row.id}`,
        listingId: `src:${row.id}`,
        model: row.model ?? 'claude-haiku-4-5-20251001',
        lengthClass: row.lengthClass ?? 'midi',
        lengthInches: row.lengthInches ?? null,
        lengthBasis: row.lengthBasis ?? null,
        extractedAt: 1000,
      })
      .run();
  }
}

function fakeEstimator(
  outcome: (hash: string) => Awaited<ReturnType<LengthEstimator['estimateOne']>>,
): LengthEstimator & { estimateOne: ReturnType<typeof vi.fn> } {
  const stats = { calls: 0, estimated: 0, clamped: 0, noEstimate: 0, failed: 0 };
  return {
    mode: 'live',
    stats,
    costUsd: () => 0.001 * stats.calls,
    estimateOne: vi.fn(async (input: { contentHash: string }) => {
      stats.calls += 1;
      return outcome(input.contentHash);
    }),
  };
}

const estimated = (inches: number) =>
  ({
    status: 'estimated',
    lengthInches: inches,
    rawLengthInches: inches,
    modelConfidence: 0.8,
    reasoning: null,
  }) as const;

describe('buildLengthEstimateTargets — idempotent selection', () => {
  it('targets only rows missing inches, un-attempted, live, imaged, and unprotected', () => {
    seed([
      { id: 'eligible' },
      { id: 'has-inches', lengthInches: 39 }, // already has a length
      { id: 'attempted', lengthBasis: 'image_estimate' }, // prior attempt (clamped/no-estimate)
      { id: 'no-image', image: false },
      { id: 'removed', removed: true },
      { id: 'manual-row', model: 'manual' }, // human QA protected
      { id: 'fixture-row', model: 'fixture' }, // seed ground truth protected
    ]);
    const targets = buildLengthEstimateTargets(db);
    expect(targets.map((t) => t.listingId)).toEqual(['src:eligible']);
    expect(targets[0]).toMatchObject({
      contentHash: 'hash-eligible',
      primaryImageUrl: 'https://cdn/eligible.jpg',
      title: 'Dress eligible',
      lengthClass: 'midi',
    });
  });

  it('is idempotent: after a run, re-selection is empty (mocked service, no double spend)', async () => {
    seed([{ id: 'a' }, { id: 'b' }]);
    const estimator = fakeEstimator(() => estimated(43));
    await runLengthEstimation(db, buildLengthEstimateTargets(db), estimator, silent);
    expect(estimator.estimateOne).toHaveBeenCalledTimes(2);

    // second run: nothing selected, nothing called
    const again = buildLengthEstimateTargets(db);
    expect(again).toHaveLength(0);
    const estimator2 = fakeEstimator(() => estimated(43));
    await runLengthEstimation(db, again, estimator2, silent);
    expect(estimator2.estimateOne).not.toHaveBeenCalled();
  });
});

describe('runLengthEstimation — in-place updates', () => {
  it('writes inches + image_estimate basis for sane estimates', async () => {
    seed([{ id: 'a' }]);
    await runLengthEstimation(db, buildLengthEstimateTargets(db), fakeEstimator(() => estimated(43.5)), silent);
    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-a')).get()!;
    expect(row.lengthInches).toBe(43.5);
    expect(row.lengthBasis).toBe('image_estimate');
  });

  it('clamped estimates keep the class prior: basis marked, inches stay NULL', async () => {
    seed([{ id: 'a', lengthClass: 'mini' }]);
    await runLengthEstimation(
      db,
      buildLengthEstimateTargets(db),
      fakeEstimator(() => ({
        status: 'clamped',
        lengthInches: null,
        rawLengthInches: 55,
        modelConfidence: 0.2,
        reasoning: null,
      })),
      silent,
    );
    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-a')).get()!;
    expect(row.lengthInches).toBeNull(); // class prior still drives the hem
    expect(row.lengthBasis).toBe('image_estimate'); // but never re-billed
  });

  it('failed calls stay queued (resumable) and an all-failure wave stops the run', async () => {
    seed([{ id: 'a' }, { id: 'b' }]);
    const failing = fakeEstimator(() => ({
      status: 'failed',
      lengthInches: null,
      rawLengthInches: null,
      modelConfidence: 0,
      reasoning: null,
      error: 'budget cap',
    }));
    const result = await runLengthEstimation(db, buildLengthEstimateTargets(db), failing, silent, {
      concurrency: 2,
    });
    expect(result.stopped).toBe(true);
    expect(result.failed).toBe(2);
    // nothing marked → both rows re-selected on resume
    expect(buildLengthEstimateTargets(db)).toHaveLength(2);
  });

  it('honors shouldStop before spending (budget cap pattern)', async () => {
    seed([{ id: 'a' }]);
    const estimator = fakeEstimator(() => estimated(40));
    const result = await runLengthEstimation(db, buildLengthEstimateTargets(db), estimator, silent, {
      shouldStop: () => true,
    });
    expect(result.stopped).toBe(true);
    expect(estimator.estimateOne).not.toHaveBeenCalled();
  });

  it('lengthCoverage splits stated vs image-estimated', async () => {
    seed([
      { id: 'stated', lengthInches: 39, lengthBasis: 'stated' },
      { id: 'legacy-stated', lengthInches: 44 }, // NULL basis counts as stated
      { id: 'to-estimate' },
    ]);
    await runLengthEstimation(db, buildLengthEstimateTargets(db), fakeEstimator(() => estimated(41)), silent);
    const c = lengthCoverage(db);
    expect(c).toMatchObject({ liveListings: 3, withInches: 3, stated: 2, imageEstimated: 1 });
  });
});
