# OWNER: ai-eng

**Scope:** pure-TS matching — hard filters, effective length, attribute
similarity, scoring (docs/ARCHITECTURE.md §5–6). No LLM calls, no DB writes,
no I/O: pure functions only, so backend-eng can call them from route handlers.

## Deliverables
- `effective-length.ts` — **the signature feature.** Implement the exact §5
  formula (S = 0.82·H_eff, heel factor 0.85, r-bands, class priors for a 5'6"
  reference body, waist-to-hem 0.62 variant, stretchy −1", vintage size prior).
  Ship with the exhaustive Vitest band table (petite/average/tall × every band
  boundary × heel offsets) — it's the demo.
- `similarity.ts` — cosine over sparse tag vectors (user.styleTags ×
  listing.attributeVector)
- `scoring.ts` — score₀ = similarity × paletteBoost (1.0–1.25) ×
  freshnessDecay = exp(−ln2·ageDays/halfLife) (7d resale, 21d DTC);
  blend = 0.6·llmRank + 0.4·score₀
- `filters.ts` — SQL-shaped hard-filter predicates (size ∩ price ∩
  hem-position-for-user ∩ condition ∩ brand ∩ FTS), cap 500 newest-first

## Contracts (frozen)
`MatchingService`, `HardFilters`, `HemPosition`, `HemResult`, `RankRequest`,
`RankResponse` from `@hemline/contracts`.
