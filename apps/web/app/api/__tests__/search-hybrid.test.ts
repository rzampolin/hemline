/**
 * Hybrid free-text search — route-level tests over the seeded fixture corpus
 * (docs/decisions-search.md). This environment IS the degradation matrix's
 * bottom row: no ANTHROPIC_API_KEY (stage 3 skipped), no ml venv and no
 * catalog vectors (stage 2 skipped) — stage 1 + lexical must carry search.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, ensureSchema, runSeed, DEMO_USER_ID, type Db } from '@hemline/db';
import { RankResponseSchema } from '@hemline/contracts';

import { __resetDbCache } from '../lib/db';
import { USER_ID_HEADER } from '../lib/session';
import { GET as searchGET } from '../search/route';
import { POST as rankPOST } from '../rank/route';

let tmpDir: string;
let db: Db;

const demoHeaders = { [USER_ID_HEADER]: DEMO_USER_ID, 'content-type': 'application/json' };

async function data<T = any>(res: Response): Promise<T> {
  const body = (await res.json()) as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string };
  };
  if (!body.ok) throw new Error(`api error: ${body.error?.code} ${body.error?.message}`);
  return body.data as T;
}

const search = async (qs: string) =>
  data(await searchGET(new Request(`http://test/api/search?${qs}`)));

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY; // stage 3 must be OFF in this suite
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-search-hybrid-'));
  const dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  runSeed(dbPath);
  process.env.DATABASE_PATH = dbPath;
  __resetDbCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('stage 1: vocabulary-mapped queries return results the LIKE gate lost', () => {
  it('"summer formal" → occasion-matched results (was 0 with token-AND LIKE)', async () => {
    const res = await search('q=summer%20formal');
    expect(RankResponseSchema.parse(res)).toBeTruthy();
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.totalMatched).toBeGreaterThan(0);
    expect(res.totalMatched).toBeLessThan(151); // the evidence gate is real
    const kinds = res.interpreted!.signals.map((s: any) => [s.kind, s.value]);
    expect(kinds).toContainEqual(['occasion', 'formal']);
    expect(res.interpreted!.vibe).toContain('summer');
  });

  it('"pink" → every result actually has a pink color family (attribute evidence)', async () => {
    const res = await search('q=pink');
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) {
      expect(
        item.listing.colors.some((c: any) => c.family === 'pink'),
        item.listing.title,
      ).toBe(true);
    }
    expect(res.interpreted!.signals).toContainEqual({
      kind: 'color',
      term: 'pink',
      value: 'pink',
      hard: false,
    });
  });

  it('"silk midi under $200": midi + price hard-filter, silk boosts ranking', async () => {
    const res = await search('q=silk%20midi%20under%20%24200');
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) {
      expect(item.listing.lengthClass).toBe('midi'); // hard
      expect(item.listing.priceCents).toBeLessThanOrEqual(20000); // hard (USD corpus)
    }
    // soft: silk must NOT filter — but it must rank silk first
    const first = res.items[0];
    expect(first.listing.fabric ?? '').toMatch(/silk/i);
    const hard = res.interpreted!.signals.filter((s: any) => s.hard).map((s: any) => s.kind);
    expect(hard.sort()).toEqual(['length', 'price']);
  });

  it('brand queries hard-filter with label expansion ("staud midi")', async () => {
    const res = await search('q=staud%20midi');
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) {
      expect(item.listing.brand ?? '').toMatch(/staud/i);
      expect(item.listing.lengthClass).toBe('midi');
    }
    expect(res.interpreted!.signals).toContainEqual(
      expect.objectContaining({ kind: 'brand', value: 'STAUD', hard: true }),
    );
  });

  it('residual tokens still match lexically (title/description substrings)', async () => {
    const res = await search('q=tapestry');
    expect(res.totalMatched).toBeGreaterThan(0);
    expect(res.totalMatched).toBeLessThan(30);
    expect(res.interpreted!.vibe).toContain('tapestry');
  });

  it('"cottagecore" is rescued by the vibe-synonym boosts (was an honest zero without vectors)', async () => {
    const res = await search('q=cottagecore');
    // 2026-07 zero-result mining: aesthetic vocabulary now carries
    // deterministic soft pattern boosts (floral/gingham), so the evidence
    // gate keeps attribute-matched dresses even keyless + vectorless.
    expect(res.totalMatched).toBeGreaterThan(0);
    expect(res.totalMatched).toBeLessThan(30); // gated, not the whole catalog
    expect(res.interpreted!.signals).toContainEqual(
      expect.objectContaining({ kind: 'pattern', value: 'floral', hard: false }),
    );
    expect(res.interpreted!.vibe).toEqual(['cottagecore']); // still semantic material
    expect(res.interpreted!.semantic).toBe(false);
  });

  it('vibe-only TRULY unknown vocabulary without vectors → honest empty set (no keyword noise)', async () => {
    const res = await search('q=brutalist');
    // no vectors + no lexical/attribute hits: gate empties the result rather
    // than dumping the whole catalog
    expect(res.totalMatched).toBe(0);
    expect(res.interpreted!.vibe).toEqual(['brutalist']);
    expect(res.interpreted!.semantic).toBe(false);
  });
});

describe('explicit filters always beat query-derived ones', () => {
  it('explicit priceMaxCents wins over "under $100" (no price chip rendered)', async () => {
    const res = await search('q=silk%20under%20%24100&priceMaxCents=20000');
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.interpreted!.signals.find((s: any) => s.kind === 'price')).toBeUndefined();
    // the explicit $200 cap applies — derived $100 must NOT
    const over100 = res.items.filter((i: any) => i.listing.priceCents > 10000);
    expect(over100.length).toBeGreaterThan(0);
    for (const item of res.items) expect(item.listing.priceCents).toBeLessThanOrEqual(20000);
  });

  it('explicit filters without q bypass interpretation entirely', async () => {
    const res = await search('colors=pink&priceMaxCents=30000');
    expect(res.interpreted).toBeUndefined();
    expect(res.items.length).toBeGreaterThan(0);
  });
});

describe('chip removal (lex param → lexical-only for that term)', () => {
  it('un-chipping "wrap" drops the silhouette signal; the term goes lexical', async () => {
    const interpreted = await search('q=wrap');
    expect(interpreted.interpreted!.signals).toContainEqual(
      expect.objectContaining({ kind: 'silhouette', value: 'wrap' }),
    );

    const lexical = await search('q=wrap&lex=wrap');
    expect(lexical.interpreted!.signals).toEqual([]);
    expect(lexical.interpreted!.vibe).toEqual([]); // removed chip must not re-render
    expect(lexical.totalMatched).toBeGreaterThan(0); // "wrap" still matches text
    // lexical-only results all literally contain "wrap"; interpreted results
    // may include silhouette-tagged dresses that never say the word
    for (const item of lexical.items) {
      expect(
        `${item.listing.title}`.toLowerCase().includes('wrap') || item.listing.silhouette === 'wrap',
      ).toBe(true);
    }
  });
});

describe('degradation matrix (this env: no key, no ml, no vectors)', () => {
  it('interpreted reports the honest stage state: deterministic parser, no semantics', async () => {
    const res = await search('q=summer%20formal');
    expect(res.interpreted!.parser).toBe('deterministic');
    expect(res.interpreted!.semantic).toBe(false);
  });

  it('guest search works (no session)', async () => {
    const res = await searchGET(new Request('http://test/api/search?q=silk%20slip'));
    expect(res.status).toBe(200);
    const body = await data(res);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('POST /api/rank (the feed search box) gets the same hybrid path + interpreted', async () => {
    const res = await rankPOST(
      new Request('http://test/api/rank', {
        method: 'POST',
        headers: demoHeaders,
        body: JSON.stringify({
          userId: DEMO_USER_ID,
          filters: { query: 'summer formal', lexicalTerms: [] },
          limit: 24,
          personalize: false,
        }),
      }),
    );
    const body = await data(res);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.interpreted.signals).toContainEqual(
      expect.objectContaining({ kind: 'occasion', value: 'formal' }),
    );
  });

  it('no-query requests carry no interpreted field (schema stays frozen-compatible)', async () => {
    const res = await rankPOST(
      new Request('http://test/api/rank', {
        method: 'POST',
        headers: demoHeaders,
        body: JSON.stringify({ userId: DEMO_USER_ID, filters: {}, limit: 5, personalize: false }),
      }),
    );
    const body = await data(res);
    expect(body.interpreted).toBeUndefined();
    expect(RankResponseSchema.parse(body)).toBeTruthy();
  });
});
