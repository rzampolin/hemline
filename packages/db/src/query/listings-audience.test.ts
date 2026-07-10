/**
 * Audience gate in the candidate query (kids-in-catalog, 2026-07-09):
 * extraction-flagged CHILD listings never reach the pool; NULL audience and
 * missing extraction rows are treated as adult (unknown must not nuke
 * coverage).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { extractions, listings, sources } from '../schema';
import { queryCandidates } from './listings';

let tmpDir: string;
let db: Db;

function addListing(id: string, audience: 'adult' | 'child' | null | 'none') {
  db.insert(listings)
    .values({
      id,
      sourceId: 'fixture:test',
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title: `Dress ${id}`,
      priceCents: 10000,
      currency: 'USD',
      contentHash: `hash-${id}`,
      firstSeenAt: Date.now() - 86_400_000,
      lastSeenAt: Date.now(),
    })
    .run();
  if (audience === 'none') return; // no extraction row at all
  db.insert(extractions)
    .values({
      contentHash: `hash-${id}`,
      listingId: id,
      model: 'mock',
      audience,
      extractedAt: Date.now(),
    })
    .run();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-audience-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  db.insert(sources)
    .values({ id: 'fixture:test', kind: 'fixture', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
  addListing('adult-dress', 'adult');
  addListing('kid-dress', 'child');
  addListing('unknown-audience', null);
  addListing('no-extraction', 'none');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queryCandidates — audience filter', () => {
  it("excludes audience='child'; keeps adult, NULL, and extraction-less listings", () => {
    const ids = queryCandidates(db)
      .map((c) => c.listing.id)
      .sort();
    expect(ids).toEqual(['adult-dress', 'no-extraction', 'unknown-audience']);
  });

  it('hydrated listings expose the audience for downstream in-memory filters', () => {
    const byId = new Map(queryCandidates(db).map((c) => [c.listing.id, c.listing]));
    expect(byId.get('adult-dress')?.audience).toBe('adult');
    expect(byId.get('unknown-audience')?.audience).toBeNull();
    expect(byId.get('no-extraction')?.audience).toBeNull();
  });
});
