/**
 * Paste-a-dress-link fit check tests (2026-07-13).
 *
 * Route + service against a temp seeded SQLite db, with an injected fetch —
 * no live network. Covers: the JSON-LD happy path on the RECORDED
 * thereformation.com fixture, deterministic fit math vs the demo profile
 * (5'4", sizes 6–8), the Shopify .js tier, the URL-hash cache (repeat pastes
 * cost zero fetches), and the full degradation matrix (keyless extraction,
 * no-ml similarity, bot-blocked pages, robots disallow, SSRF-blocked URLs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AnalyticsEventSchema,
  FitCheckResponseSchema,
} from '@hemline/contracts';
import {
  createDb,
  DEMO_USER_ID,
  ensureSchema,
  getFitCheckCache,
  getUserProfile,
  runSeed,
  setFitCheckCache,
  type Db,
} from '@hemline/db';
import { __resetDbCache } from '../lib/db';
import { runFitCheck, sizeMatchFor, normalizePastedUrl } from '../lib/fit-check';
import type { Resolver } from '../lib/safe-url';
import { USER_ID_HEADER } from '../lib/session';
import { POST as fitCheckPOST } from '../fit-check/route';

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-fitcheck-test-'));
  const dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  runSeed(dbPath);
  process.env.DATABASE_PATH = dbPath;
  delete process.env.ANTHROPIC_API_KEY; // keyless: deterministic extraction
  __resetDbCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const publicResolver: Resolver = async () => [{ address: '93.184.216.34' }];

const REF_FIXTURE = fs.readFileSync(
  path.join(
    __dirname,
    '../../../../../packages/connectors/src/external/__fixtures__/reformation-winslow-dress.html',
  ),
  'utf-8',
);
const REF_URL = 'https://www.thereformation.com/products/winslow-dress/0503333.html';

/** fetch stub: robots 404 + one PDP; everything else 404. */
function pdpFetch(pages: Record<string, string | Response>): typeof fetch {
  return async (input) => {
    const url = String(input);
    const hit = Object.entries(pages).find(([k]) => url === k || url.startsWith(k));
    if (!hit) return new Response('not found', { status: 404 });
    const body = hit[1];
    return body instanceof Response
      ? body
      : new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

const profile = () => getUserProfile(db, DEMO_USER_ID)!;

describe('normalizePastedUrl', () => {
  it('strips fragments and tracking params, keeps meaningful query', () => {
    expect(
      normalizePastedUrl('https://store.com/products/x?variant=1&utm_source=ig&fbclid=abc#gallery'),
    ).toBe('https://store.com/products/x?variant=1');
  });
});

describe('happy path: recorded Reformation JSON-LD PDP', () => {
  it('reads the garment and answers with an honest, contract-valid fit check', async () => {
    const result = await runFitCheck(db, profile(), REF_URL, {
      fetchImpl: pdpFetch({ [REF_URL]: REF_FIXTURE }),
      resolver: publicResolver,
    });
    expect(FitCheckResponseSchema.parse(result)).toBeTruthy();
    expect(result.outcome).toBe('ok');
    expect(result.product).toMatchObject({
      title: 'Winslow Dress',
      brand: 'Reformation',
      priceCents: 34800,
      currency: 'USD',
      domain: 'thereformation.com',
      via: 'jsonld',
    });
    // stated model height parsed from the page copy (5'9")
    expect(result.modelHeightInches).toBe(69);
    // keyless → honest deterministic extraction; no ml → attribute similarity
    expect(result.extractionMode).toBe('mock');
    expect(['attributes', 'none']).toContain(result.matchBasis);
    // no stated length + no length keyword → hem is honest about not knowing
    expect(result.hem).not.toBeNull();
    expect(result.inCatalog).toBe(false);
    expect(result.keywords).toEqual(['winslow', 'dress']);
    expect(result.cached).toBe(false);
  });

  it('serves the repeat paste from the URL-hash cache (zero fetches)', async () => {
    const noFetch: typeof fetch = async () => {
      throw new Error('cache miss — the repeat paste must not fetch');
    };
    const result = await runFitCheck(db, profile(), REF_URL, {
      fetchImpl: noFetch,
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('ok');
    expect(result.cached).toBe(true);
    expect(result.product?.title).toBe('Winslow Dress');
  });
});

describe('fit-check math vs the known demo profile (5\'4", sizes 6–8)', () => {
  const SYNTH_URL = 'https://someboutique.com/products/silene-silk-midi-wrap-dress';
  const SYNTH_PDP = `<!DOCTYPE html><html><head><title>Silene Dress</title>
    <script type="application/ld+json">
    {"@context":"http://schema.org/","@type":"Product","name":"Silene Silk Midi Wrap Dress",
     "description":"Bias-cut silk. Length: 44 in. The model is 5'10\\" and wears a size S.",
     "brand":"Some Boutique",
     "image":["https://cdn.someboutique.com/silene.jpg"],
     "offers":[
       {"@type":"Offer","priceCurrency":"USD","price":"120.00","size":"6","availability":"http://schema.org/InStock"},
       {"@type":"Offer","priceCurrency":"USD","price":"120.00","size":"8","availability":"http://schema.org/InStock"},
       {"@type":"Offer","priceCurrency":"USD","price":"120.00","size":"10","availability":"http://schema.org/OutOfStock"}
     ]}
    </script></head><body></body></html>`;

  it('computes the §5 hem verdict from the stated 44″ length', async () => {
    const result = await runFitCheck(db, profile(), SYNTH_URL, {
      fetchImpl: pdpFetch({ [SYNTH_URL]: SYNTH_PDP }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('ok');
    expect(result.lengthInches).toBe(44);
    // 5'4", no heels: S = 0.82·64 = 52.48; hem = 8.48 above floor;
    // r = 8.48/64 ≈ 0.1325 → mid_calf ("this midi hits mid-calf on you")
    expect(result.hem).toMatchObject({
      position: 'mid_calf',
      basis: 'measured_length',
      confidence: 'high',
    });
    expect(result.hem!.hemAboveFloorInches).toBeCloseTo(8.48, 1);
    expect(result.modelHeightInches).toBe(70);
    // sizes 6/8 listed and in stock → in her size
    expect(result.sizeMatch).toBe('in_your_size');
  });

  it('returns similar in-catalog dresses constrained to her size/budget', async () => {
    const result = await runFitCheck(db, profile(), SYNTH_URL, {
      fetchImpl: pdpFetch({ [SYNTH_URL]: SYNTH_PDP }),
      resolver: publicResolver,
    });
    expect(result.matchBasis).toBe('attributes'); // no ml sidecar in tests
    expect(result.similar.length).toBeGreaterThan(0);
    expect(result.similar.length).toBeLessThanOrEqual(8);
    for (const item of result.similar) {
      // her sizes when the constrained pool matched (it does on the seed corpus)
      expect(item.listing.sizeNormalized.some((n) => [6, 8].includes(n))).toBe(true);
      expect(item.listing.priceCents).toBeLessThanOrEqual(25000);
      // hem computed for HER on every similar card
      expect(item.hem).toBeDefined();
    }
  });

  it('computes hem basis none for a guest with no height', async () => {
    const result = await runFitCheck(db, null, SYNTH_URL, {
      fetchImpl: pdpFetch({ [SYNTH_URL]: SYNTH_PDP }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('ok');
    expect(result.hem).toMatchObject({ position: null, basis: 'none' });
    expect(result.sizeMatch).toBe('unknown'); // no profile sizes
  });
});

describe('Shopify .js tier', () => {
  const STAUD_URL = 'https://staud.clothing/products/yuca-dress-tidal-shell';
  const STAUD_JS = fs.readFileSync(
    path.join(
      __dirname,
      '../../../../../packages/connectors/src/external/__fixtures__/staud-yuca-dress.js.json',
    ),
    'utf-8',
  );

  it('prefers the storefront .js payload over the HTML parse', async () => {
    const result = await runFitCheck(db, profile(), STAUD_URL, {
      fetchImpl: pdpFetch({
        [`${STAUD_URL}.js`]: new Response(STAUD_JS, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('ok');
    expect(result.product).toMatchObject({ via: 'shopify_js', priceCents: 37500 });
    expect(result.product!.sizeLabels).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    // alpha sizes: M maps onto her normalized 6–8 → in her size
    expect(result.sizeMatch).toBe('in_your_size');
  });
});

describe('degradation matrix', () => {
  it('bot-blocked page → honest unreadable + slug keywords (never a throw)', async () => {
    const url = 'https://blocked.example.com/products/emerald-satin-maxi-dress';
    const result = await runFitCheck(db, profile(), url, {
      fetchImpl: pdpFetch({ [url]: new Response('denied', { status: 403 }) }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('unreadable');
    expect(result.keywords).toEqual(['emerald', 'satin', 'maxi', 'dress']);
    expect(result.similar).toEqual([]);
  });

  it('negative-caches the failure so retries do not hammer the store', async () => {
    const url = 'https://blocked.example.com/products/emerald-satin-maxi-dress';
    const noFetch: typeof fetch = async () => {
      throw new Error('negative cache miss — must not refetch inside the TTL');
    };
    const result = await runFitCheck(db, profile(), url, {
      fetchImpl: noFetch,
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('unreadable');
    expect(result.cached).toBe(true);
  });

  it('robots.txt disallow → unreadable (we respect the store)', async () => {
    const url = 'https://politestore.example.com/products/poplin-midi-dress';
    const result = await runFitCheck(db, profile(), url, {
      fetchImpl: pdpFetch({
        'https://politestore.example.com/robots.txt': 'User-agent: *\nDisallow: /',
      }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('unreadable');
    expect(result.keywords).toContain('dress');
  });

  it('SSRF-blocked URLs → blocked_url without touching the network', async () => {
    const neverFetch: typeof fetch = async () => {
      throw new Error('must not fetch a blocked URL');
    };
    for (const url of [
      'http://insecure.com/products/dress',
      'https://127.0.0.1/products/dress',
      'https://169.254.169.254/latest/meta-data/',
      'https://localhost/products/dress',
    ]) {
      const result = await runFitCheck(db, profile(), url, { fetchImpl: neverFetch });
      expect(result.outcome).toBe('blocked_url');
    }
  });

  it('kids items are reported gracefully', async () => {
    const url = 'https://kidstore.example.com/products/mini-me-smocked-dress';
    const kidJs = JSON.stringify({
      title: 'Mini Me Smocked Dress',
      type: 'Dresses',
      price: 4500,
      options: [{ name: 'Size', position: 1, values: ['2T', '3T', '4T'] }],
      variants: [
        { id: 1, title: '2T', option1: '2T', option2: null, option3: null, price: 4500, available: true },
        { id: 2, title: '3T', option1: '3T', option2: null, option3: null, price: 4500, available: true },
        { id: 3, title: '4T', option1: '4T', option2: null, option3: null, price: 4500, available: true },
      ],
      tags: ['kids', 'toddler girls'],
    });
    const result = await runFitCheck(db, profile(), url, {
      fetchImpl: pdpFetch({
        [`${url}.js`]: new Response(kidJs, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('child_audience');
    expect(result.product).toBeNull();
  });

  it('non-dress products are reported honestly', async () => {
    const url = 'https://someboutique.example.com/products/leather-tote';
    const toteHtml = `<html><head><title>Leather Tote</title>
      <meta property="og:title" content="Leather Tote" /></head><body></body></html>`;
    const result = await runFitCheck(db, profile(), url, {
      fetchImpl: pdpFetch({ [url]: toteHtml }),
      resolver: publicResolver,
    });
    expect(result.outcome).toBe('not_a_dress');
  });
});

describe('sizeMatchFor', () => {
  it('maps her sizes onto page labels', () => {
    expect(sizeMatchFor([6, 8], ['6', '8', '10'], { '6': true })).toBe('in_your_size');
    expect(sizeMatchFor([6, 8], ['6'], { '6': false })).toBe('listed_sold_out');
    expect(sizeMatchFor([6, 8], ['0', '2'], {})).toBe('not_listed');
    expect(sizeMatchFor([], ['6'], {})).toBe('unknown');
    expect(sizeMatchFor([6], [], {})).toBe('unknown');
    // no per-size stock signal → listed is honestly "in your size"
    expect(sizeMatchFor([8], ['S', 'M', 'L'], {})).toBe('in_your_size');
  });
});

describe('POST /api/fit-check (route)', () => {
  const headers = { [USER_ID_HEADER]: DEMO_USER_ID, 'content-type': 'application/json' };

  it('rejects a non-JSON body', async () => {
    const res = await fitCheckPOST(
      new Request('http://test/api/fit-check', { method: 'POST', headers, body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a missing url', async () => {
    const res = await fitCheckPOST(
      new Request('http://test/api/fit-check', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('answers blocked_url for private/non-https URLs without fetching', async () => {
    const res = await fitCheckPOST(
      new Request('http://test/api/fit-check', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: 'https://127.0.0.1/products/dress' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { outcome: string } };
    expect(body.ok).toBe(true);
    expect(body.data.outcome).toBe('blocked_url');
  });

  it('mints a session for guests (share-sheet first touch)', async () => {
    const res = await fitCheckPOST(
      new Request('http://test/api/fit-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://127.0.0.1/products/dress' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('hemline_session=');
  });
});

describe('analytics whitelist additions', () => {
  it('accepts the fit_check events with exact props', () => {
    expect(
      AnalyticsEventSchema.safeParse({
        type: 'fit_check_submitted',
        props: { parsed: true, inCatalog: false },
      }).success,
    ).toBe(true);
    expect(
      AnalyticsEventSchema.safeParse({ type: 'fit_check_result_clicked', props: {} }).success,
    ).toBe(true);
  });

  it('rejects junk props (closed whitelist)', () => {
    expect(
      AnalyticsEventSchema.safeParse({
        type: 'fit_check_submitted',
        props: { parsed: true, inCatalog: false, url: 'https://pii.example.com' },
      }).success,
    ).toBe(false);
    expect(
      AnalyticsEventSchema.safeParse({ type: 'fit_check_result_clicked', props: { x: 1 } }).success,
    ).toBe(false);
  });
});

describe('fit_check_cache repository', () => {
  it('round-trips and upserts by url hash', () => {
    const url = 'https://cache.example.com/products/test-dress';
    setFitCheckCache(db, url, { page: { outcome: 'ok', product: null } }, 1000);
    expect(getFitCheckCache(db, url, 2000)).toEqual({ page: { outcome: 'ok', product: null } });
    setFitCheckCache(db, url, { page: null, negative: true }, 3000);
    expect(getFitCheckCache(db, url, 4000)).toEqual({ page: null, negative: true });
  });

  it('expires successful parses after ~24h and negatives after ~5min', () => {
    const url = 'https://cache.example.com/products/ttl-dress';
    setFitCheckCache(db, url, { page: {} }, 0);
    expect(getFitCheckCache(db, url, 23 * 3_600_000)).not.toBeNull();
    expect(getFitCheckCache(db, url, 25 * 3_600_000)).toBeNull();
    setFitCheckCache(db, url, { page: null, negative: true }, 0);
    expect(getFitCheckCache(db, url, 4 * 60_000)).not.toBeNull();
    expect(getFitCheckCache(db, url, 6 * 60_000)).toBeNull();
  });
});
