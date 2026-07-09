/**
 * Stage 2 (semantic) of hybrid search against a STUBBED embed.py sidecar
 * (same protocol-stub approach as packages/matching/embedder.test.ts):
 * proves the vocabulary-gap recall path, the ranking preference, and the
 * "listings without vectors stay findable" invariant.
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
  upsertEmbedding,
  type CandidateListing,
  type Db,
} from '@hemline/db';
import { warmSharedEmbedder } from '@hemline/matching/embedder';
import { buildSearchPlan } from '../lib/search';

// Node stub speaking embed.py's JSONL protocol; text embeds → [0, 1, -1].
const STUB = `
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ ready: true, model: 'stub', device: 'cpu' }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const item = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: item.id, dim: 3, vector: [0, 1, -1] }) + '\\n');
});
`;

let tmpDir: string;
let mlDir: string;
let db: Db;
const savedEnv = { dir: process.env.HEMLINE_ML_DIR, py: process.env.HEMLINE_ML_PYTHON };

function addListing(id: string, title: string, vector?: number[]) {
  db.insert(listings)
    .values({
      id,
      sourceId: 'fixture:test',
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title,
      brand: 'TestBrand',
      priceCents: 10000,
      contentHash: `hash-${id}`,
      firstSeenAt: 1,
      lastSeenAt: Date.now(),
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

function candidate(id: string, title: string): CandidateListing {
  return {
    listing: { id, title, brand: 'TestBrand', colors: [] } as unknown as Listing,
    attributeVector: {},
    sourceKind: 'fixture',
    description: null,
    removedAt: null,
  };
}

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-search-sem-'));
  mlDir = path.join(tmpDir, 'ml');
  fs.mkdirSync(mlDir);
  fs.writeFileSync(path.join(mlDir, 'embed.py'), STUB);
  process.env.HEMLINE_ML_DIR = mlDir;
  process.env.HEMLINE_ML_PYTHON = process.execPath; // run the stub with node

  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  db.insert(sources)
    .values({ id: 'fixture:test', kind: 'fixture', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
  addListing('sem-hit', 'Prairie Dress', [0, 1, -1]); // parallel to the query embed
  addListing('sem-miss', 'City Blazer Dress', [0, -1, 1]); // opposite
  addListing('lex-hit', 'True cottagecore ruffle dress'); // no vector, lexical only
  addListing('nothing', 'Plain black dress'); // no vector, no lexical hit
});

afterAll(() => {
  process.env.HEMLINE_ML_DIR = savedEnv.dir;
  process.env.HEMLINE_ML_PYTHON = savedEnv.py;
  if (savedEnv.dir === undefined) delete process.env.HEMLINE_ML_DIR;
  if (savedEnv.py === undefined) delete process.env.HEMLINE_ML_PYTHON;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('semantic recall (vectors + warm sidecar)', () => {
  it('embeds the query, gates on top-K evidence, ranks semantically-close first — and keeps vectorless lexical matches findable', async () => {
    // embedQueryText only fires when the model is RESIDENT (never pays the
    // cold load on a request) — warm the stub first, like HEMLINE_ML_EAGER=1.
    await expect(warmSharedEmbedder()).resolves.toBe(true);

    const plan = await buildSearchPlan(db, 'cottagecore');
    expect(plan.interpreted.semantic).toBe(true);
    expect(plan.interpreted.vibe).toEqual(['cottagecore']);
    expect(plan.hasScoringSignals).toBe(true);

    const cands = [
      candidate('sem-hit', 'Prairie Dress'),
      candidate('sem-miss', 'City Blazer Dress'),
      candidate('lex-hit', 'True cottagecore ruffle dress'),
      candidate('nothing', 'Plain black dress'),
    ];
    const { kept, relevance } = plan.apply(cands);
    const keptIds = kept.map((c) => c.listing.id);

    // vectorless listing WITH lexical evidence stays findable (never gated by ml)
    expect(keptIds).toContain('lex-hit');
    // both vectored listings are semantic-evidence candidates (top-K recall)…
    expect(keptIds).toContain('sem-hit');
    // …but no-evidence listings are gated out
    expect(keptIds).not.toContain('nothing');

    // ranking: parallel vector beats opposite vector
    expect(relevance.get('sem-hit')!).toBeGreaterThan(relevance.get('sem-miss') ?? 0);
    // lexical exact-hit scores highly too
    expect(relevance.get('lex-hit')!).toBeGreaterThan(0);
  });

  it('semantic never overrides hard filters or the soft/attribute signals (blend, not gate)', async () => {
    const plan = await buildSearchPlan(db, 'pink cottagecore');
    expect(plan.interpreted.semantic).toBe(true);
    const pinkCand: CandidateListing = {
      ...candidate('sem-miss', 'City Blazer Dress'),
      attributeVector: { 'color:pink': 0.8 },
    };
    const { kept, relevance } = plan.apply([pinkCand]);
    // attribute evidence keeps it regardless of a bad semantic score
    expect(kept.map((c) => c.listing.id)).toContain('sem-miss');
    expect(relevance.get('sem-miss')!).toBeGreaterThan(0);
  });
});

describe('degradation: ml removed after vectors exist', () => {
  it('no sidecar → semantic silently off; stage 1 + lexical still work', async () => {
    process.env.HEMLINE_ML_DIR = path.join(tmpDir, 'no-such-dir');
    process.env.HEMLINE_ML_PYTHON = path.join(tmpDir, 'no-such-python');
    // fresh query text: the per-process query-embed cache may legitimately
    // keep serving previously-embedded queries after the venv disappears
    const plan = await buildSearchPlan(db, 'fairycore cottagecore');
    expect(plan.interpreted.semantic).toBe(false);
    const { kept } = plan.apply([
      candidate('lex-hit', 'True cottagecore ruffle dress'),
      candidate('nothing', 'Plain black dress'),
    ]);
    expect(kept.map((c) => c.listing.id)).toEqual(['lex-hit']);
    process.env.HEMLINE_ML_DIR = mlDir;
    process.env.HEMLINE_ML_PYTHON = process.execPath;
  });
});
