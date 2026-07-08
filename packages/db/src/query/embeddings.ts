/**
 * Visual-embedding repository (2026-07-07 ml-eng).
 *
 * Rows are keyed (content_hash, model) like the extractions cache, so
 * `npm run embed` is idempotent: content changes → new hash → the listing
 * shows up in `listingsMissingEmbedding` again; unchanged content is skipped.
 *
 * Vectors are L2-normalized Float32Arrays stored as little-endian BLOBs.
 * At catalog scale (≤10k) callers do brute-force cosine over the loaded
 * Float32Arrays; sqlite-vec is the documented upgrade path (no native
 * extension shipped — see docs/decisions-ml-eng.md).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { listingEmbeddings, listingImages, listings } from '../schema';

/** Copy a Float32Array into a standalone Buffer (little-endian bytes). */
export function vectorToBlob(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.byteLength);
  Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(buf);
  return buf;
}

/** Reconstruct a Float32Array from BLOB bytes (copies; alignment-safe). */
export function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`embedding blob length ${buf.byteLength} is not a multiple of 4`);
  }
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

export interface EmbeddingUpsert {
  listingId: string;
  contentHash: string;
  model: string;
  vector: Float32Array;
  imageUrl?: string | null;
}

/** Insert or refresh one embedding row (idempotent by (content_hash, model)). */
export function upsertEmbedding(db: Db, e: EmbeddingUpsert, now = Date.now()): void {
  db.insert(listingEmbeddings)
    .values({
      contentHash: e.contentHash,
      model: e.model,
      listingId: e.listingId,
      dim: e.vector.length,
      vector: vectorToBlob(e.vector),
      imageUrl: e.imageUrl ?? null,
      embeddedAt: now,
    })
    .onConflictDoUpdate({
      target: [listingEmbeddings.contentHash, listingEmbeddings.model],
      set: {
        listingId: e.listingId,
        dim: e.vector.length,
        vector: vectorToBlob(e.vector),
        imageUrl: e.imageUrl ?? null,
        embeddedAt: now,
      },
    })
    .run();
}

export interface CatalogEmbedding {
  listingId: string;
  contentHash: string;
  vector: Float32Array;
}

/**
 * All CURRENT embeddings for active listings: the join on content_hash drops
 * rows whose listing content changed since embed time (stale vectors).
 */
export function loadCatalogEmbeddings(db: Db, model: string): CatalogEmbedding[] {
  const rows = db
    .select({
      listingId: listingEmbeddings.listingId,
      contentHash: listingEmbeddings.contentHash,
      vector: listingEmbeddings.vector,
    })
    .from(listingEmbeddings)
    .innerJoin(
      listings,
      and(
        eq(listings.id, listingEmbeddings.listingId),
        eq(listings.contentHash, listingEmbeddings.contentHash),
      ),
    )
    .where(and(eq(listingEmbeddings.model, model), isNull(listings.removedAt)))
    .all();
  return rows.map((r) => ({
    listingId: r.listingId,
    contentHash: r.contentHash,
    vector: blobToVector(r.vector),
  }));
}

export interface EmbeddingStats {
  /** current (non-stale) embeddings over active listings */
  count: number;
  /** cache-invalidation cursor for in-memory catalog caches */
  maxEmbeddedAt: number;
}

export function embeddingStats(db: Db, model: string): EmbeddingStats {
  const row = db
    .select({
      count: sql<number>`count(*)`,
      maxEmbeddedAt: sql<number | null>`max(${listingEmbeddings.embeddedAt})`,
    })
    .from(listingEmbeddings)
    .innerJoin(
      listings,
      and(
        eq(listings.id, listingEmbeddings.listingId),
        eq(listings.contentHash, listingEmbeddings.contentHash),
      ),
    )
    .where(and(eq(listingEmbeddings.model, model), isNull(listings.removedAt)))
    .get();
  return { count: row?.count ?? 0, maxEmbeddedAt: row?.maxEmbeddedAt ?? 0 };
}

export interface EmbeddingTask {
  listingId: string;
  contentHash: string;
  imageUrl: string;
}

/**
 * Active listings with a primary image but no embedding for their CURRENT
 * content_hash under `model` — the `npm run embed` work queue.
 */
export function listingsMissingEmbedding(db: Db, model: string, limit?: number): EmbeddingTask[] {
  const rows = db
    .select({
      listingId: listings.id,
      contentHash: listings.contentHash,
      // NB: inside a SELECT projection drizzle renders `${listings.id}` as the
      // bare alias `"id"`, which the correlated subquery would resolve against
      // listing_images — qualify via the table object instead.
      imageUrl: sql<string>`(SELECT li.url FROM listing_images li WHERE li.listing_id = ${listings}.id ORDER BY li.position ASC LIMIT 1)`,
    })
    .from(listings)
    .where(
      and(
        isNull(listings.removedAt),
        sql`EXISTS (SELECT 1 FROM ${listingImages} li WHERE li.listing_id = ${listings.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${listingEmbeddings} e WHERE e.content_hash = ${listings.contentHash} AND e.model = ${model})`,
      ),
    )
    .orderBy(sql`${listings.lastSeenAt} DESC`)
    .limit(limit ?? -1)
    .all();
  return rows.filter((r) => r.imageUrl != null);
}
