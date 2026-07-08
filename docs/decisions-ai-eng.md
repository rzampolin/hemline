# AI-eng decisions (packages/ai, packages/matching)

Pragmatic calls made while implementing docs/ARCHITECTURE.md §5–§7 where the
doc was ambiguous, contradictory, or silent. Everything else follows the doc.

1. **Effective length: formula wins over the worked example.** §5's formula
   says `r = hemAboveFloor / H_eff`, but its worked example ("r=0.135" for a
   44″ dress on 5'2″; "r=0.216" on 5'10″) was computed as `hem / S`
   (S = 0.82·H_eff). The two disagree. Implemented **the formula as written**:
   it is the one consistent with the band table's anthropometric rationale
   (knee crease ≈ 0.285·H means the knee band 0.26–0.31 only makes sense over
   H, not S). Consequence for demo copy: a 44″ "midi" on 5'2″ classifies as
   `ankle` (hem 6.8″ above floor — accurate), not the example's `mid_calf`;
   on 5'10″ it classifies `mid_calf`, not `below_knee→knee`. Flagged to EM —
   if product prefers the example's outcomes, change one line
   (`r = hemAboveFloor / s`) and re-derive the test table.

2. **`hemForUser` contract signature can't carry §5's edge cases** (waist-basis
   measurements, stretchy fabric, image-estimated confidence). The contract
   function assumes HPS/seller-text/non-stretch; the full-fidelity
   `computeHem(HemInput)` (same module) exposes `measuredFrom: 'waist'`,
   `stretchy`, and `lengthSource: 'image_estimate'` (→ confidence 'medium'
   per §5 fallback 1). Backend should call `computeHem` when extraction
   provides those flags. No contract change required (additive export).

3. **Measured-length confidence is 'high' by default.** §5 says measured is
   'high' when from seller text, 'medium' when Haiku estimated from an image.
   The `Listing` contract doesn't carry the provenance bit, so `hemForUser`
   reports 'high'; the extraction pipeline can pass `lengthSource` through
   `computeHem` when it starts estimating lengths from images (not done in v1
   — extraction only reports lengths it can ground in text).

4. **`matchesHardFilters` takes an optional third `ctx` param**
   (`UserFitContext`: height/heel for `lengthOnBody`, body measurements for
   size compat, `includeUnknownLength` opt-in). The frozen two-arg call still
   works (label-only sizing, `lengthOnBody` then excludes everything since no
   hem can be computed for nobody). Additive, no contract change.

5. **Vintage weak prior implemented as a range shift**: vintage label `s`
   matches user sizes `s−6 … s−2` ("a vintage 12 matches modern 6–10"), and is
   ignored entirely when both garment and body measurements exist
   (measurements ± silhouette ease win, §5 ease table verbatim; ease window is
   `body − 1″ … body + ease + 2″`).

6. **`StyleSimilarity` interface lives in `packages/matching/src/similarity.ts`**,
   not contracts — the contracts freeze doesn't define it. v1 backend
   `attributeStyleSimilarity` (kind `attribute-v1`, sparse cosine); the
   FashionSigLIP + sqlite-vec upgrade path is documented as an adapter stub in
   the same file. **Contract-change request:** promote `StyleSimilarity` into
   `@hemline/contracts` when a second implementation lands.

7. **Similarity → score mapping:** cosine is mapped to 0..1 via `(cos+1)/2`,
   and an empty user style vector (new user, no swipes) scores a **neutral
   0.5** for every listing so freshness/palette drive the initial feed instead
   of zeroing score₀ (§6's `score₀ = sim × boost × decay` would otherwise
   return 0 for every listing pre-calibration).

8. **Swipe learning weights** (doc silent): like +1, save +1.25, dislike −1,
   skip −0.2, learning rate 0.25, weights clamped to ±2, pruned below 0.01.
   Deterministic additive EMA in `updateStyleVector`.

9. **MatchingService is a ports-and-adapters factory**
   (`createMatchingService({loadProfile, loadCandidates, rerank?})`) — the
   package stays pure (no DB, no LLM). backend-eng wires SQL + `@hemline/ai`'s
   `createReranker`. Cursor is opaque base64 offset pagination. Re-ranker
   failure or `personalize:false` falls back to deterministic order (§6).
   `Listing` doesn't carry `attributeVector` (it lives in the extractions
   table), so the service derives an equivalent vector from listing attributes
   (`attributeVectorOf`) — same construction as the extractors. If backend can
   join `extractions.attribute_vector_json` into candidates cheaply, pass it
   through instead (TODO noted).

10. **Extraction persistence is an injected port** (`ExtractionCacheStore`
    get/set by `content_hash`, storing `{attributes, model}`) mirroring the
    `extractions` table. packages/ai has read-only DB access per OWNER.md, so
    backend/data-eng own the Drizzle adapter; an in-memory implementation
    ships for tests/dev. Same pattern for `rerank_cache`
    (`RerankCacheStore`, 24h TTL).

11. **Batches API is implemented but off by default.**
    `ExtractionService.extractBatch` must resolve with results, and a Batches
    round-trip can take ~1h — blocking interactive ingest runs. Chunked live
    concurrency (5 parallel) is the default; set `EXTRACTION_USE_BATCHES=true`
    (or `useBatchesApi: true`) and ≥20 misses to use the Batches API at 50%
    off for the daily crawl (doc §7.2). Poll interval 30s, 60min budget, mock
    fallback on timeout/errored entries.

12. **The model never produces `attributeVector` or gets trusted on
    measurements.** Structured output schema excludes the vector (records are
    unsupported in strict JSON schema; deriving it in code keeps mock/live/
    fixture vectors cosine-compatible). The deterministic regex pre-parse is
    embedded in the prompt as ground truth AND re-verified after: any model
    measurement >1.5″ from a regex-parsed value is overwritten by the regex
    value.

13. **zod v3/v4 split:** contracts are zod v3 (`zod@3.25`); the SDK's
    `zodOutputFormat` requires `zod/v4`. Model-facing schemas are authored in
    `zod/v4`, deriving enum values from the v3 contract schemas' `.options`
    so taxonomies can't drift. Final outputs are still validated against the
    v3 `ExtractedAttributesSchema` before leaving the service.

14. **Sonnet color classification returns season/confidence/explanation only;**
    palette + avoid lists always come from the curated 12-season tables
    (`SEASON_DATA`) so live, deterministic, and quiz paths surface identical
    palettes (stable UI, shareable palette card). The prompt contains the same
    numeric rubric as the deterministic classifier and ONLY the measured Lab
    values — the image is never sent (doc §7.4 step 3). Caveats (deep skin
    L*<35, olive lean, poor sample) are computed deterministically.

15. **Quiz path synthesizes `measured`**: `ColorAnalysisResult.measured` is
    required by the (frozen) contract, but the quiz has no selfie. Values are
    synthesized from the quiz-derived axes and marked in the explanation.
    **Contract-change request (optional):** make `measured` nullable, or add
    `source: 'selfie' | 'quiz'`.

16. **Selfie privacy:** the buffer is resized/sampled in-memory via sharp and
    never written anywhere; only derived Lab numbers and scalars leave
    `sampleSelfie`. No face-detection dependency — fixed regions relative to
    the client's oval guide (cheeks + forehead strip; optional user-tapped eye
    points), median-filtered with top/bottom 20% luminance dropped.

17. **Mock-extractor ground-truth caveat:** fixture ground truths include
    attributes not present in the listing text (image-only necklines/sleeves,
    hidden lengths behind "Falls to a midi length", ±1″ measurement noise).
    Accuracy is asserted on text-derivable fields (≥90–95% per field,
    97.7% overall); raw all-field numbers (87.6%) are printed by the test for
    tracking. A live Haiku pass with vision is expected to close most of the
    remaining gap.

18. **Cost meter prices** haiku-4-5 at $1/$5, sonnet-4-6 at $3/$15 per MTok,
    cache reads at 0.1×, writes at 1.25×, batch at 0.5×; unknown models
    default to Sonnet pricing (conservative). Budget check happens before
    every live wave/call; crossing `AI_DAILY_BUDGET_USD` (default 5) flips
    `effectiveMode()` to 'mock' mid-run.

19. **Enum-validation recovery ladder (2026-07-07).** Live Haiku occasionally
    emits enum values outside the closed vocabularies even under structured
    outputs (observed: silhouette, occasions items) — previously the whole
    extraction fell back to mock (129/1,203 on the first live pass). The
    service now: validates → retries ONCE with the Zod issues fed back
    (user/assistant/user turn) → deterministically COERCES (invalid enum →
    'other' where the enum has it, else null; invalid array items dropped;
    `coerce.ts`) → only then mock-falls-back with a loud `[FALLBACK]` log
    carrying the full content hash. Counters (`ExtractionRunStats`: liveCalls/
    retries/retrySuccesses/coercions/fallbacks/mock/cacheHits) + `costUsd()`
    ride on the returned service (`ExtractionServiceWithStats`, additive —
    the frozen `ExtractionService` contract is unchanged).

20. **Vision length-estimation pass (`npm run extract:lengths`, 2026-07-07).**
    Brand sites don't state HPS inches (~1% coverage), so a FOCUSED second
    pass (`packages/ai/src/lengths`) makes one Haiku vision call per
    extraction row with `length_inches IS NULL` + a primary image: grounded
    prompt (fashion models ~5'9"/175 cm anchor, shoulder-to-hem, self-assessed
    confidence), schema-constrained `{lengthInches, confidence, reasoning}`.
    Estimates are sanity-clamped against the §5 class prior bands (±2″
    tolerance; a "mini" at 55″ is distrusted → class prior kept, low
    confidence). Results persist with the new additive
    `ExtractedAttributes.lengthBasis`/`extractions.length_basis` column
    ('stated' | 'image_estimate'); matching maps 'image_estimate' →
    `computeHem(lengthSource:'image_estimate')` → confidence 'medium'
    (§5 fallback 1), and the UI only shows the solid "Measured" treatment at
    basis='measured_length' AND confidence='high'. Idempotency: every
    attempted row gets length_basis='image_estimate' (clamped/no-estimate rows
    keep NULL inches → hem honestly falls back to the class prior), failed
    calls stay queued; `model IN ('manual','fixture')` rows are never touched.

21. **CLI cost reporting (2026-07-07).** `extract:upgrade` and
    `extract:lengths` print an UPFRONT estimate (N × per-item estimate with
    the token assumptions stated), running cost in progress lines, and the
    ACTUAL metered total at completion; budget-capped runs stop cleanly with
    resume instructions. `.env` `AI_DAILY_BUDGET_USD` raised 5 → 10 for
    today's two passes (~$0.4 upgrade + ~$3 lengths on top of ~$2 already
    spent would trip the $5 cap); `.env.example` default stays 5.

22. **Length estimation v2 — stated model heights (2026-07-07).** Many brand
    PDPs state the vision pass's missing anchor ("Model is 5'10" and wears a
    size S" — Staud, Reformation, Sister Jane…). A free deterministic parser
    (`packages/ai/src/extraction/model-height.ts`, exported `parseModelInfo`)
    extracts {modelHeightInches, modelSizeWorn} from title+description:
    feet'inches (straight/unicode quotes/primes), "5 ft 10", "5 feet 10
    inches", 175cm/175 cm; model context required near the number ("model",
    "she", "mannequin", "height"…), garment-measurement labels directly before
    the number veto it ("Length: 175 cm"), sanity range 5'2"–6'2". When a
    stated height exists the vision prompt anchors on THAT height with
    linearly scaled body landmarks (69" baseline: shoulder 56.5", knee 19.5",
    mid-calf 11", ankle 3" — × h/69) and the anchor is recorded in new
    additive `extractions.length_anchor` ('stated_model_height' |
    'assumed_default') + `length_anchor_height_in` columns (drizzle schema +
    ddl.ts ADDITIVE_COLUMNS). `npm run extract:lengths -- --reanchor` re-runs
    default-anchored image estimates whose stated height is ≥1" off 69"
    (below that the correction drowns in the estimate's own noise); the free
    parser coverage is printed BEFORE the cost quote. Bookkeeping fix riding
    along: v1 wrote clamped/not-estimable attempts as
    length_basis='image_estimate' with NULL inches; those are migrated (no
    API calls) to the new additive `LengthBasis` value **'not_estimable'**,
    so basis='image_estimate' now always implies inches present (matching/UI
    only ever branch on 'image_estimate' when inches exist, so the new value
    is invisible to them).
