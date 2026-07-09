/**
 * Hybrid free-text search orchestration (docs/decisions-search.md).
 *
 * Three stages, strictly additive on top of each other:
 *   1. deterministic query-token mapper (@hemline/ai parseQueryDeterministic)
 *      — always on, free; consumes taxonomy/price/size/brand spans.
 *   2. semantic embedding (FashionSigLIP dual encoder) — when the ml sidecar
 *      is warm AND the catalog has vectors; otherwise silently skipped.
 *   3. Haiku query parse (@hemline/ai createQueryParser) — when a key is
 *      present; globally cached; enrichment only (stage 1 already ran).
 *
 * Hard/soft rule: query-derived price/size/length/brand become SQL hard
 * filters (explicit route params always win); occasion/color/fabric/… and all
 * vibe language only ever influence RANKING (attribute .5 / semantic .3 /
 * lexical .2, renormalized) plus the evidence gate — a candidate needs at
 * least one positive signal to stay in a query result.
 */
import type {
  SearchInterpretation,
  InterpretedSignal,
} from '@hemline/contracts';
import {
  createQueryParser,
  LlmQueryParseSchema,
  mergeQueryParse,
  parseQueryDeterministic,
  type LlmQueryParse,
  type MergedQuery,
  type QueryParseCacheStore,
} from '@hemline/ai';
import {
  createQueryParseCacheStore,
  listings,
  type CandidateListing,
  type Db,
} from '@hemline/db';
import { isNull, sql, and } from 'drizzle-orm';
import {
  attributeMatchScore,
  blendRelevance,
  countSoftSignals,
  embeddingSimilarity,
  lexicalMatchScore,
  normalizeSemanticScores,
  semanticTopK,
} from '@hemline/matching';
import type { AiClient } from '@hemline/ai';
import { getCatalogVectors, embedQueryText } from './embeddings';

/** SQL-able hard filters a query can derive. */
export interface QueryHardFilters {
  priceMinCents?: number;
  priceMaxCents?: number;
  sizesNormalized?: number[];
  lengthClasses?: string[];
  brands?: string[];
}

export interface SearchPlan {
  /** query-derived hard filters, already reduced by explicit-param collisions */
  sqlFilters: QueryHardFilters;
  /** true when the query carries any scoring signal (soft/residual/semantic) */
  hasScoringSignals: boolean;
  /** evidence-gate + score the loaded candidates; relevance is 0..1 by id */
  apply(candidates: CandidateListing[]): {
    kept: CandidateListing[];
    relevance: Map<string, number>;
  };
  interpreted: SearchInterpretation;
}

/** Which explicit route params are present (explicit always beats derived). */
export interface ExplicitFilterPresence {
  price?: boolean;
  sizes?: boolean;
  lengthClasses?: boolean;
  brands?: boolean;
}

const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean);
const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

function knownBrandsOf(db: Db): string[] {
  return db
    .selectDistinct({ brand: listings.brand })
    .from(listings)
    .where(and(isNull(listings.removedAt), sql`${listings.brand} IS NOT NULL`))
    .all()
    .map((r) => r.brand)
    .filter((b): b is string => b != null);
}

/** Drizzle store → ai's QueryParseCacheStore, validating payloads on read. */
function adaptParseCache(db: Db): QueryParseCacheStore {
  const store = createQueryParseCacheStore(db);
  return {
    async get(key) {
      const hit = await store.get(key);
      if (!hit) return null;
      if (hit.parse === null) return { parse: null };
      const parsed = LlmQueryParseSchema.safeParse(hit.parse);
      return parsed.success ? { parse: parsed.data as LlmQueryParse } : null;
    },
    set: (key, value, expiresAtMs) => store.set(key, value, expiresAtMs),
  };
}

/**
 * Build the search plan for one query. Runs stage 1 synchronously, stage 3
 * (bounded by its 2.5s internal timeout, usually a cache hit) and the stage-2
 * query embed concurrently. Never throws for degradation reasons.
 */
export async function buildSearchPlan(
  db: Db,
  query: string,
  opts: {
    lexicalTerms?: string[];
    explicit?: ExplicitFilterPresence;
    /** shared AI client (one budget ledger per process) — stage 3 skipped without it */
    aiClient?: AiClient;
  } = {},
): Promise<SearchPlan> {
  const knownBrands = knownBrandsOf(db);
  const stage1 = parseQueryDeterministic(query, {
    knownBrands,
    excludeTerms: opts.lexicalTerms,
  });

  // Stage 3 — Haiku enrichment (null: keyless / budget / negative-cache / timeout)
  let outcome: Awaited<ReturnType<ReturnType<typeof createQueryParser>>> = null;
  if (opts.aiClient) {
    try {
      const parser = createQueryParser({ client: opts.aiClient, cache: adaptParseCache(db) });
      outcome = await parser(query);
    } catch {
      outcome = null; // enrichment must never break search
    }
  }
  const merged: MergedQuery = mergeQueryParse(stage1, outcome?.parse ?? null, {
    knownBrands,
    excludeTerms: opts.lexicalTerms,
  });

  // Explicit route params always win — drop colliding derived filters (and
  // their chips: an interpretation that wasn't applied must not render).
  const explicit = opts.explicit ?? {};
  const droppedKinds = new Set<InterpretedSignal['kind']>();
  if (explicit.price) droppedKinds.add('price');
  if (explicit.sizes) droppedKinds.add('size');
  if (explicit.lengthClasses) droppedKinds.add('length');
  if (explicit.brands) droppedKinds.add('brand');
  const signals = merged.signals.filter((s) => !droppedKinds.has(s.kind));
  const sqlFilters: QueryHardFilters = {
    priceMinCents: explicit.price ? undefined : merged.hard.priceMinCents,
    priceMaxCents: explicit.price ? undefined : merged.hard.priceMaxCents,
    sizesNormalized: explicit.sizes ? undefined : merged.hard.sizesNormalized,
    lengthClasses: explicit.lengthClasses ? undefined : merged.hard.lengthClasses,
    brands: explicit.brands ? undefined : merged.hard.brands,
  };

  // Stage 2 — semantic query vector (null: no sidecar / cold / no text)
  const semanticText = [merged.semanticText, merged.vibeText ?? '']
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const catalog = getCatalogVectors(db);
  const queryVector =
    semanticText && catalog.size > 0 ? await embedQueryText(semanticText) : null;

  const softCount = countSoftSignals(merged.soft);
  const hasScoringSignals =
    softCount > 0 || merged.residualTokens.length > 0 || queryVector != null;

  // un-chipped terms stay lexical (they're in residualTokens) but must not
  // re-render as chips — the chip was just removed.
  const excludedTerms = new Set((opts.lexicalTerms ?? []).map((t) => t.trim().toLowerCase()));
  const vibe = unique([
    ...merged.residualTokens,
    ...words(merged.vibeText ?? '').filter((w) => w.length > 1),
  ]).filter((t) => !excludedTerms.has(t));

  const interpreted: SearchInterpretation = {
    signals,
    vibe,
    semantic: queryVector != null,
    parser: outcome ? outcome.source : 'deterministic',
  };

  function apply(candidates: CandidateListing[]) {
    const relevance = new Map<string, number>();
    if (!hasScoringSignals) return { kept: candidates, relevance };

    // semantic: raw cosines for candidates that have vectors, normalized
    // within THIS candidate set; top-K ranks count as retrieval evidence.
    const rawSem = new Map<string, number>();
    if (queryVector) {
      for (const c of candidates) {
        const v = catalog.get(c.listing.id);
        if (v) rawSem.set(c.listing.id, embeddingSimilarity(queryVector, v));
      }
    }
    const semScores = normalizeSemanticScores(rawSem);
    const semEvidence = semanticTopK(rawSem);

    const kept: CandidateListing[] = [];
    for (const c of candidates) {
      const id = c.listing.id;
      const attr = attributeMatchScore(merged.soft, c.attributeVector);
      const lex = lexicalMatchScore(
        merged.residualTokens,
        `${c.listing.title} ${c.listing.brand ?? ''} ${c.description ?? ''}`,
      );
      const evidence =
        (attr ?? 0) > 0 || (lex ?? 0) > 0 || semEvidence.has(id);
      if (!evidence) continue;
      const score = blendRelevance({
        attribute: attr,
        semantic: semScores.get(id) ?? null,
        lexical: lex,
      });
      relevance.set(id, score ?? 0);
      kept.push(c);
    }
    return { kept, relevance };
  }

  return { sqlFilters, hasScoringSignals, apply, interpreted };
}
