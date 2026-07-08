import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { listingImages, listings, sources } from '../schema';
import {
  blobToVector,
  embeddingStats,
  listingsMissingEmbedding,
  loadCatalogEmbeddings,
  upsertEmbedding,
  vectorToBlob,
} from './embeddings';

const MODEL = 'test-model';
let tmpDir: string;
let db: Db;

function addListing(id: string, contentHash: string, opts: { image?: string; removedAt?: number } = {}) {
  db.insert(listings)
    .values({
      id,
      sourceId: 'fixture:test',
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title: `Dress ${id}`,
      priceCents: 5000,
      contentHash,
      firstSeenAt: 1,
      lastSeenAt: 2,
      removedAt: opts.removedAt ?? null,
    })
    .run();
  if (opts.image) {
    db.insert(listingImages).values({ listingId: id, url: opts.image, position: 0 }).run();
  }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-emb-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  db.insert(sources)
    .values({ id: 'fixture:test', kind: 'fixture', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Float32Array ↔ BLOB', () => {
  it('round-trips exact float32 bits', () => {
    const vec = Float32Array.from([0.1, -2.5, 3.14159, 0, 1e-30, -1e30]);
    const back = blobToVector(vectorToBlob(vec));
    expect([...back]).toEqual([...vec]);
    expect(back).toBeInstanceOf(Float32Array);
  });

  it('vectorToBlob copies — mutating the source does not change the blob', () => {
    const vec = Float32Array.from([1, 2]);
    const blob = vectorToBlob(vec);
    vec[0] = 99;
    expect([...blobToVector(blob)]).toEqual([1, 2]);
  });

  it('rejects blobs whose length is not a multiple of 4', () => {
    expect(() => blobToVector(Buffer.from([1, 2, 3]))).toThrow(/multiple of 4/);
  });
});

describe('embedding repository', () => {
  it('round-trips a vector through the db and reports stats', () => {
    addListing('l1', 'hash-l1', { image: 'https://img/l1.jpg' });
    const vec = Float32Array.from({ length: 8 }, (_, i) => Math.fround(Math.sin(i)));
    upsertEmbedding(db, { listingId: 'l1', contentHash: 'hash-l1', model: MODEL, vector: vec });

    const rows = loadCatalogEmbeddings(db, MODEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].listingId).toBe('l1');
    expect([...rows[0].vector]).toEqual([...vec]);
    expect(embeddingStats(db, MODEL).count).toBe(1);
    expect(embeddingStats(db, 'other-model').count).toBe(0);
  });

  it('upsert is idempotent by (content_hash, model) and refreshes the vector', () => {
    const v2 = Float32Array.from([9, 9]);
    upsertEmbedding(db, { listingId: 'l1', contentHash: 'hash-l1', model: MODEL, vector: v2 });
    const rows = loadCatalogEmbeddings(db, MODEL);
    expect(rows).toHaveLength(1); // replaced, not duplicated
    expect([...rows[0].vector]).toEqual([9, 9]);
  });

  it('queues only active, imaged listings missing a CURRENT-hash vector', () => {
    addListing('l2', 'hash-l2', { image: 'https://img/l2.jpg' }); // needs embedding
    addListing('l3', 'hash-l3'); // no image → not queueable
    addListing('l4', 'hash-l4', { image: 'https://img/l4.jpg', removedAt: 123 }); // removed

    const queue = listingsMissingEmbedding(db, MODEL);
    expect(queue.map((q) => q.listingId)).toEqual(['l2']);
    expect(queue[0]).toMatchObject({ contentHash: 'hash-l2', imageUrl: 'https://img/l2.jpg' });

    // embedded l1 is skipped (idempotency); the limit arg caps the queue
    expect(listingsMissingEmbedding(db, MODEL, 0)).toHaveLength(0);
  });

  it('treats a content-hash change as stale: re-queued and dropped from the catalog', () => {
    // l1's content changes → new hash; old vector row remains but is stale
    db.update(listings).set({ contentHash: 'hash-l1-v2' }).where(eq(listings.id, 'l1')).run();
    expect(listingsMissingEmbedding(db, MODEL).map((q) => q.listingId)).toContain('l1');
    expect(loadCatalogEmbeddings(db, MODEL).map((r) => r.listingId)).not.toContain('l1');
    expect(embeddingStats(db, MODEL).count).toBe(0);

    // re-embedding under the new hash restores it
    upsertEmbedding(db, {
      listingId: 'l1',
      contentHash: 'hash-l1-v2',
      model: MODEL,
      vector: Float32Array.from([1]),
    });
    expect(loadCatalogEmbeddings(db, MODEL).map((r) => r.listingId)).toContain('l1');
  });
});
