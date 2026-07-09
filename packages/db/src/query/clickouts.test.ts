/**
 * Clickout / attribution log (spec G4; QA P1 #4, 2026-07-08).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { clickouts, listings, sources } from '../schema';
import { clickoutStats, hashDestination, recordClickout } from './clickouts';

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-clickouts-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  db.insert(sources)
    .values({ id: 'fixture:test', kind: 'fixture', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
  db.insert(listings)
    .values({
      id: 'fixture:test:aff',
      sourceId: 'fixture:test',
      sourceListingId: 'aff',
      sourceUrl: 'https://example.com/aff',
      affiliateUrl: 'https://example.com/aff?campid=123',
      title: 'Affiliate Dress',
      priceCents: 9900,
      contentHash: 'hash-aff',
      firstSeenAt: 1,
      lastSeenAt: 2,
    })
    .run();
  db.insert(listings)
    .values({
      id: 'fixture:test:plain',
      sourceId: 'fixture:test',
      sourceListingId: 'plain',
      sourceUrl: 'https://example.com/plain',
      title: 'Plain Dress',
      priceCents: 9900,
      contentHash: 'hash-plain',
      firstSeenAt: 1,
      lastSeenAt: 2,
    })
    .run();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recordClickout', () => {
  it('records a row with server-derived source + hashed destination (affiliateUrl wins)', () => {
    expect(recordClickout(db, 'fixture:test:aff', 'user-1')).toBe(true);
    const row = db.select().from(clickouts).all().at(-1)!;
    expect(row.listingId).toBe('fixture:test:aff');
    expect(row.userId).toBe('user-1');
    expect(row.sourceId).toBe('fixture:test');
    // destination = affiliateUrl ?? sourceUrl, stored as sha256 only (no PII)
    expect(row.destinationHash).toBe(hashDestination('https://example.com/aff?campid=123'));
    expect(row.destinationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.clickedAt).toBeGreaterThan(0);
  });

  it('tolerates guests: null user id is recorded', () => {
    expect(recordClickout(db, 'fixture:test:plain', null)).toBe(true);
    const row = db.select().from(clickouts).all().at(-1)!;
    expect(row.userId).toBeNull();
    expect(row.destinationHash).toBe(hashDestination('https://example.com/plain'));
  });

  it('returns false for an unknown listing (nothing written)', () => {
    const before = db.select().from(clickouts).all().length;
    expect(recordClickout(db, 'fixture:test:nope', 'user-1')).toBe(false);
    expect(db.select().from(clickouts).all().length).toBe(before);
  });
});

describe('clickoutStats (admin aggregation)', () => {
  it('aggregates total / last24h / bySource', () => {
    const stats = clickoutStats(db);
    expect(stats.total).toBe(2);
    expect(stats.last24h).toBe(2);
    expect(stats.bySource).toEqual({ 'fixture:test': 2 });
  });

  it('last24h respects the window', () => {
    const stats = clickoutStats(db, Date.now() + 25 * 3_600_000);
    expect(stats.total).toBe(2);
    expect(stats.last24h).toBe(0);
  });
});
