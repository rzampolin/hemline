/**
 * ETag / Last-Modified cache backed by `sources.etag_json`.
 * docs/ARCHITECTURE.md §3, §4.2, §8.
 *
 * TODO(data-eng): implement DB-backed cache (read/write sources.etag_json).
 */
import type { EtagCache } from '@hemline/contracts';

export function createEtagCache(_sourceId: string, _db: unknown): EtagCache {
  throw new Error(
    'not yet implemented (data-eng): DB-backed ETag cache over sources.etag_json',
  );
}
