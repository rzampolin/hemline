/**
 * MatchingService composition — docs/ARCHITECTURE.md §4.4 + §6 pipeline:
 *
 *   candidates (hard filters, cap 500 newest-first)
 *     → score₀ = similarity × paletteBoost × freshnessDecay
 *     → top-N (50) optional LLM re-rank → blend 0.6·llm + 0.4·score₀
 *     → paginate
 *
 * This package stays pure: data access and the LLM re-ranker are injected as
 * ports. backend-eng wires `loadCandidates` to SQL and `rerank` to
 * `@hemline/ai`'s reranker (which itself degrades deterministically).
 */
import type {
  HardFilters,
  HemResult,
  Listing,
  MatchingService,
  RankRequest,
  RankResponse,
  RankedListing,
  UserProfile,
} from '@hemline/contracts';
import { hemForUser } from './effective-length';
import { blendSimilarity } from './embedding';
import { applyHardFilters, CANDIDATE_CAP } from './filters';
import { attributeStyleSimilarity, type StyleSimilarity } from './similarity';
import {
  blendScores,
  freshnessDecay,
  halfLifeDaysForSource,
  paletteBoost,
  rankPositionToScore,
  score0,
} from './scoring';

/** Only the top-N scored candidates are sent to the LLM re-ranker (doc §6). */
export const RERANK_TOP_N = 50;

export interface RerankOutcome {
  /** listing ids, best first; ids not present keep deterministic order after. */
  ranking: string[];
  /** listingId → one-line "why it works for you" */
  reasons: Record<string, string>;
  costUsd: number | null;
  mode: 'llm' | 'deterministic' | 'cache';
}

export interface RerankPort {
  (
    profile: UserProfile,
    candidates: RankedListing[],
    query?: string,
  ): Promise<RerankOutcome>;
}

/**
 * Candidates may carry the REAL sparse attribute vector from the extractions
 * table (decisions-ai-eng.md #9 TODO resolved at integration): when present it
 * is used for similarity instead of the `attributeVectorOf` derivation, which
 * cannot reconstruct pattern:/occasion:/vibe: tags.
 */
export type CandidateWithVector = Listing & {
  attributeVector?: Record<string, number>;
};

export interface MatchingPorts {
  loadProfile(userId: string): Promise<UserProfile>;
  /**
   * Return candidate listings for the cheap/SQL-able filter dimensions.
   * The service re-applies the full predicate set (incl. per-user hem and
   * measurement-based size compat) and the 500-newest cap.
   */
  loadCandidates(filters: HardFilters): Promise<CandidateWithVector[]>;
  /** Optional LLM re-ranker; omit (or have it throw) for deterministic-only. */
  rerank?: RerankPort;
  /** Sparse-vector similarity backend; defaults to attribute-v1 cosine. */
  similarity?: StyleSimilarity;
  /**
   * Optional dense-embedding similarity port (additive, 2026-07-07 ml-eng):
   * 0..1 user-vs-listing score from FashionSigLIP vectors, or null when this
   * listing has no vector. When non-null it blends 0.6·embedding + 0.4·attribute
   * (EMBEDDING_BLEND_WEIGHT); when absent/null the attribute score stands
   * alone — the ml-less degradation path.
   */
  embeddingScore?: (listing: Listing) => number | null;
  /** Clock injection for tests. */
  now?: () => number;
}

interface Cursor {
  offset: number;
}

export function createMatchingService(ports: MatchingPorts): MatchingService {
  const similarity = ports.similarity ?? attributeStyleSimilarity;
  const now = ports.now ?? Date.now;

  async function rank(req: RankRequest): Promise<RankResponse> {
    const profile = await ports.loadProfile(req.userId);
    const raw = await ports.loadCandidates(req.filters);

    const candidates = applyHardFilters(
      raw,
      req.filters,
      {
        heightInches: profile.heightInches,
        heelInches: profile.heelPrefInches,
        bodyMeasurements: profile.bodyMeasurements,
      },
      CANDIDATE_CAP,
    );

    const nowMs = now();
    const scored: RankedListing[] = candidates.map((listing) => {
      const hem = hemForProfile(listing, profile);
      const ageDays = Math.max(0, (nowMs - listing.lastSeenAt) / 86_400_000);
      const decay = freshnessDecay(ageDays, halfLifeDaysForSource(listing.sourceId));
      const vector =
        (listing as CandidateWithVector).attributeVector ?? attributeVectorOf(listing);
      const attrSim = similarity.score(profile.styleTags, vector);
      const sim = blendSimilarity(attrSim, ports.embeddingScore?.(listing) ?? null);
      const boost = paletteBoost(profile.palette, listing.colors);
      return {
        listing,
        hem,
        score: score0({ similarity: sim, paletteBoost: boost, freshnessDecay: decay }),
        whyItWorks: null,
        freshnessDecay: decay,
      };
    });

    // Deterministic order: score desc, then measured-length listings above
    // measurement-less ones (product spec B1), then freshest first.
    scored.sort(compareRanked);

    let rerankMode: RankResponse['rerank'] = { mode: 'deterministic', costUsd: null };
    let items = scored;

    if (req.personalize && ports.rerank && scored.length > 0) {
      try {
        const head = scored.slice(0, RERANK_TOP_N);
        const tail = scored.slice(RERANK_TOP_N);
        const outcome = await ports.rerank(profile, head, req.filters.query);
        items = [...applyRerank(head, outcome), ...tail];
        rerankMode = {
          mode: outcome.mode === 'deterministic' ? 'deterministic' : outcome.mode,
          costUsd: outcome.costUsd,
        };
      } catch {
        // Re-ranker failure never breaks the feed — deterministic order stands.
        rerankMode = { mode: 'deterministic', costUsd: null };
      }
    }

    const offset = decodeCursor(req.cursor);
    const page = items.slice(offset, offset + req.limit);
    const nextOffset = offset + req.limit;

    return {
      items: page,
      nextCursor: nextOffset < items.length ? encodeCursor({ offset: nextOffset }) : null,
      totalMatched: items.length,
      rerank: rerankMode,
    };
  }

  return { rank, hemForUser };
}

function hemForProfile(listing: Listing, profile: UserProfile): HemResult {
  if (profile.heightInches == null) {
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }
  return hemForUser(listing, profile.heightInches, profile.heelPrefInches);
}

/**
 * The enriched `Listing` doesn't carry the sparse attribute vector (it lives in
 * the extractions table), so we derive an equivalent one from its attributes —
 * the same construction the extractors use.
 */
export function attributeVectorOf(listing: Listing): Record<string, number> {
  const v: Record<string, number> = {};
  if (listing.lengthClass) v[`length:${listing.lengthClass}`] = 1;
  if (listing.silhouette) v[`silhouette:${listing.silhouette}`] = 1;
  for (const c of listing.colors) v[`color:${c.family}`] = 0.8;
  if (listing.neckline) v[`neckline:${listing.neckline}`] = 0.5;
  if (listing.fabric) v[`fabric:${firstWord(listing.fabric)}`] = 0.6;
  if (listing.isVintage) v['era:vintage'] = 0.6;
  return v;
}

function applyRerank(head: RankedListing[], outcome: RerankOutcome): RankedListing[] {
  const byId = new Map(head.map((r) => [r.listing.id, r]));
  const ordered: RankedListing[] = [];
  for (const id of outcome.ranking) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      byId.delete(id);
    }
  }
  // Ids the model dropped keep their deterministic relative order at the end.
  for (const rest of byId.values()) ordered.push(rest);

  const n = ordered.length;
  return ordered.map((item, position) => ({
    ...item,
    score: blendScores(rankPositionToScore(position, n), item.score),
    whyItWorks: outcome.reasons[item.listing.id] ?? item.whyItWorks,
  }));
}

function compareRanked(a: RankedListing, b: RankedListing): number {
  if (b.score !== a.score) return b.score - a.score;
  const aMeasured = a.hem.basis === 'measured_length' ? 1 : 0;
  const bMeasured = b.hem.basis === 'measured_length' ? 1 : 0;
  if (bMeasured !== aMeasured) return bMeasured - aMeasured;
  return b.listing.lastSeenAt - a.listing.lastSeenAt;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    return Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] ?? s;
}
