/**
 * Embed-on-ingest tests (2026-07-08): the pipeline's automatic vector step —
 * fire-safe without the ML sidecar, honors --no-embed / opts.embed=false, and
 * embeds ONLY the missing content hashes of the run's sources (bridge mocked;
 * no python is ever spawned here).
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, RawListing, SourceConnector } from '@hemline/contracts';
import { EMBEDDING_MODEL_TAG } from '@hemline/contracts';
import { upsertEmbedding, type Db } from '@hemline/db';
import type { EmbedderPaths } from '@hemline/matching/embedder';
import {
  embedMissingForSources,
  isPlaceholderImage,
  type EmbedderBridge,
  type EmbedOnIngestDeps,
} from './embedding';
import { runPipeline } from './pipeline';
import { createTestDb } from './testing/test-db';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const FAKE_PATHS: EmbedderPaths = { mlDir: '/fake/ml', python: '/fake/python', script: '/fake/embed.py' };

let db: Db;
let cleanup: () => void;
beforeEach(() => ({ db, cleanup } = createTestDb()));
afterEach(() => cleanup());

function seedListing(sourceId: string, sid: string, imageUrl: string | null = `https://cdn/${sid}.jpg`): void {
  db.run(
    sql`INSERT OR IGNORE INTO sources (id, kind, display_name, cadence_cron) VALUES (${sourceId}, 'test', ${sourceId}, '0 6 * * *')`,
  );
  db.run(sql`
    INSERT INTO listings (id, source_id, source_listing_id, source_url, title,
      price_cents, currency, content_hash, first_seen_at, last_seen_at)
    VALUES (${`${sourceId}:${sid}`}, ${sourceId}, ${sid}, ${`https://x.test/${sid}`},
      ${`Dress ${sid}`}, 100, 'USD', ${`hash-${sid}`}, 1000, 1000)
  `);
  if (imageUrl) {
    db.run(
      sql`INSERT INTO listing_images (listing_id, url, position) VALUES (${`${sourceId}:${sid}`}, ${imageUrl}, 0)`,
    );
  }
}

/** mock bridge: records requested urls, returns a unit vector */
function fakeBridge(): EmbedderBridge & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    embed: vi.fn(async (req: { imageUrl: string }) => {
      urls.push(req.imageUrl);
      return Float32Array.from([1, 0, 0]);
    }),
    endInput: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

function depsWith(bridge: EmbedderBridge, available = true): EmbedOnIngestDeps {
  return {
    resolvePaths: () => (available ? FAKE_PATHS : null),
    createEmbedder: () => bridge,
  };
}

describe('embedMissingForSources', () => {
  it('skips with ONE info line (never an error) when the ML venv is not set up', async () => {
    seedListing('src-a', 'l1');
    const infos: string[] = [];
    const logger: Logger = { ...silent, info: (m) => infos.push(String(m)) };
    const bridge = fakeBridge();

    const result = await embedMissingForSources(db, ['src-a'], logger, depsWith(bridge, false));

    expect(result.skipped).toBe('no_sidecar');
    expect(result.embedded).toBe(0);
    expect(bridge.embed).not.toHaveBeenCalled();
    expect(infos.filter((m) => m.includes('ml sidecar not set up'))).toHaveLength(1);
  });

  it('embeds only MISSING hashes of the given sources; placeholders and other sources excluded', async () => {
    seedListing('src-a', 'new1'); // missing → embed
    seedListing('src-a', 'new2'); // missing → embed
    seedListing('src-a', 'done'); // vector already present for the CURRENT hash → skip
    seedListing('src-a', 'holder', 'https://placehold.co/300x400?text=x'); // placeholder → skip
    seedListing('src-b', 'other'); // different source → not this run's problem
    upsertEmbedding(db, {
      listingId: 'src-a:done',
      contentHash: 'hash-done',
      model: EMBEDDING_MODEL_TAG,
      vector: Float32Array.from([0, 1, 0]),
    });

    const bridge = fakeBridge();
    const result = await embedMissingForSources(db, ['src-a'], silent, depsWith(bridge));

    expect(result).toMatchObject({ queued: 2, embedded: 2, failed: 0, skipped: null });
    expect(bridge.urls.sort()).toEqual(['https://cdn/new1.jpg', 'https://cdn/new2.jpg']);
    expect(bridge.endInput).toHaveBeenCalled();
    expect(bridge.dispose).toHaveBeenCalled();
    // vectors persisted under the model tag, keyed by the CURRENT content hash
    const rows = db.all<{ content_hash: string; model: string }>(
      sql`SELECT content_hash, model FROM listing_embeddings ORDER BY content_hash`,
    );
    expect(rows.map((r) => r.content_hash)).toEqual(['hash-done', 'hash-new1', 'hash-new2']);
    expect(rows.every((r) => r.model === EMBEDDING_MODEL_TAG)).toBe(true);
  });

  it('does not even resolve the sidecar when nothing is missing', async () => {
    seedListing('src-a', 'done');
    upsertEmbedding(db, {
      listingId: 'src-a:done',
      contentHash: 'hash-done',
      model: EMBEDDING_MODEL_TAG,
      vector: Float32Array.from([1]),
    });
    const resolvePaths = vi.fn(() => FAKE_PATHS);
    const result = await embedMissingForSources(db, ['src-a'], silent, {
      resolvePaths,
      createEmbedder: () => fakeBridge(),
    });
    expect(result.skipped).toBe('nothing_missing');
    expect(resolvePaths).not.toHaveBeenCalled();
  });

  it('per-image failures are isolated (warned, counted, rest embedded)', async () => {
    seedListing('src-a', 'ok1');
    seedListing('src-a', 'bad');
    const bridge = fakeBridge();
    (bridge.embed as ReturnType<typeof vi.fn>).mockImplementation(async (req: { imageUrl: string }) => {
      if (req.imageUrl.includes('bad')) throw new Error('PIL cannot decode');
      return Float32Array.from([1, 0]);
    });
    const warns: string[] = [];
    const logger: Logger = { ...silent, warn: (...a) => warns.push(a.map(String).join(' ')) };
    const result = await embedMissingForSources(db, ['src-a'], logger, depsWith(bridge));
    expect(result).toMatchObject({ embedded: 1, failed: 1 });
    expect(warns.some((w) => w.includes('src-a:bad'))).toBe(true);
  });
});

describe('runPipeline — embed-on-ingest wiring', () => {
  function connectorFor(listings: RawListing[]): SourceConnector {
    return {
      id: 'test-src',
      kind: 'test',
      defaultCadence: '0 6 * * *',
      isConfigured: () => true,
      fetchListings: async () => ({ listings, stats: { fetched: listings.length, errors: 0 } }),
    };
  }
  const raw: RawListing = {
    sourceId: 'test-src',
    sourceListingId: 'A',
    sourceUrl: 'https://example.com/a',
    title: 'Linen Midi Dress',
    priceCents: 12300,
    currency: 'USD',
    imageUrls: ['https://cdn/a1.jpg'],
    sizeLabels: ['S'],
    availability: { S: true },
    condition: 'new',
    isVintage: false,
    seenAt: Date.now(),
  };

  it('embeds new listings after ingest (scheduler path: default opts → enabled)', async () => {
    const bridge = fakeBridge();
    const result = await runPipeline(db, connectorFor([raw]), {
      logger: silent,
      extract: false,
      prune: false,
      embedDeps: depsWith(bridge), // embed NOT disabled — the scheduler's default
    });
    expect(result.status).toBe('ok');
    expect(result.stats.embedded).toBe(1);
    expect(bridge.urls).toEqual(['https://cdn/a1.jpg']);
  });

  it('--no-embed / opts.embed=false skips the step entirely', async () => {
    const bridge = fakeBridge();
    const result = await runPipeline(db, connectorFor([raw]), {
      logger: silent,
      extract: false,
      prune: false,
      embed: false,
      embedDeps: depsWith(bridge),
    });
    expect(result.status).toBe('ok');
    expect(result.stats.embedded).toBe(0);
    expect(bridge.embed).not.toHaveBeenCalled();
  });

  it('embed step failures never fail the ingest run', async () => {
    const result = await runPipeline(db, connectorFor([raw]), {
      logger: silent,
      extract: false,
      prune: false,
      embedDeps: {
        resolvePaths: () => {
          throw new Error('exploding resolver');
        },
      },
    });
    expect(result.status).toBe('ok'); // ingest is fine; embeddings backfill later
    expect(result.stats.new).toBe(1);
  });
});

describe('isPlaceholderImage', () => {
  it('flags placeholder hosts and unparseable urls only', () => {
    expect(isPlaceholderImage('https://placehold.co/300x400')).toBe(true);
    expect(isPlaceholderImage('not a url')).toBe(true);
    expect(isPlaceholderImage('https://cdn11.bigcommerce.com/dress.jpg')).toBe(false);
  });
});
