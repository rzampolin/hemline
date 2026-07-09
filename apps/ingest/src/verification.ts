/**
 * Sold/dead-listing verification worker (spec freshness story, 2026-07-09).
 *
 * Between daily crawls a sold dress stays fully visible; this job re-checks a
 * small batch of listings CHEAPLY per source kind (pure HTTP through the
 * existing politeness stack — no AI cost):
 *
 * - shopify:  one request to the store's single-product `{sourceUrl}.js`
 *   (the storefront product endpoint — verified live 2026-07-09: it carries
 *   explicit per-variant `available` booleans and the same options/option1-3
 *   shape as products.json, while `{sourceUrl}.json` OMITS `available`).
 *   404/410 → confirmed against the `.json` mirror, then gone; explicit
 *   per-variant flags drive sold-out / per-size updates via the shared
 *   `shopifyAvailability` helper.
 * - jsonld:   one PDP fetch, availability from JSON-LD/microdata via the same
 *   `extractListingFromHtml` the crawler uses. Archived PDPs that keep the
 *   Product node but drop price/stock (decisions-data-eng #16) are only
 *   marked sold on an EXPLICIT all-OutOfStock offer signal.
 * - ebay/fixture: unsupported (Browse API auth / no live source) — never
 *   selected or enqueued; a stray id reports 'unsupported' and changes nothing.
 *
 * Error discipline: per-listing isolation; transient failures (network error,
 * 429/5xx after politeFetch's retry, unparseable payload) apply NO state
 * change — timeout ≠ sold. A per-host circuit breaker (3 consecutive
 * failures) abandons that host for the rest of the run (decisions #20).
 */
import type { Logger } from '@hemline/contracts';
import {
  collectProductNodes,
  extractJsonLdBlocks,
  extractListingFromHtml,
  extractMicrodata,
  findJsonldStore,
  flattenOffers,
  politeFetch,
  shopifyAvailability,
  type JsonLdNode,
  type PolitenessOptions,
  type ShopifyProduct,
} from '@hemline/connectors';
import {
  applyVerifiedAvailability,
  dequeueVerification,
  getVerifiableListings,
  markListingGone,
  markListingVerified,
  peekVerificationQueue,
  selectOldestVerifiedActive,
  verificationQueueSize,
  type Db,
  type VerifiableListing,
} from '@hemline/db';

export type VerifyOutcome =
  | 'gone' // 404/410 or all variants explicitly sold out → removed_at set
  | 'sold_out' // page alive but every size/offer explicitly out of stock → removed_at set
  | 'availability_updated' // some sizes gone → availability + size_normalized updated
  | 'ok' // verified fine → verified_at bumped
  | 'inconclusive' // transient/ambiguous → NO state change
  | 'unsupported'; // source kind not verifiable / listing unknown

export interface VerifyResult {
  listingId: string;
  outcome: VerifyOutcome;
  note?: string;
}

export interface VerifyDeps {
  /** injectable fetch (tests); threaded into politeFetch */
  fetchImpl?: typeof fetch;
  /** per-host politeness delay override (tests use 0) */
  minDelayMs?: number;
  /** politeFetch 429/5xx retries (default 1) */
  retries?: number;
  now?: () => number;
  logger?: Logger;
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** consecutive same-host failures before the run abandons that host */
const HOST_FAILURE_LIMIT = 3;

function politenessOpts(deps: VerifyDeps): PolitenessOptions {
  const opts: PolitenessOptions = {};
  if (deps.fetchImpl) opts.fetchImpl = deps.fetchImpl;
  if (deps.minDelayMs != null) opts.minDelayMs = deps.minDelayMs;
  if (deps.retries != null) opts.retries = deps.retries;
  return opts;
}

/** `https://store/products/handle[?q][#h]` → `https://store/products/handle{suffix}` */
export function shopifyProductUrl(sourceUrl: string, suffix: '.js' | '.json'): string {
  const u = new URL(sourceUrl);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\.(js|json)$/, '');
  u.pathname += suffix;
  return u.toString();
}

function sameAvailability(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
}

/**
 * Explicit schema.org stock signal from a PDP whose Product node no longer
 * normalizes to a listing (archived pages drop the price — decisions #16).
 * Scans JSON-LD first, then microdata; offers without an availability string
 * are ignored (absence is never evidence of sold-out).
 */
export function explicitStructuredStockSignal(html: string): 'in_stock' | 'out_of_stock' | null {
  const nodes: JsonLdNode[] = collectProductNodes(extractJsonLdBlocks(html).parsed);
  nodes.push(...extractMicrodata(html).products);

  const flags: boolean[] = [];
  for (const node of nodes) {
    const offerSources: unknown[] = [node.offers];
    const hv = node.hasVariant;
    for (const v of Array.isArray(hv) ? hv : hv == null ? [] : [hv]) {
      if (typeof v === 'object' && v !== null) offerSources.push((v as JsonLdNode).offers);
    }
    for (const src of offerSources) {
      for (const offer of flattenOffers(src)) {
        if (offer.available != null) flags.push(offer.available);
      }
    }
  }
  if (flags.length === 0) return null;
  if (flags.some((f) => f)) return 'in_stock';
  return 'out_of_stock';
}

interface VerifyContext {
  db: Db;
  deps: VerifyDeps;
  now: number;
  polite: PolitenessOptions;
}

async function verifyShopifyListing(
  ctx: VerifyContext,
  listing: VerifiableListing,
): Promise<VerifyResult> {
  // Primary signal: the storefront `.js` product endpoint — the only public
  // single-product payload with explicit per-variant `available` booleans
  // (`.json` omits them; verified live on staud.clothing, 2026-07-09). Its
  // options/option1-3 shape matches products.json, so shopifyAvailability
  // reads it directly. Body is the bare product (not `{product: …}`).
  const jsUrl = shopifyProductUrl(listing.sourceUrl, '.js');
  const res = await politeFetch(jsUrl, { headers: { accept: 'application/json' } }, ctx.polite);

  let product: ShopifyProduct | undefined;
  if (res.status === 404 || res.status === 410) {
    // Confirm on the `.json` mirror before marking gone — belt against
    // themes/stores that disable the `.js` route for live products.
    const jsonRes = await politeFetch(
      shopifyProductUrl(listing.sourceUrl, '.json'),
      { headers: { accept: 'application/json' } },
      ctx.polite,
    );
    if (jsonRes.status === 404 || jsonRes.status === 410) {
      markListingGone(ctx.db, listing.id, ctx.now);
      return { listingId: listing.id, outcome: 'gone', note: `http_${res.status}` };
    }
    if (!jsonRes.ok) {
      return { listingId: listing.id, outcome: 'inconclusive', note: `http_${jsonRes.status}` };
    }
    try {
      product = ((await jsonRes.json()) as { product?: ShopifyProduct })?.product;
    } catch {
      return { listingId: listing.id, outcome: 'inconclusive', note: 'unparseable_json' };
    }
  } else if (!res.ok) {
    return { listingId: listing.id, outcome: 'inconclusive', note: `http_${res.status}` };
  } else {
    try {
      product = (await res.json()) as ShopifyProduct;
    } catch {
      return { listingId: listing.id, outcome: 'inconclusive', note: 'unparseable_json' };
    }
  }
  if (!product || !Array.isArray(product.variants)) {
    return { listingId: listing.id, outcome: 'inconclusive', note: 'no_product_payload' };
  }

  const signal = shopifyAvailability(product);
  if (!signal.hasStockSignal) {
    // page alive but this payload shape omits `available` — never infer sold
    markListingVerified(ctx.db, listing.id, ctx.now);
    return { listingId: listing.id, outcome: 'ok', note: 'no_stock_signal' };
  }
  if (!signal.anyAvailable) {
    markListingGone(ctx.db, listing.id, ctx.now);
    return { listingId: listing.id, outcome: 'sold_out' };
  }
  if (Object.keys(signal.availability).length > 0) {
    const changed = !sameAvailability(signal.availability, listing.availability);
    applyVerifiedAvailability(ctx.db, listing.id, signal.availability, ctx.now);
    return { listingId: listing.id, outcome: changed ? 'availability_updated' : 'ok' };
  }
  markListingVerified(ctx.db, listing.id, ctx.now);
  return { listingId: listing.id, outcome: 'ok' };
}

async function verifyJsonldListing(
  ctx: VerifyContext,
  listing: VerifiableListing,
): Promise<VerifyResult> {
  const domain = listing.sourceId.slice('jsonld:'.length);
  const store = findJsonldStore(domain);
  if (!store) {
    return { listingId: listing.id, outcome: 'unsupported', note: 'store_not_configured' };
  }

  const res = await politeFetch(
    listing.sourceUrl,
    { headers: { accept: 'text/html,application/xhtml+xml' } },
    ctx.polite,
  );
  if (res.status === 404 || res.status === 410) {
    markListingGone(ctx.db, listing.id, ctx.now);
    return { listingId: listing.id, outcome: 'gone', note: `http_${res.status}` };
  }
  if (!res.ok) return { listingId: listing.id, outcome: 'inconclusive', note: `http_${res.status}` };

  const html = await res.text();
  const page = extractListingFromHtml(html, store, listing.sourceUrl, ctx.now);

  if (page.listing) {
    const availability = page.listing.availability ?? {};
    const flags = Object.values(availability);
    if (flags.length > 0 && !flags.some(Boolean)) {
      markListingGone(ctx.db, listing.id, ctx.now);
      return { listingId: listing.id, outcome: 'sold_out' };
    }
    if (flags.length > 0) {
      const changed = !sameAvailability(availability, listing.availability);
      applyVerifiedAvailability(ctx.db, listing.id, availability, ctx.now);
      return { listingId: listing.id, outcome: changed ? 'availability_updated' : 'ok' };
    }
    markListingVerified(ctx.db, listing.id, ctx.now);
    return { listingId: listing.id, outcome: 'ok', note: 'no_size_signal' };
  }

  // No normalizable listing on the page. Archived/sold-out PDPs collapse to a
  // priceless OutOfStock offer (seen live on thereformation.com) — mark sold
  // ONLY on that explicit signal; everything else is ambiguous (JS-rendered
  // hiccup, soft-404 redirect, theme change) and must not remove the listing.
  const explicit = explicitStructuredStockSignal(html);
  if (explicit === 'out_of_stock') {
    markListingGone(ctx.db, listing.id, ctx.now);
    return { listingId: listing.id, outcome: 'sold_out', note: page.outcome };
  }
  if (explicit === 'in_stock') {
    markListingVerified(ctx.db, listing.id, ctx.now);
    return { listingId: listing.id, outcome: 'ok', note: `alive_${page.outcome}` };
  }
  return { listingId: listing.id, outcome: 'inconclusive', note: page.outcome };
}

/**
 * Re-check availability for a batch of listings. Per-listing error isolation:
 * one failure never aborts the batch, and transient errors change nothing.
 */
export async function verifyListings(
  db: Db,
  listingIds: string[],
  deps: VerifyDeps = {},
): Promise<VerifyResult[]> {
  const logger = deps.logger ?? silentLogger;
  const now = deps.now?.() ?? Date.now();
  const ctx: VerifyContext = { db, deps, now, polite: politenessOpts(deps) };

  const byId = new Map(getVerifiableListings(db, listingIds).map((l) => [l.id, l]));
  const hostFailures = new Map<string, number>();
  const results: VerifyResult[] = [];

  for (const id of listingIds) {
    const listing = byId.get(id);
    if (!listing) {
      results.push({ listingId: id, outcome: 'unsupported', note: 'unknown_listing' });
      continue;
    }
    if (listing.removedAt != null) {
      results.push({ listingId: id, outcome: 'ok', note: 'already_removed' });
      continue;
    }

    let host: string;
    try {
      host = new URL(listing.sourceUrl).host;
    } catch {
      results.push({ listingId: id, outcome: 'inconclusive', note: 'bad_source_url' });
      continue;
    }
    if ((hostFailures.get(host) ?? 0) >= HOST_FAILURE_LIMIT) {
      results.push({ listingId: id, outcome: 'inconclusive', note: 'host_circuit_open' });
      continue;
    }

    let result: VerifyResult;
    try {
      if (listing.sourceId.startsWith('shopify:')) {
        result = await verifyShopifyListing(ctx, listing);
      } else if (listing.sourceId.startsWith('jsonld:')) {
        result = await verifyJsonldListing(ctx, listing);
      } else {
        result = { listingId: id, outcome: 'unsupported', note: listing.sourceId };
      }
    } catch (e) {
      // network error / timeout — transient by definition, never a mark
      result = {
        listingId: id,
        outcome: 'inconclusive',
        note: e instanceof Error ? e.message : String(e),
      };
    }

    if (result.outcome === 'inconclusive') {
      hostFailures.set(host, (hostFailures.get(host) ?? 0) + 1);
    } else {
      hostFailures.set(host, 0);
    }
    results.push(result);
    logger.info(
      `[verify] ${id} → ${result.outcome}${result.note ? ` (${result.note})` : ''}`,
    );
  }
  return results;
}

// ── scheduler ticks ───────────────────────────────────────────────────────

export interface VerifyEnvConfig {
  enabled: boolean;
  /** clickout-queue drain cadence (default every 15 min) */
  clickCron: string;
  /** rolling catalog sweep cadence (default hourly) */
  rollingCron: string;
  /** max queue entries verified per drain tick */
  queueBatch: number;
  /** rolling batch size per tick (oldest-verified first) */
  rollingBatch: number;
}

export function verifyEnvConfig(env: NodeJS.ProcessEnv = process.env): VerifyEnvConfig {
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    enabled: env.VERIFY_ENABLE !== 'false',
    clickCron: env.VERIFY_CLICK_CRON ?? '*/15 * * * *',
    rollingCron: env.VERIFY_ROLLING_CRON ?? '0 * * * *',
    queueBatch: num(env.VERIFY_QUEUE_BATCH, 25),
    rollingBatch: num(env.VERIFY_ROLLING_BATCH, 50),
  };
}

/**
 * Drain up to `limit` clicked-listing queue entries. Entries are removed
 * after the attempt regardless of outcome — an inconclusive listing is
 * retried by the rolling sweep, not by hammering the queue.
 */
export async function drainVerificationQueue(
  db: Db,
  limit: number,
  deps: VerifyDeps = {},
): Promise<VerifyResult[]> {
  const queued = peekVerificationQueue(db, limit);
  if (queued.length === 0) return [];
  const results = await verifyListings(db, queued.map((q) => q.listingId), deps);
  dequeueVerification(db, queued.map((q) => q.listingId));
  const logger = deps.logger ?? silentLogger;
  logger.info(
    `[verify:clicked] ${summarize(results)} (queue remaining: ${verificationQueueSize(db)})`,
  );
  return results;
}

/** Rolling catalog sweep: verify the `limit` oldest-verified active listings. */
export async function runRollingVerification(
  db: Db,
  limit: number,
  deps: VerifyDeps = {},
): Promise<VerifyResult[]> {
  const ids = selectOldestVerifiedActive(db, limit);
  if (ids.length === 0) return [];
  const results = await verifyListings(db, ids, deps);
  const logger = deps.logger ?? silentLogger;
  logger.info(`[verify:rolling] ${summarize(results)}`);
  return results;
}

export function summarize(results: VerifyResult[]): string {
  const counts = new Map<VerifyOutcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, v]) => `${k}=${v}`);
  return `${results.length} checked: ${parts.join(' ') || 'none'}`;
}
