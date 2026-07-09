# Search decisions (hybrid free-text search, 2026-07-09)

Owner: search-eng. Scope: the upgrade of `q` from token-AND SQL LIKE to the
three-stage hybrid (founder-approved). Everything here is ADDITIVE on the
frozen contracts; explicit filter params from the filter sheet bypass all of
it.

## 1. The problem

`q` was eight LIKE-tokens ANDed over title/brand/description
(packages/db queryCandidates). "pink" worked (7 prod matches — only titles
that literally say pink); "summer formal" returned nothing, ever, because no
listing contains both words. Vocabulary-gap queries ("cottagecore",
"wedding guest") were dead on arrival.

## 2. Architecture — three stages, strictly additive

```
q ──► stage 1: parseQueryDeterministic (packages/ai/search/parse.ts)
│       always on, pure, free — taxonomy/price/size/brand span consumption
├──► stage 3: Haiku query parse (packages/ai/search/llm.ts)
│       keyed → enrichment only; GLOBAL 30d cache (search_query_cache);
│       2.5s request deadline, background fill; keyless → skipped
├──► merge (stage 1 wins per hard field; LLM fills gaps, soft unions)
├──► SQL: hard filters only (price/size/lengthClass/brand ∩ explicit params)
│       — the LIKE gate is GONE on interpreted queries
├──► stage 2: FashionSigLIP dual-encoder query embed (web lib/embeddings)
│       only when the sidecar is RESIDENT and the catalog has vectors
└──► evidence gate + relevance blend → searchRelevance port →
        0.7·relevance + 0.3·score₀ → (unchanged) rerank/diversity/pagination
```

Both `GET /api/search` and `POST /api/rank` (the feed search box) run this via
the shared `rankForUser`; guests included (the parse cache is global).

## 3. The hard/soft rule (the critical design decision)

Only things the user EXPLICITLY constrained become hard filters:
**price, size, length class, brand.** Everything else — occasions, color
families, fabrics, silhouettes, necklines, patterns, and all vibe/mood/season
language — only ever influences ranking. "summer", "cottagecore", "elegant"
can never empty a result set; they flow into soft signals + the semantic
query text. LLM-suggested brands are validated against the stored brand
labels (`expandKnownBrand`) so a hallucinated brand can never hard-filter;
brand mentions expand to every collection-suffixed label ("staud" →
"STAUD FALL 2025" …) because exact `brand IN (…)` would miss the noisy prod
labels.

Color sits on the SOFT side deliberately (matches the stage-3 schema): typing
"pink" ranks pink first rather than hard-filtering, and the evidence gate
(below) keeps the result set honest — in practice every returned item has
pink attribute evidence.

## 4. Relevance scoring + blend weights

Per candidate, up to three 0..1 components (packages/matching
search-relevance.ts):

| component | weight | source |
|---|---|---|
| attribute match | **0.5** | soft signals vs the sparse extraction vector (`occasion:formal`, `color:pink`, …) — the strongest, most trustworthy signal |
| semantic | **0.3** | query-text embed vs catalog FashionSigLIP vectors, min-max normalized within the candidate set (raw text↔image cosines cluster in a narrow band) |
| lexical | **0.2** | residual tokens vs title/brand/description — exact-hit boost |

Weights renormalize over whichever components exist (no vectors → 0.5/0.2;
attribute-less query → 0.3/0.2; …) so a missing stage redistributes weight
instead of penalizing. Final: `0.7·relevance + 0.3·score₀` — query relevance
leads, style/palette/freshness anchor. Freshness, size handling, rerank, and
the brand/source diversity interleave are untouched downstream (which is why
demo scores are not strictly monotonic — the diversity guard still reorders).

**Evidence gate**: a candidate stays in a query result only with ≥1 positive
signal — any attribute match, any lexical hit, or a top-50 semantic rank
(`SEMANTIC_RECALL_TOP_K`). Vocabulary-gap queries recall through the semantic
top-K; without vectors, an unknown word honestly returns 0 rather than
dumping the catalog. Queries that consume entirely into hard filters
("STAUD mini") skip the gate and relevance — plain score₀ ranking stands.

## 5. Stage 3 specifics

- Extraction-service pattern: `zodOutputFormat`-constrained Haiku
  (rerank-tier model), prompt-cached system block, cost metered on the shared
  client, keyless/over-budget → skipped entirely.
- GLOBAL cache: parses are user-independent — key is sha256(normalized
  query), table `search_query_cache` (additive; lazy expiry like
  rerank_cache), TTL 30 days. ~$0.002/parse, paid once per query string ever.
- 2.5s request deadline, but the live call is NOT aborted on a miss: it
  completes in the background (bounded 15s), writes the cache, and the next
  identical search gets it free (live eval: 2–4s cold-call latency made the
  abort-and-negative-cache approach lose 7/20 parses AND their cost).
  Only real failures (API error, truncation, schema-invalid) negative-cache,
  for 5 minutes. In-flight fills are deduped per cache key process-wide.
- Live eval 2026-07-09: 20/20 schema-valid, $0.0385 total (see
  scripts/search-eval.ts; report table in the task log).

## 6. Stage 2 specifics

- The query embeds through the same dual encoder as catalog images
  (`ml/embed.py` text op) — no new model.
- Semantic only runs when the sidecar reports RESIDENT (`sidecarStatus() ===
  'ready'`); a cold sidecar gets a fire-and-forget warmup and THIS search
  skips semantics rather than paying the 5–20s model load. 1.5s hard embed
  timeout; small per-process query-vector LRU (pagination never re-embeds).
- Invariants: no venv → silently skipped; listings WITHOUT vectors remain
  findable through attribute/lexical evidence (tested with a protocol-stubbed
  sidecar) — semantic is additive recall, never a gate.

## 7. UX: interpreted chips (removable)

`RankResponse.interpreted` (additive) carries the extracted signals
(hard-flagged), the residual/vibe terms, whether semantics ran, and which
parser answered. The feed renders them as `RemovableChip`s; removing one adds
its raw consumed term to the `lex` URL param → `HardFilters.lexicalTerms` →
the term is excluded from ALL interpretation (structured and semantic —
enforced post-merge so it survives the global parse cache) and participates
as plain lexical text only. New queries reset `lex`. Chips whose derived
filter was overridden by an explicit param are dropped (never render a filter
that wasn't applied).

## 8. Known limitations / upgrade path

- The 500-candidate stratified cap applies BEFORE the evidence gate, so a
  soft-only query over a catalog much larger than the cap can lose matches
  that didn't survive the cap. Fine at today's scale (≤2k fresh listings);
  the documented upgrade is an OR-shaped SQL evidence prefilter (colors/
  occasions via json_each, tokens via FTS5) feeding the same gate.
- Brand matching is leading-word-sequence only; a query word that is also a
  collection prefix ("dream") will hard-filter to those labels — removable
  via its chip, and properly fixed by the pending junk-brand normalization.
- `interpreted` is only as good as extraction coverage: occasions/colors come
  from the extraction vectors, so unextracted listings rely on lexical/
  semantic evidence.

## 9. Measured before/after (prod db COPY, guest, keyless, sidecar warm)

| query | before (LIKE) | after (hybrid) | top-1 after |
|---|---|---|---|
| "summer formal" | **0** | 121 (occasion:formal + semantic "summer") | Elmer Linen Dress — Reformation |
| "pink" | 7 (title-only) | 82 (attribute-evidenced pink) | Tiffani Silk Dress — Reformation |
| "silk midi under $200" | **0** | 34 (midi* ∩ ≤$200*, silk ranked first) | Sofia Silk Dress — Reformation, $198 |

Repro: `cp data/hemline.db /tmp/copy.db && HEMLINE_ML_DIR=ml npx tsx
scripts/search-demo.ts /tmp/copy.db`.
