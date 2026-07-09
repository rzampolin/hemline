/** Drizzle-backed query-parse cache (search_query_cache) — TTL + negative entries. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { createQueryParseCacheStore } from './ai-cache';

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-search-cache-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createQueryParseCacheStore', () => {
  it('round-trips a parse payload globally (no user in the key)', async () => {
    const nowMs = 1_000;
    const store = createQueryParseCacheStore(db, () => nowMs);
    const parse = { hard: { priceMaxCents: 15000 }, soft: { occasions: ['formal'] } };
    await store.set('key-a', { parse }, nowMs + 60_000);
    expect((await store.get('key-a'))?.parse).toEqual(parse);
  });

  it('stores negative entries (parse: null) distinctly from misses', async () => {
    const nowMs = 1_000;
    const store = createQueryParseCacheStore(db, () => nowMs);
    await store.set('key-neg', { parse: null }, nowMs + 60_000);
    const hit = await store.get('key-neg');
    expect(hit).not.toBeNull();
    expect(hit!.parse).toBeNull();
    expect(await store.get('key-missing')).toBeNull();
  });

  it('lazily deletes expired rows on read', async () => {
    let nowMs = 1_000;
    const store = createQueryParseCacheStore(db, () => nowMs);
    await store.set('key-ttl', { parse: { soft: {} } }, 2_000);
    expect(await store.get('key-ttl')).not.toBeNull();
    nowMs = 2_000;
    expect(await store.get('key-ttl')).toBeNull();
  });

  it('upserts on conflict (a retry overwrites the negative entry)', async () => {
    const nowMs = 1_000;
    const store = createQueryParseCacheStore(db, () => nowMs);
    await store.set('key-up', { parse: null }, nowMs + 60_000);
    await store.set('key-up', { parse: { soft: { vibeText: 'x' } } }, nowMs + 60_000);
    expect((await store.get('key-up'))?.parse).toEqual({ soft: { vibeText: 'x' } });
  });
});
