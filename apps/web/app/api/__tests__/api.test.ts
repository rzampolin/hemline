/**
 * Route tests against a temp seeded SQLite db (ARCHITECTURE §9.4 "route
 * handlers invoked directly with seeded DB — no server needed").
 * Seeds the full 150-listing fixture corpus + demo user once per run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  DEMO_USER_ID,
  ensureSchema,
  runSeed,
  swipeEvents,
  type Db,
} from '@hemline/db';
import { eq, and } from 'drizzle-orm';
import { RankResponseSchema, UserProfileSchema, ColorAnalysisResultSchema, ListingDetailResponseSchema } from '@hemline/contracts';

import { __resetDbCache } from '../lib/db';
import { USER_ID_HEADER } from '../lib/session';
import { GET as sessionGET } from '../session/route';
import { GET as profileGET, PATCH as profilePATCH } from '../profile/route';
import { PUT as brandSizesPUT } from '../profile/brand-sizes/route';
import { POST as swipesPOST } from '../swipes/route';
import { POST as rankPOST } from '../rank/route';
import { GET as searchGET } from '../search/route';
import { GET as listingGET } from '../listings/[id]/route';
import { GET as metaGET } from '../meta/filters/route';
import { POST as colorPOST, PUT as colorPUT } from '../color-analysis/route';
import { POST as quizPOST } from '../color-analysis/quiz/route';
import { GET as savesGET, POST as savesPOST } from '../saves/route';
import { DELETE as saveDELETE } from '../saves/[listingId]/route';
import { GET as alertsGET, POST as alertsPOST } from '../alerts/route';
import { POST as findSimilarPOST } from '../find-similar/route';
import { GET as adminIngestGET, POST as adminIngestPOST } from '../admin/ingest/route';
import { POST as clickoutsPOST } from '../clickouts/route';
import { GET as adminExtractionsGET } from '../admin/extractions/route';
import { PATCH as adminExtractionPATCH } from '../admin/extractions/[contentHash]/route';

let tmpDir: string;
let dbPath: string;
let db: Db;

const demoHeaders = { [USER_ID_HEADER]: DEMO_USER_ID, 'content-type': 'application/json' };

function jsonReq(url: string, method: string, body?: unknown, headers: Record<string, string> = demoHeaders) {
  return new Request(`http://test${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function data<T = any>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!body.ok) throw new Error(`api error: ${body.error?.code} ${body.error?.message}`);
  return body.data as T;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-api-test-'));
  dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  runSeed(dbPath);
  process.env.DATABASE_PATH = dbPath;
  __resetDbCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session', () => {
  it('mints an anonymous user + signed cookie and returns a UserProfile', async () => {
    const res = await sessionGET(new Request('http://test/api/session'));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('hemline_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    const profile = await data(res);
    expect(UserProfileSchema.parse(profile)).toBeTruthy();
    expect(profile.onboarded).toBe(false);
  });

  it('reuses the session from the cookie', async () => {
    const first = await sessionGET(new Request('http://test/api/session'));
    const profile1 = await data(first);
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
    const second = await sessionGET(new Request('http://test/api/session', { headers: { cookie } }));
    const profile2 = await data(second);
    expect(profile2.id).toBe(profile1.id);
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('adopts a client-minted UUID from the x-hemline-user-id header', async () => {
    const clientId = '12345678-1234-4123-8123-123456789abc';
    const res = await sessionGET(new Request('http://test/api/session', { headers: { [USER_ID_HEADER]: clientId } }));
    const profile = await data(res);
    expect(profile.id).toBe(clientId);
  });
});

describe('profile roundtrip', () => {
  it('PATCH writes height/sizes/budget/prefs and GET reads them back', async () => {
    const patch = {
      heightInches: 70,
      sizesNormalized: [8, 10],
      budget: { minCents: 2000, maxCents: 40000 },
      lengthPrefs: ['knee', 'below_knee'],
      coveragePrefs: { sleeves: true },
      onboarded: true,
    };
    const patched = await data(await profilePATCH(jsonReq('/api/profile', 'PATCH', patch)));
    expect(patched.heightInches).toBe(70);
    expect(patched.sizesNormalized).toEqual([8, 10]);
    expect(patched.onboarded).toBe(true);

    const read = await data(await profileGET(jsonReq('/api/profile', 'GET')));
    expect(read.heightInches).toBe(70);
    expect(read.budget).toEqual({ minCents: 2000, maxCents: 40000 });
    expect(read.lengthPrefs).toEqual(['knee', 'below_knee']);

    // restore the seeded demo profile values used by later tests
    await profilePATCH(
      jsonReq('/api/profile', 'PATCH', {
        heightInches: 64,
        sizesNormalized: [6, 8],
        budget: { minCents: 3000, maxCents: 25000 },
        lengthPrefs: ['knee', 'below_knee', 'mid_calf'],
      }),
    );
  });

  it('PUT /api/profile/brand-sizes replaces the reference set', async () => {
    const profile = await data(
      await brandSizesPUT(
        jsonReq('/api/profile/brand-sizes', 'PUT', [
          { brand: 'Reformation', sizeLabel: '8' },
          { brand: 'STAUD', sizeLabel: 'M' },
        ]),
      ),
    );
    expect(profile.brandSizes).toHaveLength(2);
    expect(profile.brandSizes.map((b: any) => b.brand).sort()).toEqual(['Reformation', 'STAUD']);
  });

  it('rejects invalid patches with the error envelope', async () => {
    const res = await profilePATCH(jsonReq('/api/profile', 'PATCH', { heightInches: 'tall' }));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_request');
  });

  it('401s without a session', async () => {
    const res = await profileGET(new Request('http://test/api/profile'));
    expect(res.status).toBe(401);
  });
});

describe('color quiz → profile', () => {
  it('classifies deterministically and persists season + palette', async () => {
    const answers = {
      veinColor: 'green',
      jewelryMetal: 'gold',
      whiteVsCream: 'cream',
      sunReaction: 'tans_easily',
      naturalHair: 'auburn',
      eyeColor: 'brown',
    };
    const result = await data(await quizPOST(jsonReq('/api/color-analysis/quiz', 'POST', { answers })));
    expect(ColorAnalysisResultSchema.parse(result)).toBeTruthy();
    expect(result.season).toMatch(/autumn|spring/); // warm axis
    expect(result.source).toBe('quiz'); // additive label: measured values are synthesized
    expect(result.palette.length).toBeGreaterThanOrEqual(10);

    // deterministic: same answers → same season
    const again = await data(await quizPOST(jsonReq('/api/color-analysis/quiz', 'POST', { answers })));
    expect(again.season).toBe(result.season);

    const profile = await data(await profileGET(jsonReq('/api/profile', 'GET')));
    expect(profile.colorSeason).toBe(result.season);
    expect(profile.palette.length).toBeGreaterThan(0);
  });

  it('selfie POST samples a real image (sharp, in memory) deterministically; PUT overrides', async () => {
    // real pixels → real sampling; the keyless path classifies from the
    // measured Lab values via the deterministic rule table (§7.5)
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 320, height: 400, channels: 3, background: { r: 198, g: 148, b: 122 } },
    })
      .png()
      .toBuffer();
    const body = { imageBase64: png.toString('base64') };
    const r1 = await data(await colorPOST(jsonReq('/api/color-analysis', 'POST', body)));
    const r2 = await data(await colorPOST(jsonReq('/api/color-analysis', 'POST', body)));
    expect(ColorAnalysisResultSchema.parse(r1)).toBeTruthy();
    expect(r1.source).toBe('selfie');
    expect(r2.season).toBe(r1.season); // same bytes → same season

    // undecodable bytes → clean 400, not a 500
    const bad = await colorPOST(
      jsonReq('/api/color-analysis', 'POST', { imageBase64: Buffer.from('not-an-image').toString('base64') }),
    );
    expect(bad.status).toBe(400);

    const profile = await data(await colorPUT(jsonReq('/api/color-analysis', 'PUT', { season: 'soft_autumn' })));
    expect(profile.colorSeason).toBe('soft_autumn');
  });
});

describe('feed (POST /api/rank)', () => {
  it('returns size- and budget-filtered seeded fixtures for the demo user', async () => {
    const res = await rankPOST(
      jsonReq('/api/rank', 'POST', {
        userId: DEMO_USER_ID,
        filters: {},
        limit: 24,
        personalize: false,
      }),
    );
    const rank = await data(res);
    expect(RankResponseSchema.parse(rank)).toBeTruthy();
    expect(rank.items.length).toBeGreaterThan(0);
    expect(rank.totalMatched).toBeGreaterThan(0);
    for (const item of rank.items) {
      // demo profile hard filters applied silently: sizes [6,8], budget 3000–25000
      expect(item.listing.sizeNormalized.some((s: number) => s === 6 || s === 8)).toBe(true);
      expect(item.listing.priceCents).toBeGreaterThanOrEqual(3000);
      expect(item.listing.priceCents).toBeLessThanOrEqual(25000);
      expect(item.hem).toBeDefined();
      expect(item.whyItWorks).toBeTypeOf('string'); // templated fallback (§7.5)
    }
    expect(rank.rerank.mode).toBe('deterministic');
  });

  it('personalize:true keyless reports the HONEST rerank mode (deterministic, not llm)', async () => {
    // packages/ai's reranker labels its keyless fallback 'deterministic';
    // the old route lib mislabeled it 'llm' — that bug is gone with the
    // real MatchingService wiring.
    const rank = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 5, personalize: true }),
      ),
    );
    expect(rank.items.length).toBeGreaterThan(0);
    expect(rank.rerank.mode).toBe('deterministic');
    expect(rank.rerank.costUsd).toBeNull(); // no key → no spend
  });

  it('filters by source facet (additive HardFilters.sources)', async () => {
    const resale = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', {
          userId: DEMO_USER_ID,
          filters: { sources: ['resale'] },
          limit: 50,
          personalize: false,
        }),
      ),
    );
    expect(resale.items.length).toBeGreaterThan(0);
    for (const item of resale.items) expect(item.listing.sourceId).toBe('fixture:ebay');

    const brand = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', {
          userId: DEMO_USER_ID,
          filters: { sources: ['brand'] },
          limit: 50,
          personalize: false,
        }),
      ),
    );
    expect(brand.items.length).toBeGreaterThan(0);
    for (const item of brand.items) expect(item.listing.sourceId).toBe('fixture:shopify');
  });

  it('items carry the additive paletteMatch flag and never leak attribute vectors', async () => {
    const rank = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 24, personalize: false }),
      ),
    );
    expect(rank.items.some((i: any) => i.paletteMatch === true)).toBe(true); // soft-autumn demo palette
    for (const item of rank.items) {
      expect(typeof item.paletteMatch).toBe('boolean');
      expect('attributeVector' in item.listing).toBe(false);
    }
  });

  it('paginates with a stable cursor', async () => {
    const body = { userId: DEMO_USER_ID, filters: {}, limit: 5, personalize: false };
    const page1 = await data(await rankPOST(jsonReq('/api/rank', 'POST', body)));
    expect(page1.nextCursor).toBeTypeOf('string');
    const page2 = await data(
      await rankPOST(jsonReq('/api/rank', 'POST', { ...body, cursor: page1.nextCursor })),
    );
    const ids1 = page1.items.map((i: any) => i.listing.id);
    const ids2 = page2.items.map((i: any) => i.listing.id);
    expect(ids2.some((id: string) => ids1.includes(id))).toBe(false);
  });

  it('filters by effective length on the user (lengthOnBody)', async () => {
    const rank = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', {
          userId: DEMO_USER_ID,
          filters: { lengthOnBody: ['mid_calf'] },
          limit: 50,
          personalize: false,
        }),
      ),
    );
    expect(rank.items.length).toBeGreaterThan(0);
    for (const item of rank.items) expect(item.hem.position).toBe('mid_calf');
  });
});

describe('search (GET /api/search)', () => {
  it('applies explicit filters', async () => {
    const res = await searchGET(
      jsonReq('/api/search?sizes=6&priceMaxCents=15000&conditions=new', 'GET'),
    );
    const rank = await data(res);
    for (const item of rank.items) {
      expect(item.listing.sizeNormalized).toContain(6);
      expect(item.listing.priceCents).toBeLessThanOrEqual(15000);
      expect(item.listing.condition).toBe('new');
    }
  });

  it('free-text query narrows results', async () => {
    const rank = await data(await searchGET(jsonReq('/api/search?q=wrap', 'GET')));
    expect(rank.items.length).toBeGreaterThan(0);
    expect(rank.totalMatched).toBeLessThan(150);
  });

  it('works without a session (guest browse)', async () => {
    const res = await searchGET(new Request('http://test/api/search?sizes=8'));
    expect(res.status).toBe(200);
  });
});

describe('listing detail', () => {
  it('includes per-user hem result for the demo user + similar listings', async () => {
    const feed = await data(
      await rankPOST(jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 24, personalize: false })),
    );
    const withLength = feed.items.find((i: any) => i.listing.lengthInches != null);
    expect(withLength).toBeDefined();
    const id = withLength.listing.id;

    const detail = await data(
      await listingGET(jsonReq(`/api/listings/${encodeURIComponent(id)}`, 'GET'), {
        params: Promise.resolve({ id }),
      }),
    );
    expect(ListingDetailResponseSchema.parse(detail)).toBeTruthy();
    expect(detail.listing.id).toBe(id);
    expect(detail.listing.images.length).toBeGreaterThan(0);
    expect(detail.hem.position).not.toBeNull(); // demo user is 5'4" — hem computable
    expect(detail.hem.basis).toBe('measured_length');
    expect(detail.whyItWorks).toBeTypeOf('string'); // additive: server-composed one-liner
    expect(detail.similar.length).toBeGreaterThan(0);
    expect(detail.similar.map((s: any) => s.id)).not.toContain(id);
  });

  it('404s for unknown ids', async () => {
    const res = await listingGET(jsonReq('/api/listings/nope', 'GET'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('swipes', () => {
  it('records events and updates the learned styleTags', async () => {
    const feed = await data(
      await rankPOST(jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 3, personalize: false })),
    );
    const [a, b] = feed.items.map((i: any) => i.listing.id);
    const before = (await data(await profileGET(jsonReq('/api/profile', 'GET')))).styleTags;
    const res = await data(
      await swipesPOST(
        jsonReq('/api/swipes', 'POST', [
          { listingId: a, verdict: 'like', context: 'calibration' },
          { listingId: b, verdict: 'dislike', context: 'calibration' },
        ]),
      ),
    );
    expect(res.styleTags).toBeTypeOf('object');
    expect(JSON.stringify(res.styleTags)).not.toBe(JSON.stringify(before));

    const rows = db
      .select()
      .from(swipeEvents)
      .where(and(eq(swipeEvents.userId, DEMO_USER_ID), eq(swipeEvents.listingId, a)))
      .all();
    expect(rows.some((r) => r.verdict === 'like')).toBe(true);
  });
});

describe('saves / rack', () => {
  it('save → list → unsave roundtrip', async () => {
    const feed = await data(
      await rankPOST(jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 1, personalize: false })),
    );
    const id = feed.items[0].listing.id;

    await data(await savesPOST(jsonReq('/api/saves', 'POST', { listingId: id })));
    // idempotent double-save
    await data(await savesPOST(jsonReq('/api/saves', 'POST', { listingId: id })));

    const rack = await data(await savesGET(jsonReq('/api/saves', 'GET')));
    const ids = rack.items.map((i: any) => i.listing.id);
    expect(ids.filter((x: string) => x === id)).toHaveLength(1);
    expect(rack.items[0].hem).toBeDefined(); // cards carry effective length

    await data(
      await saveDELETE(jsonReq(`/api/saves/${encodeURIComponent(id)}`, 'DELETE'), {
        params: Promise.resolve({ listingId: id }),
      }),
    );
    const after = await data(await savesGET(jsonReq('/api/saves', 'GET')));
    expect(after.items.map((i: any) => i.listing.id)).not.toContain(id);
  });

  it('404s when saving an unknown listing', async () => {
    const res = await savesPOST(jsonReq('/api/saves', 'POST', { listingId: 'ghost:1' }));
    expect(res.status).toBe(404);
  });
});

describe('alerts (stub — stored, never sent)', () => {
  it('toggles and lists pending alerts', async () => {
    const feed = await data(
      await rankPOST(jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 1, personalize: false })),
    );
    const id = feed.items[0].listing.id;
    const created = await data(
      await alertsPOST(jsonReq('/api/alerts', 'POST', { kind: 'price_drop', enabled: true, listingId: id })),
    );
    expect(created.alert.enabled).toBe(true);

    const toggledOff = await data(
      await alertsPOST(jsonReq('/api/alerts', 'POST', { kind: 'price_drop', enabled: false, listingId: id })),
    );
    expect(toggledOff.alert.enabled).toBe(false);
    expect(toggledOff.alert.id).toBe(created.alert.id); // upsert, not duplicate

    const list = await data(await alertsGET(jsonReq('/api/alerts', 'GET')));
    expect(list.alerts.some((a: any) => a.listingId === id && a.kind === 'price_drop')).toBe(true);
  });
});

describe('find dresses like this', () => {
  it('extracts attributes via the real @hemline/ai service (honest mock mode keyless)', async () => {
    const res = await data(
      await findSimilarPOST(
        jsonReq('/api/find-similar', 'POST', {
          imageUrl: 'https://example.com/photos/green-floral-wrap-midi-dress.jpg',
        }),
      ),
    );
    expect(res.extractionMode).toBe('mock'); // no ANTHROPIC_API_KEY → rule engine (§7.5)
    expect(Object.keys(res.attributes)).toEqual(
      expect.arrayContaining(['silhouette:wrap', 'length:midi', 'pattern:floral', 'color:green']),
    );
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0].score).toBeGreaterThan(0);
  });

  it('falls back to nearest matches when nothing matches', async () => {
    const res = await data(
      await findSimilarPOST(jsonReq('/api/find-similar', 'POST', { hint: 'zzzz qqqq xxxx' })),
    );
    expect(res.fallback).toBe('nearest');
    expect(res.items.length).toBeGreaterThan(0);
  });
});

describe('meta/filters', () => {
  it('returns brands, color families, and price range', async () => {
    const meta = await data(await metaGET());
    expect(meta.brands.length).toBeGreaterThan(0);
    expect(meta.colorFamilies).toContain('green');
    expect(meta.priceRange[0]).toBeLessThanOrEqual(meta.priceRange[1]);
  });
});

describe('admin', () => {
  it('GET /api/admin/ingest reports per-source health', async () => {
    const health = await data(await adminIngestGET(jsonReq('/api/admin/ingest', 'GET')));
    expect(health.sources.length).toBe(2);
    const shopify = health.sources.find((s: any) => s.id === 'fixture:shopify');
    expect(shopify.listingCounts.total).toBeGreaterThan(0);
    expect(shopify.listingCounts.active).toBe(shopify.listingCounts.total);
  });

  it('POST /api/admin/ingest runs the REAL fixtures pipeline and returns runId', async () => {
    const res = await data(
      await adminIngestPOST(jsonReq('/api/admin/ingest', 'POST', { sourceId: 'fixture:shopify' })),
    );
    expect(res.runId).toBeGreaterThan(0);
    const health = await data(await adminIngestGET(jsonReq('/api/admin/ingest', 'GET')));
    const shopify = health.sources.find((s: any) => s.id === 'fixture:shopify');
    expect(shopify.lastRun.id).toBe(res.runId);
    // local/fixture sources run to completion before the response returns
    expect(shopify.lastRun.status).toBe('ok');
    expect((shopify.lastRun.stats as any).unchanged).toBeGreaterThan(0); // idempotent re-ingest
    // the pipeline registered the connector-level source row too
    expect(health.sources.some((s: any) => s.id === 'fixtures')).toBe(true);
  });

  it('extraction QA lists low-confidence rows and PATCH corrects them', async () => {
    const qa = await data(
      await adminExtractionsGET(jsonReq('/api/admin/extractions?maxConfidence=0.6', 'GET')),
    );
    expect(qa.items.length).toBeGreaterThan(0);
    const row = qa.items[0];
    expect(row.confidence).toBeLessThanOrEqual(0.6);

    const corrected = await data(
      await adminExtractionPATCH(
        jsonReq(`/api/admin/extractions/${row.contentHash}`, 'PATCH', {
          lengthInches: 42,
          lengthClass: 'midi',
          confidence: 1,
        }),
        { params: Promise.resolve({ contentHash: row.contentHash }) },
      ),
    );
    expect(corrected.lengthInches).toBe(42);
    expect(corrected.model).toBe('manual');
    expect(corrected.confidence).toBe(1);
  });

  it('enforces basic auth when ADMIN_BASIC_AUTH is set', async () => {
    process.env.ADMIN_BASIC_AUTH = 'op:secret';
    try {
      const denied = await adminIngestGET(jsonReq('/api/admin/ingest', 'GET'));
      expect(denied.status).toBe(401);
      const allowed = await adminIngestGET(
        jsonReq('/api/admin/ingest', 'GET', undefined, {
          authorization: `Basic ${Buffer.from('op:secret').toString('base64')}`,
        }),
      );
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.ADMIN_BASIC_AUTH;
    }
  });
});

/* ═══ QA P1 fixes (2026-07-08) ══════════════════════════════════════════ */

describe('profile numeric bounds (QA P1 #2)', () => {
  const patch = (body: unknown) => profilePATCH(jsonReq('/api/profile', 'PATCH', body));

  it('accepts the boundary heights 48 and 84 inches', async () => {
    expect((await patch({ heightInches: 48 })).status).toBe(200);
    expect((await patch({ heightInches: 84 })).status).toBe(200);
  });

  it('rejects junk heights (0 / 999 / −5 / just-outside) with the standard envelope', async () => {
    for (const h of [0, 999, -5, 47.9, 84.1]) {
      const res = await patch({ heightInches: h });
      expect(res.status, `height ${h}`).toBe(400);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.message).toContain('heightInches');
    }
  });

  it('rejects negative budgets and min > max; accepts sane windows', async () => {
    expect((await patch({ budget: { minCents: -100, maxCents: 40000 } })).status).toBe(400);
    expect((await patch({ budget: { minCents: 2000, maxCents: -1 } })).status).toBe(400);
    expect((await patch({ budget: { minCents: 40000, maxCents: 2000 } })).status).toBe(400);
    expect((await patch({ budget: { minCents: 0, maxCents: 0 } })).status).toBe(200);
    expect((await patch({ budget: { minCents: null, maxCents: 25000 } })).status).toBe(200);
  });

  it('rejects sizes outside the normalized 0–26 domain', async () => {
    expect((await patch({ sizesNormalized: [-2] })).status).toBe(400);
    expect((await patch({ sizesNormalized: [8, 28] })).status).toBe(400);
    expect((await patch({ sizesNormalized: [0, 26] })).status).toBe(200);
  });

  it('rejects non-numeric junk cleanly (NaN cannot ride JSON; strings 400)', async () => {
    expect((await patch({ heightInches: 'NaN' })).status).toBe(400);
    expect((await patch({ budget: { minCents: 'cheap', maxCents: null } })).status).toBe(400);
    // restore the demo profile for the suites below
    const restored = await data(
      await patch({ heightInches: 64, sizesNormalized: [6, 8], budget: { minCents: null, maxCents: null } }),
    );
    expect(restored.heightInches).toBe(64);
  });
});

describe('palette-boost toggle end-to-end (QA P1 #1)', () => {
  const rankAll = async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const res = await data(
        await rankPOST(
          jsonReq('/api/rank', 'POST', {
            userId: DEMO_USER_ID,
            filters: {},
            limit: 100,
            cursor,
            personalize: false,
          }),
        ),
      );
      total = res.totalMatched;
      ids.push(...res.items.map((i: any) => i.listing.id));
      cursor = res.nextCursor ?? undefined;
    } while (cursor);
    return { ids, total };
  };

  it('paletteBoostEnabled round-trips through PATCH/GET (default true)', async () => {
    const initial = await data(await profileGET(jsonReq('/api/profile', 'GET')));
    expect(initial.paletteBoostEnabled).toBe(true); // legacy/NULL → enabled

    const off = await data(
      await profilePATCH(jsonReq('/api/profile', 'PATCH', { paletteBoostEnabled: false })),
    );
    expect(off.paletteBoostEnabled).toBe(false);
    const read = await data(await profileGET(jsonReq('/api/profile', 'GET')));
    expect(read.paletteBoostEnabled).toBe(false);

    const on = await data(
      await profilePATCH(jsonReq('/api/profile', 'PATCH', { paletteBoostEnabled: true })),
    );
    expect(on.paletteBoostEnabled).toBe(true);
  });

  it('boost on vs off: identical result SET (never hides), different order', async () => {
    const prof = await data(await profileGET(jsonReq('/api/profile', 'GET')));
    expect(prof.palette.length).toBeGreaterThan(0); // seeded soft-autumn palette

    await data(await profilePATCH(jsonReq('/api/profile', 'PATCH', { paletteBoostEnabled: true })));
    const on = await rankAll();
    await data(await profilePATCH(jsonReq('/api/profile', 'PATCH', { paletteBoostEnabled: false })));
    const off = await rankAll();

    expect(off.total).toBe(on.total);
    expect([...off.ids].sort()).toEqual([...on.ids].sort()); // set identical
    expect(off.ids).not.toEqual(on.ids); // boost re-orders when palette matches exist

    // restore
    await data(await profilePATCH(jsonReq('/api/profile', 'PATCH', { paletteBoostEnabled: true })));
  });
});

describe('clickouts (spec G4, QA P1 #4)', () => {
  let listingId: string;

  it('records a clickout for a session user', async () => {
    const feed = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', { userId: DEMO_USER_ID, filters: {}, limit: 1, personalize: false }),
      ),
    );
    listingId = feed.items[0].listing.id;
    const res = await clickoutsPOST(jsonReq('/api/clickouts', 'POST', { listingId }));
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ recorded: true });
  });

  it('tolerates guests: no session, sendBeacon-style text/plain body', async () => {
    const res = await clickoutsPOST(
      new Request('http://test/api/clickouts', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' }, // sendBeacon default framing
        body: JSON.stringify({ listingId }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ recorded: true });
  });

  it('404s an unknown listing with the standard envelope', async () => {
    const res = await clickoutsPOST(jsonReq('/api/clickouts', 'POST', { listingId: 'fixture:nope:1' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('rejects a malformed body cleanly', async () => {
    expect((await clickoutsPOST(jsonReq('/api/clickouts', 'POST', {}))).status).toBe(400);
  });

  it('surfaces aggregate counts in GET /api/admin/ingest (additive field)', async () => {
    const health = await data(await adminIngestGET(jsonReq('/api/admin/ingest', 'GET')));
    expect(health.clickouts.total).toBeGreaterThanOrEqual(2);
    expect(health.clickouts.last24h).toBeGreaterThanOrEqual(2);
    expect(health.clickouts.bySource['fixture:shopify']).toBeGreaterThanOrEqual(2);
  });
});

describe('currency (QA P1 #3): GBP fixture', () => {
  const GBP_ID = 'fixture:shopify:sister-jane-tapestry-jacquard-midi-9901';

  it('serves the native GBP price on detail (display is native-currency)', async () => {
    const detail = await data(
      await listingGET(jsonReq(`/api/listings/${encodeURIComponent(GBP_ID)}`, 'GET'), {
        params: Promise.resolve({ id: GBP_ID }),
      }),
    );
    expect(detail.listing.priceCents).toBe(12900);
    expect(detail.listing.currency).toBe('GBP');
  });

  it('budget hard-filter compares the USD equivalent, not raw pence', async () => {
    // £129 → 16383 USD¢: a $150 max budget must exclude it even though the raw
    // pence value (12900) would slip under; $170 must include it.
    const under = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', {
          userId: DEMO_USER_ID,
          filters: { query: 'tapestry jacquard', priceMaxCents: 15000 },
          limit: 10,
          personalize: false,
        }),
      ),
    );
    expect(under.items.map((i: any) => i.listing.id)).not.toContain(GBP_ID);
    const over = await data(
      await rankPOST(
        jsonReq('/api/rank', 'POST', {
          userId: DEMO_USER_ID,
          filters: { query: 'tapestry jacquard', priceMaxCents: 17000 },
          limit: 10,
          personalize: false,
        }),
      ),
    );
    expect(over.items.map((i: any) => i.listing.id)).toContain(GBP_ID);
  });
});
