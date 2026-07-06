# OWNER: ai-eng

**Scope:** everything that calls Anthropic (docs/ARCHITECTURE.md §7). Also owns
`packages/matching`.

## Deliverables (in order — doc §10 track B)
1. **Mock extractor first** (unblocks data-eng immediately): deterministic rule
   engine — regex measurements, keyword taxonomy, confidence ≤ 0.4 (§7.5)
2. `client.ts`: `@anthropic-ai/sdk` wrapper (add the dependency here when you
   start), mock fallback, cost meter, `AI_DAILY_BUDGET_USD` hard cap (§7.1)
3. `extraction/`: Haiku attribute+measurement extraction — Batches API, prompt
   caching, `zodOutputFormat(ExtractedAttributesSchema)` (§7.2). Idempotent by
   `content_hash`.
4. `matching/`: effective-length, similarity, scoring (see packages/matching)
5. `rerank/`: Haiku personalized re-rank + 24h `rerank_cache` (§7.3)
6. `color/`: sharp Lab sampling + Sonnet 12-season classification, quiz
   fallback, privacy: selfie buffer never persisted (§7.4)

Models (from .env): `claude-haiku-4-5-20251001` (extraction, re-rank),
`claude-sonnet-4-6` (color season).

## Contracts (frozen)
`ExtractionService`, `ExtractionInput`, `ExtractedAttributes(-Schema)`,
`MatchingService`, `ColorAnalysisResult`, `MeasuredColors` from
`@hemline/contracts`. DB access is read-only for you.
