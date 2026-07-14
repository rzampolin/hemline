/**
 * Paste-a-dress-link fit check — orchestration (2026-07-13).
 *
 * runFitCheck(url, HER profile) →
 *   1. SSRF-guarded fetch of the pasted PDP (safe-url.ts; robots.txt
 *      respected; Shopify /products/{handle}.js tried first — richest data);
 *   2. parse via @hemline/connectors' external chain (.js → JSON-LD →
 *      microdata → og:) — the product is EPHEMERAL, never stored as a listing;
 *   3. attribute extraction via @hemline/ai (live Haiku with a hard deadline,
 *      deterministic rule engine keyless — §7.5 degradation built in);
 *   4. the FIT CHECK: effective hem for her height (packages/matching §5),
 *      size availability vs her sizes, audience gate;
 *   5. similar in-catalog: FashionSigLIP embedding of the product image when
 *      the ml sidecar is up, attribute-vector cosine otherwise — top 8 in her
 *      size/budget (relaxed when that empties the rack).
 *
 * The user-independent parse (+extraction) is cached ~24h by URL hash
 * (fit_check_cache) so repeat pastes cost zero fetches and zero AI spend;
 * fetch failures are cached as short-TTL negative entries. Degradation is
 * total: every failure mode is an honest outcome, never a 500, never a hang.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  ExtractedAttributes,
  FitCheckOutcome,
  FitCheckProduct,
  FitCheckResponse,
  FitCheckSizeMatch,
  RankedListing,
  UserProfile,
} from '@hemline/contracts';
import { createExtractionService, mockExtract, parseModelInfo } from '@hemline/ai';
import {
  isPathAllowed,
  isShopifyProductUrl,
  keywordsFromUrl,
  parseExternalProductPage,
  parseExternalShopifyProduct,
  shopifyJsUrl,
  type ExternalProduct,
  type ParsedExternalPage,
} from '@hemline/connectors';
import {
  getFitCheckCache,
  getListingsByIds,
  listings,
  normalizeSizeLabels,
  queryCandidates,
  setFitCheckCache,
  type CandidateListing,
  type Db,
} from '@hemline/db';
import { computeHem, cosineSimilarity } from '@hemline/matching';
import { findSimilarByEmbedding } from './embeddings';
import { getAiClient, hemForUser, paletteMatches } from './matching';
import { safeFetchExternalPage, type Resolver, type SafeFetchResult } from './safe-url';

/** Similar-rack size (spec: top 8 in her size/budget). */
export const FIT_CHECK_SIMILAR_LIMIT = 8;
/** Hard deadline for the live extraction call — degrade to the rule engine. */
export const FIT_CHECK_EXTRACTION_TIMEOUT_MS = 15_000;
/** robots.txt fetch gets a short leash — unreachable robots = allowed. */
const ROBOTS_TIMEOUT_MS = 4_000;
const ROBOTS_MAX_BYTES = 256 * 1024;

export interface FitCheckDeps {
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  /** override the page-fetch timeout (tests) */
  timeoutMs?: number;
  extractionTimeoutMs?: number;
  now?: () => number;
}

/** Tracking params stripped before hashing/fetching (cache hygiene). */
const TRACKING_PARAM_RE = /^(utm_|fbclid|gclid|mc_|igsh|ref$|si$)/i;

export function normalizePastedUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = '';
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAM_RE.test(k));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  return url.toString();
}

// ── cached page payload (user-independent half of the fit check) ──────────

interface PagePayload {
  parse: ParsedExternalPage;
  attributes: ExtractedAttributes | null;
  extractionMode: 'live' | 'mock';
  /** stated model height, parsed from the FULL page text at fetch time
   * (brands put "model is 5'9\"" in body copy, not in the JSON-LD) */
  modelHeightInches: number | null;
  /** 'unreadable' failures carry no parse */
  failure?: 'unreadable';
}

// ── fetch + parse ──────────────────────────────────────────────────────────

async function robotsAllows(url: string, deps: FitCheckDeps): Promise<boolean> {
  let origin: URL;
  try {
    origin = new URL(url);
  } catch {
    return false;
  }
  const res = await safeFetchExternalPage(`${origin.origin}/robots.txt`, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    timeoutMs: Math.min(deps.timeoutMs ?? ROBOTS_TIMEOUT_MS, ROBOTS_TIMEOUT_MS),
    maxBytes: ROBOTS_MAX_BYTES,
  });
  if (!res.ok) return true; // unreachable/absent robots → allowed (decisions #4)
  try {
    return isPathAllowed(res.body, origin.pathname + origin.search);
  } catch {
    return true;
  }
}

async function fetchAndParse(
  url: string,
  deps: FitCheckDeps,
): Promise<
  | { parse: ParsedExternalPage; pageText: string }
  | { failure: 'unreadable' | 'blocked_url' }
> {
  const fetchOpts = {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  };

  if (!(await robotsAllows(url, deps))) return { failure: 'unreadable' };

  // ── tier 1: Shopify storefront .js (richest: per-variant availability) ──
  if (isShopifyProductUrl(url)) {
    let jsTarget: string | null = null;
    try {
      jsTarget = shopifyJsUrl(url);
    } catch {
      jsTarget = null;
    }
    if (jsTarget) {
      const jsRes = await safeFetchExternalPage(jsTarget, {
        ...fetchOpts,
        headers: { accept: 'application/json' },
      });
      if (jsRes.ok) {
        try {
          const parsed = parseExternalShopifyProduct(JSON.parse(jsRes.body), url);
          // 'no_product' just means "not actually a Shopify store" → fall to HTML
          if (parsed.outcome !== 'no_product') {
            const p = parsed.product;
            return { parse: parsed, pageText: [p?.title, p?.description].filter(Boolean).join('\n') };
          }
        } catch {
          /* not JSON — fall through to the HTML chain */
        }
      }
    }
  }

  // ── tiers 2–4: PDP HTML → JSON-LD → microdata → og: ─────────────────────
  const res: SafeFetchResult = await safeFetchExternalPage(url, fetchOpts);
  if (!res.ok) {
    // SSRF-rejected URLs get their own honest outcome (and are never cached
    // negatively — the rejection is deterministic and free to recompute)
    return { failure: res.kind === 'blocked' ? 'blocked_url' : 'unreadable' };
  }
  return { parse: parseExternalProductPage(res.body, res.url), pageText: res.body };
}

// ── extraction (with hard deadline + honest keyless degradation) ──────────

async function extractAttributes(
  product: ExternalProduct,
  url: string,
  timeoutMs: number,
): Promise<{ attributes: ExtractedAttributes; mode: 'live' | 'mock' }> {
  const contentHash = createHash('sha256')
    .update(`fit-check|${url}|${product.title}`)
    .digest('hex');
  const input = {
    contentHash,
    title: product.title,
    description: product.description,
    brand: product.brand,
    primaryImageUrl: product.images[0] ?? null,
    attributeHints: product.attributeHints,
    sizeLabels: product.sizeLabels,
  };
  const service = createExtractionService({ client: getAiClient(), logger: () => {} });
  try {
    const result = await Promise.race([
      service.extractBatch([input]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    const attributes = result?.get(contentHash);
    if (attributes) return { attributes, mode: service.mode };
  } catch {
    /* fall through to the deterministic engine */
  }
  // deadline hit or the service threw — deterministic rule engine, honestly 'mock'
  return { attributes: mockExtract(input), mode: 'mock' };
}

// ── the fit check itself (per-user math, never cached) ────────────────────

export function sizeMatchFor(
  profileSizes: number[],
  sizeLabels: string[],
  availability: Record<string, boolean>,
): FitCheckSizeMatch {
  if (profileSizes.length === 0 || sizeLabels.length === 0) return 'unknown';
  const hers = new Set(profileSizes);
  const herLabels = sizeLabels.filter((label) =>
    normalizeSizeLabels([label]).some((n) => hers.has(n)),
  );
  if (herLabels.length === 0) return 'not_listed';
  // no per-size stock signal → listed is the best we can honestly say
  if (herLabels.some((label) => availability[label] !== false)) return 'in_your_size';
  return 'listed_sold_out';
}

function toRanked(
  profile: UserProfile | null,
  c: CandidateListing,
  score: number,
): RankedListing {
  return {
    listing: c.listing,
    hem: hemForUser(c.listing, profile?.heightInches ?? null, profile?.heelPrefInches ?? 0),
    score: Math.max(0, Math.min(1, score)),
    whyItWorks: null,
    freshnessDecay: 1,
    ...(profile ? { paletteMatch: paletteMatches(profile, c.listing) } : {}),
  };
}

interface SimilarResult {
  items: RankedListing[];
  matchBasis: 'embedding' | 'attributes' | 'none';
}

/**
 * Similar in-catalog: FashionSigLIP over the product image when available,
 * else attribute-vector cosine. Her size/budget filter first; relaxed when it
 * would empty the rack (an empty grid helps nobody).
 */
async function findSimilarInCatalog(
  db: Db,
  profile: UserProfile | null,
  product: ExternalProduct,
  attributes: ExtractedAttributes | null,
): Promise<SimilarResult> {
  const sizes = profile?.sizesNormalized ?? [];
  const budgetMax = profile?.budget.maxCents ?? null;

  const fitsHer = (c: CandidateListing): boolean => {
    if (sizes.length > 0 && !c.listing.sizeNormalized.some((n) => sizes.includes(n))) return false;
    if (budgetMax != null && c.listing.priceCents > budgetMax) return false;
    return true;
  };

  // ── tier 1: visual similarity via the ml sidecar (null when not set up) ──
  const imageUrl = product.images[0];
  if (imageUrl) {
    try {
      const matches = await findSimilarByEmbedding(db, { imageUrl }, FIT_CHECK_SIMILAR_LIMIT * 6);
      if (matches && matches.length > 0) {
        const byId = new Map(matches.map((m) => [m.listingId, m.score]));
        const hydrated = getListingsByIds(db, matches.map((m) => m.listingId));
        const inHerRack = hydrated.filter(fitsHer);
        const pool = inHerRack.length > 0 ? inHerRack : hydrated;
        return {
          matchBasis: 'embedding',
          items: pool
            .slice(0, FIT_CHECK_SIMILAR_LIMIT)
            .map((c) => toRanked(profile, c, byId.get(c.listing.id) ?? 0)),
        };
      }
    } catch {
      /* sidecar hiccup → attribute path */
    }
  }

  // ── tier 2: attribute-vector cosine (works keyless + ml-less) ────────────
  const vector = attributes?.attributeVector ?? {};
  if (Object.keys(vector).length === 0) return { items: [], matchBasis: 'none' };

  const rank = (pool: CandidateListing[]): Array<{ c: CandidateListing; sim: number }> =>
    pool
      .map((c) => ({ c, sim: cosineSimilarity(vector, c.attributeVector) }))
      .filter((s) => s.sim > 0)
      .sort((a, b) => b.sim - a.sim || b.c.listing.lastSeenAt - a.c.listing.lastSeenAt);

  const constrained = rank(
    queryCandidates(db, {
      ...(sizes.length > 0 ? { sizesNormalized: sizes } : {}),
      ...(budgetMax != null ? { priceMaxCents: budgetMax } : {}),
    }),
  );
  const matched = constrained.length > 0 ? constrained : rank(queryCandidates(db, {}));
  if (matched.length === 0) return { items: [], matchBasis: 'none' };
  return {
    matchBasis: 'attributes',
    items: matched.slice(0, FIT_CHECK_SIMILAR_LIMIT).map(({ c, sim }) => toRanked(profile, c, sim)),
  };
}

/** Is the pasted URL already a catalog listing? (analytics + honest UI copy) */
export function findInCatalog(db: Db, url: string): boolean {
  const row = db
    .select({ id: listings.id })
    .from(listings)
    .where(eq(listings.sourceUrl, url))
    .get();
  return row != null;
}

// ── response assembly ──────────────────────────────────────────────────────

function emptyResponse(outcome: FitCheckOutcome, url: string, cached: boolean): FitCheckResponse {
  return {
    outcome,
    product: null,
    hem: null,
    lengthClass: null,
    lengthInches: null,
    lengthBasis: null,
    modelHeightInches: null,
    sizeMatch: 'unknown',
    extractionMode: 'mock',
    matchBasis: 'none',
    similar: [],
    inCatalog: false,
    keywords: keywordsFromUrl(url),
    cached,
  };
}

export async function runFitCheck(
  db: Db,
  profile: UserProfile | null,
  rawUrl: string,
  deps: FitCheckDeps = {},
): Promise<FitCheckResponse> {
  const now = deps.now?.() ?? Date.now();
  const extractionTimeoutMs = deps.extractionTimeoutMs ?? FIT_CHECK_EXTRACTION_TIMEOUT_MS;

  let url: string;
  try {
    url = normalizePastedUrl(rawUrl);
  } catch {
    return emptyResponse('blocked_url', rawUrl, false);
  }

  // ── page payload: cache → fetch+parse (+extract), then cache ────────────
  let payload: PagePayload | null = null;
  let cached = false;
  const hit = getFitCheckCache(db, url, now);
  if (hit) {
    cached = true;
    payload = hit.negative
      ? {
          parse: { outcome: 'no_product', product: null },
          attributes: null,
          extractionMode: 'mock',
          modelHeightInches: null,
          failure: 'unreadable',
        }
      : {
          parse: hit.page as ParsedExternalPage,
          attributes: (hit.attributes as ExtractedAttributes | undefined) ?? null,
          extractionMode: hit.extractionMode ?? 'mock',
          modelHeightInches: hit.modelHeightInches ?? null,
        };
  }

  if (!payload) {
    const fetched = await fetchAndParse(url, deps);
    if ('failure' in fetched) {
      if (fetched.failure === 'blocked_url') return emptyResponse('blocked_url', url, false);
      setFitCheckCache(db, url, { page: null, negative: true }, now);
      return emptyResponse('unreadable', url, false);
    }
    let attributes: ExtractedAttributes | null = null;
    let extractionMode: 'live' | 'mock' = 'mock';
    let modelHeightInches: number | null = null;
    if (fetched.parse.outcome === 'ok' && fetched.parse.product) {
      const extracted = await extractAttributes(fetched.parse.product, url, extractionTimeoutMs);
      attributes = extracted.attributes;
      extractionMode = extracted.mode;
      // brands state the model's height in body copy ("model is 5'9\"") —
      // parse the FULL fetched text, not just the structured description
      modelHeightInches = parseModelInfo(fetched.pageText).modelHeightInches;
    }
    payload = { parse: fetched.parse, attributes, extractionMode, modelHeightInches };
    setFitCheckCache(
      db,
      url,
      { page: payload.parse, attributes: attributes ?? undefined, extractionMode, modelHeightInches },
      now,
    );
  }

  if (payload.failure === 'unreadable') return emptyResponse('unreadable', url, cached);
  const { parse, attributes, extractionMode } = payload;
  if (parse.outcome === 'not_a_dress') return emptyResponse('not_a_dress', url, cached);
  if (parse.outcome === 'child_audience') return emptyResponse('child_audience', url, cached);
  if (parse.outcome !== 'ok' || !parse.product) return emptyResponse('unreadable', url, cached);

  const product = parse.product;
  // extraction can also spot a kids item the parser's text pass missed
  if (attributes?.audience === 'child') return emptyResponse('child_audience', url, cached);

  // ── HER fit check ────────────────────────────────────────────────────────
  const lengthClass = attributes?.lengthClass ?? null;
  const lengthInches = attributes?.lengthInches ?? null;
  const lengthBasis =
    attributes?.lengthBasis ?? (lengthInches != null ? ('stated' as const) : null);
  // §5 effective length, honoring provenance (estimates never read "Measured")
  const hem =
    profile?.heightInches != null
      ? computeHem({
          lengthInches,
          lengthClass,
          heightInches: profile.heightInches,
          heelInches: profile.heelPrefInches ?? 0,
          lengthSource: lengthBasis === 'image_estimate' ? 'image_estimate' : 'seller_text',
        })
      : ({ position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' } as const);
  const modelHeightInches =
    payload.modelHeightInches ??
    parseModelInfo([product.title, product.description ?? ''].join('\n')).modelHeightInches;
  const sizeMatch = sizeMatchFor(
    profile?.sizesNormalized ?? [],
    product.sizeLabels,
    product.availability,
  );

  const similar = await findSimilarInCatalog(db, profile, product, attributes);

  const wireProduct: FitCheckProduct = {
    url,
    domain: new URL(url).hostname.replace(/^www\./, ''),
    title: product.title,
    brand: product.brand,
    priceCents: product.priceCents,
    currency: product.currency,
    imageUrl: product.images[0] ?? null,
    sizeLabels: product.sizeLabels,
    availability: product.availability,
    via: product.via,
  };

  return {
    outcome: 'ok',
    product: wireProduct,
    hem,
    lengthClass,
    lengthInches,
    lengthBasis,
    modelHeightInches,
    sizeMatch,
    extractionMode,
    matchBasis: similar.matchBasis,
    similar: similar.items,
    inCatalog: findInCatalog(db, url),
    keywords: keywordsFromUrl(url),
    cached,
  };
}
