/**
 * Embedding wiring tests (2026-07-07 ml-eng): the style-profile port reads
 * STORED vectors only (no python), so it is fully testable here; the
 * no-vectors degradation path is what every other route test already runs
 * under (seeded db has no embeddings → pipeline identical to pre-ml).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL_TAG, type Listing } from '@hemline/contracts';
import {
  createDb,
  ensureSchema,
  listings,
  sources,
  swipeEvents,
  upsertEmbedding,
  users,
  type Db,
} from '@hemline/db';
import { findSimilarByEmbedding, makeEmbeddingScorePort } from '../lib/embeddings';

let tmpDir: string;
let db: Db;
const USER = 'u-emb-test';

const asListing = (id: string) => ({ id }) as Listing;

function addListing(id: string, vector?: number[]) {
  db.insert(listings)
    .values({
      id,
      sourceId: 'fixture:test',
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title: id,
      priceCents: 1000,
      contentHash: `hash-${id}`,
      firstSeenAt: 1,
      lastSeenAt: 2,
    })
    .run();
  if (vector) {
    upsertEmbedding(db, {
      listingId: id,
      contentHash: `hash-${id}`,
      model: EMBEDDING_MODEL_TAG,
      vector: Float32Array.from(vector),
    });
  }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-emb-lib-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  db.insert(sources)
    .values({ id: 'fixture:test', kind: 'fixture', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
  db.insert(users).values({ id: USER, createdAt: 1 }).run();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('degradation without vectors', () => {
  it('makeEmbeddingScorePort is undefined and findSimilarByEmbedding is null on an empty catalog', async () => {
    expect(makeEmbeddingScorePort(db, USER)).toBeUndefined();
    await expect(findSimilarByEmbedding(db, { op: 'text', text: 'midi' }, 5)).resolves.toBeNull();
  });
});

describe('style-profile port from swipes', () => {
  it('scores candidates against the average of liked/saved embeddings', () => {
    addListing('liked-1', [1, 0]);
    addListing('cand-close', [1, 0]);
    addListing('cand-far', [-1, 0]);
    addListing('cand-novec');
    db.insert(swipeEvents)
      .values([
        { userId: USER, listingId: 'liked-1', verdict: 'like', context: 'feed', createdAt: 10 },
        { userId: USER, listingId: 'cand-far', verdict: 'dislike', context: 'feed', createdAt: 11 },
      ])
      .run();

    const port = makeEmbeddingScorePort(db, USER);
    expect(port).toBeDefined();
    expect(port!(asListing('cand-close'))).toBeCloseTo(1); // parallel to profile
    expect(port!(asListing('cand-far'))).toBeCloseTo(0); // opposite (dislike NOT folded in)
    expect(port!(asListing('cand-novec'))).toBeNull(); // no vector → attribute path
  });

  it('is undefined for a user with vectors in the catalog but no positive swipes', () => {
    db.insert(users).values({ id: 'u-no-likes', createdAt: 1 }).run();
    expect(makeEmbeddingScorePort(db, 'u-no-likes')).toBeUndefined();
  });
});
