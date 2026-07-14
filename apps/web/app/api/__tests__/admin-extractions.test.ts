/**
 * Extraction-QA confidence regression (2026-07-13 founder report: "every row
 * shows 0.00"). Pins the full field-mapping chain the dashboard panel depends
 * on — extractions.extraction_confidence (snake_case column) →
 * listExtractionsForQa → GET /api/admin/extractions → camelCase `confidence`
 * → the exact `confidence.toFixed(2)` formatting the panel renders — so a
 * snake_case/camelCase or wrong-property regression in any layer fails loudly
 * with real (non-zero) confidences.
 *
 * Own temp db (never the seeded corpus / data/hemline.db).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, ensureSchema, type Db } from '@hemline/db';
import { __resetDbCache } from '../lib/db';
import { GET as extractionsGET } from '../admin/extractions/route';
import { PATCH as extractionPATCH } from '../admin/extractions/[contentHash]/route';

let tmpDir: string;
let db: Db;
let prevDbPath: string | undefined;
let prevAuth: string | undefined;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-qa-conf-test-'));
  const dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  prevDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;
  prevAuth = process.env.ADMIN_BASIC_AUTH;
  delete process.env.ADMIN_BASIC_AUTH; // open admin (dev semantics) for the test
  __resetDbCache();

  // realistic rows: healthy live-model confidences + one genuine low outlier
  db.$client.exec(`
    INSERT INTO sources (id, kind, display_name, cadence_cron)
    VALUES ('shopify:qa.store', 'shopify', 'QA Store', '0 6 * * *');
    INSERT INTO listings (id, source_id, source_listing_id, source_url, title, description,
                          price_cents, content_hash, first_seen_at, last_seen_at)
    VALUES
      ('shopify:qa.store:1', 'shopify:qa.store', '1', 'https://qa.store/products/a',
       'Silk midi dress', 'A silk midi', 12000, 'hash-a', 1, 1),
      ('shopify:qa.store:2', 'shopify:qa.store', '2', 'https://qa.store/products/b',
       'Linen maxi dress', 'A linen maxi', 9000, 'hash-b', 1, 1),
      ('shopify:qa.store:3', 'shopify:qa.store', '3', 'https://qa.store/products/c',
       'Mystery dress', NULL, 5000, 'hash-c', 1, 1);
    INSERT INTO listing_images (listing_id, url, position)
    VALUES ('shopify:qa.store:1', 'https://qa.store/img/a.jpg', 0);
    INSERT INTO extractions (content_hash, listing_id, model, extraction_confidence, extracted_at)
    VALUES
      ('hash-a', 'shopify:qa.store:1', 'claude-haiku-4-5-20251001', 0.83, 100),
      ('hash-b', 'shopify:qa.store:2', 'claude-haiku-4-5-20251001', 0.42, 200),
      ('hash-c', 'shopify:qa.store:3', 'claude-haiku-4-5-20251001', 0.0, 300);
  `);
});

afterAll(() => {
  if (prevDbPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = prevDbPath;
  if (prevAuth !== undefined) process.env.ADMIN_BASIC_AUTH = prevAuth;
  __resetDbCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getItems(query: string) {
  const res = await extractionsGET(new Request(`http://test/api/admin/extractions?${query}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: { items: any[]; total: number } };
  expect(body.ok).toBe(true);
  return body.data;
}

describe('GET /api/admin/extractions — confidence field mapping', () => {
  it('returns each row\'s REAL stored confidence under the camelCase `confidence` key', async () => {
    const data = await getItems('maxConfidence=1');
    expect(data.total).toBe(3);
    // sorted ascending by confidence (worst-first QA ordering)
    expect(data.items.map((i) => i.confidence)).toEqual([0, 0.42, 0.83]);
    for (const item of data.items) {
      expect(typeof item.confidence).toBe('number');
      expect(Number.isFinite(item.confidence)).toBe(true);
      // the exact regression the founder reported: no snake_case leak, no
      // wrong-property mapping silently defaulting everything to 0
      expect(item).not.toHaveProperty('extraction_confidence');
      expect(item).not.toHaveProperty('extractionConfidence');
    }
  });

  it('renders non-zero through the panel formatting (confidence.toFixed(2))', async () => {
    const data = await getItems('maxConfidence=1');
    // identical expression to apps/web/app/admin/extraction-qa.tsx:253
    const rendered = data.items.map((i) => i.confidence.toFixed(2));
    expect(rendered).toEqual(['0.00', '0.42', '0.83']);
    // a healthy catalog must NOT render as all-zeros
    expect(rendered.filter((r) => r !== '0.00').length).toBeGreaterThan(0);
  });

  it('maxConfidence filters on the same stored value it displays', async () => {
    const data = await getItems('maxConfidence=0.6');
    expect(data.total).toBe(2);
    expect(data.items.map((i) => i.confidence)).toEqual([0, 0.42]);
  });

  it('PATCH corrections round-trip the confidence they store', async () => {
    const res = await extractionPATCH(
      new Request('http://test/api/admin/extractions/hash-b', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confidence: 0.95 }),
      }),
      { params: Promise.resolve({ contentHash: 'hash-b' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: any };
    expect(body.data.confidence).toBe(0.95);
    expect(body.data.model).toBe('manual');

    const after = await getItems('maxConfidence=1');
    expect(after.items.find((i) => i.contentHash === 'hash-b')?.confidence).toBe(0.95);
  });
});
