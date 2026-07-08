/**
 * Visual-embedding wiring for the API routes (2026-07-07 ml-eng).
 *
 * Composition rules (the "blend/fallback" contract):
 *  - find-similar: FashionSigLIP nearest-neighbor when (a) the ml sidecar is
 *    set up AND (b) the catalog has vectors; otherwise callers keep the
 *    attribute-extraction path unchanged.
 *  - feed ranking: a per-user style embedding (weighted average of liked/saved
 *    item vectors, save = 1.25×like) scores candidates that have vectors; the
 *    matching service blends it 0.6/0.4 with the attribute score. Listings
 *    without vectors — and installs without ml — score exactly as before.
 *
 * Catalog vectors are cached in-process (≤10k × 768 × 4B ≈ 30 MB worst case)
 * and invalidated by (count, maxEmbeddedAt). Brute-force cosine at this scale
 * is <10ms; sqlite-vec is the upgrade path (docs/decisions-ml-eng.md).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { EMBEDDING_MODEL_TAG, type Listing } from '@hemline/contracts';
import {
  embeddingStats,
  loadCatalogEmbeddings,
  swipeEvents,
  type Db,
} from '@hemline/db';
import { embeddingSimilarity, styleEmbeddingFromSwipes } from '@hemline/matching';
import { embedProbe, isEmbedderAvailable, type EmbedRequest } from '@hemline/matching/embedder';

/** Most recent like/save swipes folded into the user style embedding. */
const STYLE_SWIPE_LIMIT = 200;

// ── catalog vector cache ────────────────────────────────────────────────────

interface CatalogCache {
  key: string;
  vectors: Map<string, Float32Array>; // listingId → L2-normalized vector
}

const CATALOG_KEY = Symbol.for('hemline.ml.catalog');

/** Current (non-stale) catalog vectors; cached until embed count/time changes. */
export function getCatalogVectors(db: Db): Map<string, Float32Array> {
  const stats = embeddingStats(db, EMBEDDING_MODEL_TAG);
  const key = `${stats.count}:${stats.maxEmbeddedAt}`;
  const g = globalThis as unknown as Record<symbol, CatalogCache | undefined>;
  const cached = g[CATALOG_KEY];
  if (cached && cached.key === key) return cached.vectors;
  const vectors = new Map<string, Float32Array>();
  if (stats.count > 0) {
    for (const row of loadCatalogEmbeddings(db, EMBEDDING_MODEL_TAG)) {
      vectors.set(row.listingId, row.vector);
    }
  }
  g[CATALOG_KEY] = { key, vectors };
  return vectors;
}

// ── find-similar: probe → nearest neighbors ────────────────────────────────

export interface EmbeddingMatch {
  listingId: string;
  /** cosine mapped 0..1 ((cos+1)/2) */
  score: number;
}

/**
 * Embed the probe (photo bytes, image url, or free text — SigLIP is a dual
 * encoder) and rank the whole catalog by cosine. Returns null whenever the
 * embedding path is unavailable or fails, so the caller falls back.
 */
export async function findSimilarByEmbedding(
  db: Db,
  probe: EmbedRequest,
  limit: number,
): Promise<EmbeddingMatch[] | null> {
  if (!isEmbedderAvailable()) return null;
  const catalog = getCatalogVectors(db);
  if (catalog.size === 0) return null;
  const vector = await embedProbe(probe);
  if (!vector) return null;
  const scored: EmbeddingMatch[] = [];
  for (const [listingId, v] of catalog) {
    scored.push({ listingId, score: embeddingSimilarity(vector, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── feed ranking: user style embedding port ────────────────────────────────

/**
 * Build the `embeddingScore` port for the matching service, or undefined when
 * anything is missing (no vectors, no positive swipes) — undefined keeps the
 * §6 pipeline byte-for-byte identical to the pre-ml behavior.
 *
 * Note: no python involved — this only READS stored vectors, so it works for
 * ranking even when the venv was deleted after `npm run embed`.
 */
export function makeEmbeddingScorePort(
  db: Db,
  userId: string,
): ((listing: Listing) => number | null) | undefined {
  const catalog = getCatalogVectors(db);
  if (catalog.size === 0) return undefined;

  const liked = db
    .select({ listingId: swipeEvents.listingId, verdict: swipeEvents.verdict })
    .from(swipeEvents)
    .where(and(eq(swipeEvents.userId, userId), inArray(swipeEvents.verdict, ['like', 'save'])))
    .orderBy(desc(swipeEvents.createdAt))
    .limit(STYLE_SWIPE_LIMIT)
    .all();

  const userVector = styleEmbeddingFromSwipes(
    liked
      .map((s) => ({
        verdict: s.verdict as 'like' | 'save',
        vector: catalog.get(s.listingId) ?? new Float32Array(0),
      }))
      .filter((s) => s.vector.length > 0),
  );
  if (!userVector) return undefined;

  return (listing) => {
    const v = catalog.get(listing.id);
    return v ? embeddingSimilarity(userVector, v) : null;
  };
}
