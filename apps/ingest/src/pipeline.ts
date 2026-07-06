/**
 * Ingest pipeline — docs/ARCHITECTURE.md §8.
 * fetchListings → upsert listings (bump last_seen_at, recompute content_hash)
 * → diff → enqueue changed hashes for extraction → flush batch → log ingest_run.
 */
import type { SourceConnector } from '@hemline/contracts';
import type { Db } from '@hemline/db';

export interface PipelineResult {
  runId: number;
  stats: { fetched: number; new: number; updated: number; unchanged: number; errors: number };
}

export async function runPipeline(_db: Db, _connector: SourceConnector): Promise<PipelineResult> {
  throw new Error('not yet implemented (data-eng): ingest pipeline — docs/ARCHITECTURE.md §8');
}
