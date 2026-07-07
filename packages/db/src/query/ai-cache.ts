/**
 * Drizzle-backed persistence for @hemline/ai's injected cache ports
 * (decisions-ai-eng.md #10: "backend/data-eng own the Drizzle adapter").
 *
 * - ExtractionCacheStore ⇄ `extractions` table (content_hash PK, §7.2
 *   idempotency). Interfaces are matched STRUCTURALLY — this package must not
 *   depend on @hemline/ai (ai already sits above db in the workspace graph).
 * - RerankCacheStore ⇄ `rerank_cache` table (24h TTL, §7.3). Expired rows are
 *   deleted lazily on read.
 *
 * Rules encoded here:
 * - set() for a content hash with no listings row is a no-op (ad-hoc probes
 *   like /api/find-similar hash things that aren't listings).
 * - set() never overwrites `model='manual'` rows (spec G2 corrections win) or
 *   `model='fixture'` rows (seed ground truth beats a mock re-extraction).
 */
import { eq, lte } from 'drizzle-orm';
import type {
  ColorTag,
  ExtractedAttributes,
  LengthClass,
  Measurements,
  Silhouette,
} from '@hemline/contracts';
import type { Db } from '../client';
import { extractions, listings, rerankCache } from '../schema';
import { parseJson } from './mappers';

// ── extraction cache (mirrors ai's ExtractionCacheStore) ─────────────────

export interface CachedExtraction {
  attributes: ExtractedAttributes;
  model: string;
}

/** Extraction row models that a cache write must never overwrite. */
const PROTECTED_MODELS = new Set(['manual', 'fixture']);

export function createExtractionCacheStore(db: Db): {
  get(contentHash: string): Promise<CachedExtraction | null>;
  set(contentHash: string, value: CachedExtraction): Promise<void>;
} {
  return {
    async get(contentHash) {
      const row = db
        .select()
        .from(extractions)
        .where(eq(extractions.contentHash, contentHash))
        .get();
      if (!row) return null;
      const measurements = parseJson<Partial<Measurements>>(row.measurementsJson, {});
      return {
        model: row.model,
        attributes: {
          lengthClass: (row.lengthClass ?? null) as LengthClass | null,
          lengthInches: row.lengthInches ?? null,
          measurements: {
            bust: measurements.bust ?? null,
            waist: measurements.waist ?? null,
            hip: measurements.hip ?? null,
            length: measurements.length ?? null,
          },
          colors: parseJson<ColorTag[]>(row.colorsJson, []),
          fabric: row.fabric ?? null,
          neckline: row.neckline ?? null,
          silhouette: (row.silhouette ?? null) as Silhouette | null,
          sleeve: row.sleeve ?? null,
          pattern: row.pattern ?? null,
          occasions: parseJson<string[]>(row.occasionJson, []),
          attributeVector: parseJson<Record<string, number>>(row.attributeVectorJson, {}),
          confidence: row.extractionConfidence,
        },
      };
    },
    async set(contentHash, value) {
      const listing = db
        .select({ id: listings.id })
        .from(listings)
        .where(eq(listings.contentHash, contentHash))
        .get();
      if (!listing) return; // ad-hoc hash (e.g. find-similar) — nothing to persist against
      const existing = db
        .select({ model: extractions.model })
        .from(extractions)
        .where(eq(extractions.contentHash, contentHash))
        .get();
      if (existing && PROTECTED_MODELS.has(existing.model)) return;
      const a = value.attributes;
      const row = {
        contentHash,
        listingId: listing.id,
        model: value.model,
        lengthClass: a.lengthClass,
        lengthInches: a.lengthInches,
        measurementsJson: JSON.stringify(a.measurements),
        colorsJson: JSON.stringify(a.colors),
        fabric: a.fabric,
        neckline: a.neckline,
        silhouette: a.silhouette,
        sleeve: a.sleeve,
        pattern: a.pattern,
        occasionJson: JSON.stringify(a.occasions),
        attributeVectorJson: JSON.stringify(a.attributeVector),
        extractionConfidence: a.confidence,
        extractedAt: Date.now(),
        rawResponseJson: null,
      };
      db.insert(extractions)
        .values(row)
        .onConflictDoUpdate({ target: extractions.contentHash, set: row })
        .run();
    },
  };
}

// ── rerank cache (mirrors ai's RerankCacheStore, 24h TTL) ────────────────

export interface CachedRerankResult {
  ranking: string[];
  reasons: Record<string, string>;
  costUsd: number | null;
  mode: 'llm' | 'deterministic' | 'cache';
}

export function createRerankCacheStore(db: Db, now: () => number = Date.now): {
  get(cacheKey: string): Promise<CachedRerankResult | null>;
  set(cacheKey: string, value: CachedRerankResult, expiresAtMs: number): Promise<void>;
} {
  return {
    async get(cacheKey) {
      db.delete(rerankCache).where(lte(rerankCache.expiresAt, now())).run();
      const row = db
        .select()
        .from(rerankCache)
        .where(eq(rerankCache.cacheKey, cacheKey))
        .get();
      if (!row) return null;
      return parseJson<CachedRerankResult | null>(row.responseJson, null);
    },
    async set(cacheKey, value, expiresAtMs) {
      const row = {
        cacheKey,
        responseJson: JSON.stringify(value),
        model: process.env.RERANK_MODEL || 'claude-haiku-4-5-20251001',
        createdAt: now(),
        expiresAt: expiresAtMs,
      };
      db.insert(rerankCache)
        .values(row)
        .onConflictDoUpdate({ target: rerankCache.cacheKey, set: row })
        .run();
    },
  };
}
