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
