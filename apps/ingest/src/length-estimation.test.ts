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
  buildReanchorTargets,
  countNotEstimableRequeue,
  lengthCoverage,
  migrateLengthBookkeeping,
  requeueNotEstimable,
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
  description?: string | null;
  lengthInches?: number | null;
  lengthBasis?: string | null;
  lengthAnchor?: string | null;
  lengthAnchorHeightIn?: number | null;
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
        description: row.description ?? null,
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
        lengthAnchor: row.lengthAnchor ?? null,
        lengthAnchorHeightIn: row.lengthAnchorHeightIn ?? null,
        extractedAt: 1000,
      })
      .run();
  }
}

type EstimateOutcome = Awaited<ReturnType<LengthEstimator['estimateOne']>>;
type OutcomeSeed = Omit<EstimateOutcome, 'anchor' | 'anchorHeightInches'>;

/** Mirrors the real estimator: the anchor is derived from the input. */
function fakeEstimator(
  outcome: (hash: string) => OutcomeSeed,
): LengthEstimator & { estimateOne: ReturnType<typeof vi.fn> } {
  const stats = { calls: 0, estimated: 0, clamped: 0, noEstimate: 0, imageUnavailable: 0, failed: 0 };
  return {
    mode: 'live',
    stats,
    costUsd: () => 0.001 * stats.calls,
    estimateOne: vi.fn(
      async (input: { contentHash: string; statedModelHeightInches?: number | null }) => {
        stats.calls += 1;
        return {
          ...outcome(input.contentHash),
          anchor:
            input.statedModelHeightInches != null
              ? ('stated_model_height' as const)
              : ('assumed_default' as const),
          anchorHeightInches: input.statedModelHeightInches ?? 69,
        };
      },
    ),
  };
}

const estimated = (inches: number): OutcomeSeed => ({
  status: 'estimated',
  lengthInches: inches,
  rawLengthInches: inches,
  modelConfidence: 0.8,
  reasoning: null,
});

describe('buildLengthEstimateTargets — idempotent selection', () => {
  it('targets only rows missing inches, un-attempted, live, imaged, and unprotected', () => {
    seed([
      { id: 'eligible' },
      { id: 'has-inches', lengthInches: 39 }, // already has a length
      { id: 'attempted', lengthBasis: 'not_estimable' }, // prior attempt (clamped/no-estimate)
      { id: 'legacy-attempted', lengthBasis: 'image_estimate' }, // pre-v2 marker, still skipped
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
      statedModelHeightInches: null, // no stated height in the seed text
    });
  });

  it('parses the stated model height + size worn from title/description (free)', () => {
    seed([
      { id: 'staud', description: `Model is 5'10" and wears a size S.` },
      { id: 'rouje', description: 'Our model is 175cm and wears a size 36.' },
      { id: 'plain', description: 'A lovely dress. Length: 175 cm.' }, // garment, not model
    ]);
    const byId = new Map(buildLengthEstimateTargets(db).map((t) => [t.listingId, t]));
    expect(byId.get('src:staud')).toMatchObject({
      statedModelHeightInches: 70,
      modelSizeWorn: 'S',
    });
    expect(byId.get('src:rouje')).toMatchObject({
      statedModelHeightInches: 68.9,
      modelSizeWorn: '36',
    });
    expect(byId.get('src:plain')).toMatchObject({
      statedModelHeightInches: null,
      modelSizeWorn: null,
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
  it('writes inches + image_estimate basis + anchor for sane estimates', async () => {
    seed([{ id: 'a' }]);
    await runLengthEstimation(db, buildLengthEstimateTargets(db), fakeEstimator(() => estimated(43.5)), silent);
    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-a')).get()!;
    expect(row.lengthInches).toBe(43.5);
    expect(row.lengthBasis).toBe('image_estimate');
    expect(row.lengthAnchor).toBe('assumed_default');
    expect(row.lengthAnchorHeightIn).toBe(69);
  });

  it('records the stated anchor when the listing gives the model height', async () => {
    seed([{ id: 'a', description: `Model is 5'10" and wears a size S.` }]);
    await runLengthEstimation(db, buildLengthEstimateTargets(db), fakeEstimator(() => estimated(45)), silent);
    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-a')).get()!;
    expect(row.lengthBasis).toBe('image_estimate');
    expect(row.lengthAnchor).toBe('stated_model_height');
    expect(row.lengthAnchorHeightIn).toBe(70);
  });

  it("clamped estimates keep the class prior: basis='not_estimable', inches stay NULL", async () => {
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
    expect(row.lengthBasis).toBe('not_estimable'); // marked distinctly, never re-billed
    // invariant: basis='image_estimate' always implies inches present
    expect(buildLengthEstimateTargets(db)).toHaveLength(0);
  });

  it("image_unavailable marks the row 'not_estimable' so the queue DRAINS (terminal)", async () => {
    seed([{ id: 'dead-url' }]);
    const warns: string[] = [];
    const logger: Logger = { info: () => {}, warn: (...a) => warns.push(a.map(String).join(' ')), error: () => {} };
    const result = await runLengthEstimation(
      db,
      buildLengthEstimateTargets(db),
      fakeEstimator(() => ({
        status: 'image_unavailable',
        lengthInches: null,
        rawLengthInches: null,
        modelConfidence: 0,
        reasoning: null,
        error: 'Unable to download the file. Please verify the URL and try again.',
      })),
      logger,
    );
    expect(result.imageUnavailable).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.stopped).toBe(false); // not an all-failure wave — the run continues
    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-dead-url')).get()!;
    expect(row.lengthInches).toBeNull();
    expect(row.lengthBasis).toBe('not_estimable'); // terminal-but-marked
    // distinct triage log, and — the production bug — no longer 'failed (still queued)':
    expect(warns.some((w) => w.includes('image not downloadable'))).toBe(true);
    expect(buildLengthEstimateTargets(db)).toHaveLength(0); // queue drained
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

  it('lengthCoverage splits stated vs image-estimated vs not-estimable', async () => {
    seed([
      { id: 'stated', lengthInches: 39, lengthBasis: 'stated' },
      { id: 'legacy-stated', lengthInches: 44 }, // NULL basis counts as stated
      { id: 'gave-up', lengthBasis: 'not_estimable' },
      { id: 'to-estimate', description: `Model is 5'10"` },
    ]);
    await runLengthEstimation(db, buildLengthEstimateTargets(db), fakeEstimator(() => estimated(41)), silent);
    const c = lengthCoverage(db);
    expect(c).toMatchObject({
      liveListings: 4,
      withInches: 3,
      stated: 2,
      imageEstimated: 1,
      anchoredStatedHeight: 1,
      notEstimable: 1,
    });
  });
});

describe('migrateLengthBookkeeping — v1 → v2 marker fix (no API calls)', () => {
  it("re-marks image_estimate rows with NULL inches as 'not_estimable', idempotently", () => {
    seed([
      { id: 'clamped-v1', lengthBasis: 'image_estimate' }, // v1 clamped/no-estimate bookkeeping
      { id: 'real-estimate', lengthInches: 42, lengthBasis: 'image_estimate' }, // untouched
      { id: 'stated', lengthInches: 39, lengthBasis: 'stated' }, // untouched
      { id: 'untried' }, // untouched (still queued)
    ]);
    expect(migrateLengthBookkeeping(db)).toBe(1);
    const basis = (hash: string) =>
      db.select().from(extractions).where(eq(extractions.contentHash, hash)).get()!.lengthBasis;
    expect(basis('hash-clamped-v1')).toBe('not_estimable');
    expect(basis('hash-real-estimate')).toBe('image_estimate');
    expect(basis('hash-stated')).toBe('stated');
    expect(basis('hash-untried')).toBeNull();
    // idempotent: second run changes nothing
    expect(migrateLengthBookkeeping(db)).toBe(0);
    // and the fresh queue is unaffected
    expect(buildLengthEstimateTargets(db).map((t) => t.listingId)).toEqual(['src:untried']);
  });
});

describe('requeueNotEstimable — oversized-image rescue re-queue (--requeue-not-estimable)', () => {
  it('counts + resets only unprotected not_estimable rows; the fresh queue re-selects them', () => {
    seed([
      // the too_large victim (and any genuinely unestimable sibling — the db
      // never stored WHY a row gave up, so both are requeued)
      { id: 'gave-up', lengthBasis: 'not_estimable', lengthAnchor: 'assumed_default', lengthAnchorHeightIn: 69 },
      // protected ground truth — never touched
      { id: 'fixture-gave-up', lengthBasis: 'not_estimable', model: 'fixture' },
      // successful estimates and untried rows — never touched
      { id: 'estimated', lengthInches: 44, lengthBasis: 'image_estimate' },
      { id: 'untried' },
    ]);
    expect(countNotEstimableRequeue(db)).toBe(1); // dry-run number
    expect(requeueNotEstimable(db)).toBe(1);

    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-gave-up')).get()!;
    expect(row.lengthBasis).toBeNull();
    expect(row.lengthAnchor).toBeNull();
    expect(row.lengthAnchorHeightIn).toBeNull();
    const fixture = db
      .select()
      .from(extractions)
      .where(eq(extractions.contentHash, 'hash-fixture-gave-up'))
      .get()!;
    expect(fixture.lengthBasis).toBe('not_estimable');

    // the reset row is back in the fresh-pass queue alongside the untried one
    expect(buildLengthEstimateTargets(db).map((t) => t.listingId).sort()).toEqual([
      'src:gave-up',
      'src:untried',
    ]);
    // idempotent: nothing left to reset
    expect(requeueNotEstimable(db)).toBe(0);
    expect(countNotEstimableRequeue(db)).toBe(0);
  });

  it('a requeued row that succeeds under the downscale rescue gets inches; a repeat failure re-settles terminally', async () => {
    seed([
      { id: 'rescued', lengthBasis: 'not_estimable' },
      { id: 'hopeless', lengthBasis: 'not_estimable' },
    ]);
    requeueNotEstimable(db);
    const targets = buildLengthEstimateTargets(db);
    const estimator = fakeEstimator((hash) =>
      hash === 'hash-rescued'
        ? estimated(44)
        : { status: 'no_estimate', lengthInches: null, rawLengthInches: null, modelConfidence: 0.2, reasoning: null },
    );
    await runLengthEstimation(db, targets, estimator, silent);
    const rescued = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-rescued')).get()!;
    expect(rescued).toMatchObject({ lengthInches: 44, lengthBasis: 'image_estimate' });
    const hopeless = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-hopeless')).get()!;
    expect(hopeless).toMatchObject({ lengthInches: null, lengthBasis: 'not_estimable' });
    // the queue drained — no perpetual re-billing
    expect(buildLengthEstimateTargets(db)).toEqual([]);
  });
});

describe('buildReanchorTargets — stated-height re-estimation queue (--reanchor)', () => {
  const staudText = `Model is 5'10" and wears a size S.`; // 70" → delta 1"
  const tallText = `Our model is 5'11" and wears a size 4.`; // 71" → delta 2"
  const nearDefaultText = `Model is 175 cm.`; // 68.9" → delta 0.1", skip

  it('selects default-anchored image estimates whose stated height is ≥1" off 69"', () => {
    seed([
      // v1 row (anchor NULL) — reanchor
      { id: 'v1-est', lengthInches: 44, lengthBasis: 'image_estimate', description: staudText },
      // v2 default-anchored — reanchor
      {
        id: 'v2-default',
        lengthInches: 40,
        lengthBasis: 'image_estimate',
        lengthAnchor: 'assumed_default',
        lengthAnchorHeightIn: 69,
        description: tallText,
      },
      // already anchored on the stated height — never re-billed
      {
        id: 'already-anchored',
        lengthInches: 45,
        lengthBasis: 'image_estimate',
        lengthAnchor: 'stated_model_height',
        lengthAnchorHeightIn: 70,
        description: staudText,
      },
      // stated height too close to 69" — not worth re-paying
      { id: 'near-default', lengthInches: 43, lengthBasis: 'image_estimate', description: nearDefaultText },
      // no stated height at all
      { id: 'no-height', lengthInches: 41, lengthBasis: 'image_estimate' },
      // stated inches (never image-estimated) — out of scope
      { id: 'stated', lengthInches: 39, lengthBasis: 'stated', description: staudText },
      // not-estimable attempts — out of scope for reanchor
      { id: 'gave-up', lengthBasis: 'not_estimable', description: staudText },
      // untried rows belong to the fresh queue, not reanchor
      { id: 'untried', description: staudText },
    ]);
    const scan = buildReanchorTargets(db);
    expect(scan.scanned).toBe(4); // v1-est, v2-default, near-default, no-height
    expect(scan.withStatedHeight).toBe(3); // v1-est, v2-default, near-default
    expect(scan.targets.map((t) => t.listingId).sort()).toEqual(['src:v1-est', 'src:v2-default']);
    expect(scan.targets.every((t) => t.statedModelHeightInches != null)).toBe(true);
  });

  it('reanchor run rewrites inches with the stated anchor and is idempotent', async () => {
    seed([
      { id: 'a', lengthInches: 44, lengthBasis: 'image_estimate', description: tallText },
    ]);
    const estimator = fakeEstimator(() => estimated(46));
    await runLengthEstimation(db, buildReanchorTargets(db).targets, estimator, silent);
    expect(estimator.estimateOne).toHaveBeenCalledTimes(1);

    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-a')).get()!;
    expect(row.lengthInches).toBe(46);
    expect(row.lengthBasis).toBe('image_estimate');
    expect(row.lengthAnchor).toBe('stated_model_height');
    expect(row.lengthAnchorHeightIn).toBe(71);

    // idempotent: anchored rows are never selected again
    expect(buildReanchorTargets(db).targets).toHaveLength(0);
  });

  it('reanchor outcome that clamps withdraws the old default-anchored inches', async () => {
    seed([
      { id: 'a', lengthInches: 33, lengthBasis: 'image_estimate', lengthClass: 'mini', description: tallText },
    ]);
    await runLengthEstimation(
      db,
      buildReanchorTargets(db).targets,
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
    expect(row.lengthInches).toBeNull(); // stale default-anchor estimate withdrawn
    expect(row.lengthBasis).toBe('not_estimable');
    expect(buildReanchorTargets(db).targets).toHaveLength(0); // not re-billed
  });

  it('failed reanchor calls stay queued for resume', async () => {
    seed([{ id: 'a', lengthInches: 44, lengthBasis: 'image_estimate', description: tallText }]);
    await runLengthEstimation(
      db,
      buildReanchorTargets(db).targets,
      fakeEstimator(() => ({
        status: 'failed',
        lengthInches: null,
        rawLengthInches: null,
        modelConfidence: 0,
        reasoning: null,
        error: '529 overloaded',
      })),
      silent,
    );
    const row = db.select().from(extractions).where(eq(extractions.contentHash, 'hash-a')).get()!;
    expect(row.lengthInches).toBe(44); // untouched
    expect(row.lengthAnchor).toBeNull();
    expect(buildReanchorTargets(db).targets).toHaveLength(1); // retried on resume
  });
});
