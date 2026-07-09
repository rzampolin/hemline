/**
 * Real matching/AI wiring (integration 2026-07-06).
 *
 * The stub-tolerant era is over: packages/matching (pure §5/§6 math +
 * MatchingService) and packages/ai (extraction/re-rank/color with keyless
 * deterministic degradation BUILT IN, §7.5) are merged and active. This module
 * wires the ports:
 *
 *   createMatchingService({
 *     loadProfile   ← packages/db (route pre-loads and closes over it),
 *     loadCandidates← packages/db queryCandidates (real extraction vectors
 *                     passed through — decisions-ai-eng.md #9 TODO),
 *     rerank        ← @hemline/ai createReranker + Drizzle rerank_cache,
 *   })
 *
 * The INLINE §5/§6 fallback copies that lived here are deleted — the formulas
 * have exactly one home now (packages/matching).
 */
import {
  createMatchingService,
  hemForUser as matchingHemForUser,
  attributeSimilarity,
  freshnessDecay,
  halfLifeDaysForSource,
  paletteBoost,
  paletteMatchesColor,
  score0,
  type CandidateWithVector,
} from '@hemline/matching';
import { createAiClient, createReranker, templatedWhy, type AiClient } from '@hemline/ai';
import {
  createRerankCacheStore,
  queryCandidates,
  sources as sourcesTable,
  type CandidateListing,
  type CandidateQueryOptions,
  type Db,
} from '@hemline/db';
import type {
  HardFilters,
  HemResult,
  Listing,
  RankedListing,
  RankResponse,
  UserProfile,
} from '@hemline/contracts';
import { makeEmbeddingScorePort } from './embeddings';

// ── shared AI client (one cost meter / budget ledger per process) ─────────

let sharedAiClient: AiClient | null = null;
export function getAiClient(): AiClient {
  sharedAiClient ??= createAiClient();
  return sharedAiClient;
}

// ── effective length (§5 — the one true implementation) ──────────────────

/** Null-height-safe wrapper around packages/matching's hemForUser. */
export function hemForUser(
  listing: Pick<Listing, 'lengthInches' | 'lengthClass'>,
  heightInches: number | null,
  heelInches = 0,
): HemResult {
  if (heightInches == null) {
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }
  return matchingHemForUser(listing, heightInches, heelInches);
}

// ── source facet (HardFilters.sources, additive contract change) ─────────

const RESALE_RE = /(^|:)ebay\b|poshmark|depop|resale/i;

/**
 * Expand `filters.sources` values into concrete source ids:
 * a known source id passes through; the aliases 'resale' | 'brand' expand by
 * the same source-id heuristic the freshness half-life uses.
 */
export function expandSourceFilter(db: Db, sources: string[] | undefined): string[] | undefined {
  if (!sources || sources.length === 0) return undefined;
  const all = db.select({ id: sourcesTable.id }).from(sourcesTable).all().map((r) => r.id);
  const out = new Set<string>();
  for (const value of sources) {
    if (value === 'resale') {
      for (const id of all) if (RESALE_RE.test(id)) out.add(id);
    } else if (value === 'brand') {
      for (const id of all) if (!RESALE_RE.test(id)) out.add(id);
    } else {
      out.add(value);
    }
  }
  return [...out];
}

// ── palette chip (RankedListing.paletteMatch, additive contract change) ──

export function paletteMatches(profile: UserProfile, listing: Listing): boolean {
  if (profile.palette.length === 0 || listing.colors.length === 0) return false;
  return listing.colors.some((c) => paletteMatchesColor(profile.palette, c));
}

// ── ranking pipeline (§6) ─────────────────────────────────────────────────

export interface RankOptions {
  limit: number;
  cursor?: string;
  personalize: boolean;
}

/**
 * SQL-side candidate options. Size filtering deliberately stays SQL-side
 * (strict normalized-label match) to preserve the shipped API/UI behavior;
 * `lengthOnBody` is per-user math and runs inside the matching service.
 */
export type CandidateSqlOptions = Omit<CandidateQueryOptions, 'cap' | 'excludeListingIds'>;

function toCandidateWithVector(c: CandidateListing): CandidateWithVector {
  return Object.assign({}, c.listing, { attributeVector: c.attributeVector });
}

/** RankedListing for the wire: real vector stripped, paletteMatch computed. */
function finalizeItem(profile: UserProfile, item: RankedListing): RankedListing {
  const { attributeVector: _av, ...listing } = item.listing as CandidateWithVector;
  return {
    ...item,
    listing,
    whyItWorks: item.whyItWorks ?? templatedWhy(profile, item),
    paletteMatch: paletteMatches(profile, listing),
  };
}

/**
 * Full §6 pipeline via the real MatchingService:
 * SQL hard filters → per-user hem + score₀ → optional re-rank (LLM when a key
 * is present, honest 'deterministic' keyless, 'cache' on rerank_cache hits) →
 * paginate → templated why-lines for anything the re-ranker didn't cover.
 */
export async function rankForUser(
  db: Db,
  profile: UserProfile,
  sqlOptions: CandidateSqlOptions,
  serviceFilters: Pick<HardFilters, 'lengthOnBody'>,
  opts: RankOptions,
): Promise<RankResponse> {
  const service = createMatchingService({
    loadProfile: async () => profile,
    loadCandidates: async () => queryCandidates(db, sqlOptions).map(toCandidateWithVector),
    // Deterministic-first (2026-07-09, prod 15s-feed fix): the rank endpoint
    // never blocks on Haiku. Cache hits apply synchronously ('cache'); misses
    // return 'pending' and the LLM fills rerank_cache in the background (one
    // in-flight call per cache key process-wide). Failures negative-cache
    // 5 min. The feed quietly refetches once when it sees 'pending'.
    rerank: createReranker({
      client: getAiClient(),
      cache: createRerankCacheStore(db),
      background: true,
    }),
    // FashionSigLIP style-profile scoring (2026-07-07 ml-eng): average of
    // liked/saved item embeddings vs each candidate's vector, blended 0.6/0.4
    // with the attribute score INSIDE the service. undefined (no vectors, no
    // likes, ml never set up) keeps the pipeline identical to pre-ml behavior.
    embeddingScore: makeEmbeddingScorePort(db, profile.id),
  });

  // NOTE: free-text `query` is applied in SQL only (it searches descriptions,
  // which the in-memory `matchesQuery` predicate cannot see — Listing carries
  // no description). Passing it to the service would silently drop
  // description-only matches.
  const response = await service.rank({
    userId: profile.id,
    filters: { lengthOnBody: serviceFilters.lengthOnBody },
    limit: opts.limit,
    cursor: opts.cursor,
    personalize: opts.personalize,
  });

  return { ...response, items: response.items.map((item) => finalizeItem(profile, item)) };
}

// ── scored cards outside the rank pipeline (saves rack, find-similar) ────

/**
 * Hem + deterministic score₀ for pre-selected candidates, using the same
 * packages/matching math as the service (no LLM, no pagination).
 */
export function toRankedListings(
  profile: UserProfile,
  candidates: CandidateListing[],
  now = Date.now(),
): RankedListing[] {
  // same D2 toggle semantics as the rank pipeline (QA P1 #1)
  const paletteOn = profile.paletteBoostEnabled !== false;
  return candidates.map((c) => {
    const hem = hemForUser(c.listing, profile.heightInches, profile.heelPrefInches);
    const ageDays = Math.max(0, (now - c.listing.lastSeenAt) / 86_400_000);
    const decay = freshnessDecay(ageDays, halfLifeDaysForSource(c.listing.sourceId));
    const sim = attributeSimilarity(profile.styleTags, c.attributeVector);
    const boost = paletteOn ? paletteBoost(profile.palette, c.listing.colors) : 1;
    return {
      listing: c.listing,
      hem,
      score: score0({ similarity: sim, paletteBoost: boost, freshnessDecay: decay }),
      whyItWorks: null,
      freshnessDecay: decay,
      paletteMatch: paletteMatches(profile, c.listing),
    };
  });
}

export { attributeSimilarity, templatedWhy };
