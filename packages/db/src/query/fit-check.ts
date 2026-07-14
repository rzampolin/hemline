/**
 * fit_check_cache repository (additive, 2026-07-13 paste-a-dress-link).
 *
 * Caches the PARSED external page (plus extraction attributes when one ran)
 * by sha256(url), so a repeat paste costs zero network fetches and zero AI
 * spend. The per-user fit math (hem verdict, size match, similar rack) is
 * recomputed on every request — only the user-independent parse is cached.
 * Expired rows are deleted lazily on read (rerank_cache pattern).
 */
import { createHash } from 'node:crypto';
import { eq, lte } from 'drizzle-orm';
import type { Db } from '../client';
import { fitCheckCache } from '../schema';
import { parseJson } from './mappers';

/** Successful parses: ~24h. */
export const FIT_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Negative entries (fetch failed / bot-blocked): short TTL so retries work. */
export const FIT_CHECK_NEGATIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Cached payload. `page` is the user-independent parse result
 * (structurally @hemline/connectors' ParsedExternalPage — this package sits
 * below connectors in the workspace graph, so the shape stays `unknown` here);
 * `attributes`/`extractionMode` are present when an extraction ran.
 * `negative: true` marks a short-TTL fetch-failure entry.
 */
export interface CachedFitCheckPage {
  page: unknown;
  attributes?: unknown;
  extractionMode?: 'live' | 'mock';
  /** stated model height parsed from the FULL page text at fetch time */
  modelHeightInches?: number | null;
  negative?: boolean;
}

export function fitCheckUrlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export function getFitCheckCache(
  db: Db,
  url: string,
  now = Date.now(),
): CachedFitCheckPage | null {
  db.delete(fitCheckCache).where(lte(fitCheckCache.expiresAt, now)).run();
  const row = db
    .select()
    .from(fitCheckCache)
    .where(eq(fitCheckCache.urlHash, fitCheckUrlHash(url)))
    .get();
  if (!row) return null;
  return parseJson<CachedFitCheckPage | null>(row.resultJson, null);
}

export function setFitCheckCache(
  db: Db,
  url: string,
  value: CachedFitCheckPage,
  now = Date.now(),
): void {
  const ttl = value.negative ? FIT_CHECK_NEGATIVE_TTL_MS : FIT_CHECK_CACHE_TTL_MS;
  const row = {
    urlHash: fitCheckUrlHash(url),
    url,
    resultJson: JSON.stringify(value),
    createdAt: now,
    expiresAt: now + ttl,
  };
  db.insert(fitCheckCache)
    .values(row)
    .onConflictDoUpdate({ target: fitCheckCache.urlHash, set: row })
    .run();
}
