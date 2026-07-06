# OWNER: data-eng

**Scope:** ingest worker — scheduler → connectors → normalize → extraction
queue (docs/ARCHITECTURE.md §2, §8). Also owns `packages/connectors`.

- `src/run.ts` — one-shot: all enabled sources (or `--source=<id>`), invoked by
  `npm run ingest` from the repo root
- `src/schedule.ts` — long-running node-cron loop per `sources.cadence_cron`
  (`npm run ingest:watch`). Add `node-cron` as a dependency here when you build it.
- `src/pipeline.ts` — fetchListings → upsert listings (bump last_seen_at,
  recompute content_hash) → diff → enqueue changed hashes for extraction →
  flush extraction batch → log ingest_run. Items unseen for 2× cadence get
  removed_at (soft delete).

Extraction is consumed through the frozen `ExtractionService` contract — ai-eng
ships a mock extractor first so you're never blocked.
