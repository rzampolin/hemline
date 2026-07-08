# ML Engineering Decisions — visual embeddings (2026-07-07)

Implements the docs/ARCHITECTURE.md §1 upgrade path ("Marqo-FashionSigLIP
behind the `StyleSimilarity` interface") — real visual similarity, composed
with (never replacing) the v1 attribute-vector path. The app remains fully
functional with zero ML setup, degrading exactly like the keyless-AI story.

## Machine survey (drove the stack choices)

| Item | Found | Consequence |
|---|---|---|
| Apple M1 Pro, 16 GB RAM, macOS 15.7 | ✅ | torch MPS backend for inference |
| python3 = 3.14.3 (brew), also 3.12 | ✅ | torch 2.12.1 publishes macOS arm64 wheels for cp310–cp314 → default `python3` is fine; setup script probes ≥3.10 |
| Disk: 99 GB free | ✅ | venv ~820 MB + HF model cache ~780 MB is trivial |

## 1. Model + loading path

**Marqo/marqo-fashionSigLIP** (Apache 2.0, open weights, 0.2B params, 768-d
output), loaded via **open_clip** (`hf-hub:Marqo/marqo-fashionSigLIP`) per the
model card — the transformers path needs `trust_remote_code=True`, open_clip
doesn't. Dual encoder → the same vectors serve image-to-image ("find dresses
like this"), text-to-image (free-text visual search), and swipe-derived style
profiles. Deps include `timm` + `transformers` + `sentencepiece` because
open_clip's SigLIP config uses a timm vision tower and an HF sentencepiece
tokenizer.

Measured on this machine (M1 Pro, MPS): model download ~780 MB (one-time, HF
cache), venv ~820 MB, model load 7–22 s (warm/cold FS cache). Compute is NOT
the bottleneck: ~30–50 img/s warm at batch 8 on cached 500px images (64 imgs
in 1.1 s after load); real catalog runs are download-bound by the 0.5 s/host
politeness delay (≈1–2 img/s per host). Interactive probes on the warm shared
child: ~25 ms (text), ~220 ms (image incl. download).

## 2. Sidecar architecture: `ml/embed.py`, JSONL over stdio

No HTTP service, no daemon to manage: TS spawns the venv python and speaks
JSONL (`packages/matching/src/embedder.ts`). One protocol (`batch` mode with
`--batch-size N`) serves both use cases:

- **bulk** (`npm run embed`): batch-size 8, per-item error lines keep the run
  alive (bad url/429/undecodable image → logged, everything else proceeds);
- **interactive** (find-similar): batch-size 1 = flush per line, and the web
  process keeps ONE long-lived child on `globalThis` so the ~10 s model load
  is paid once, not per request. Crash → respawn on next request; failure →
  `null` → attribute fallback.

Downloads are cached in `ml/.cache` (sha1 of url), rate-limited 0.5 s/host,
UA `HemlineBot/1.0 (+$CRAWLER_CONTACT)` — same politeness posture as the
connectors. `single`/`text`/`warmup` modes exist for CLI/debug one-shots.

DB access stays in TS: the sidecar never touches SQLite (the task sketch had
python "writing vectors back"; keeping drizzle as the single storage boundary
was cleaner and keeps the python surface tiny).

## 3. Storage: `listing_embeddings` (additive)

Keyed `(content_hash, model)` — mirrors the `extractions` idempotency design:
content change → new hash → listing reappears in the missing-embeddings queue;
`npm run embed` re-runs are free. `model` in the key lets a future model swap
coexist during re-embedding. Vector = L2-normalized Float32Array as a
little-endian BLOB (+ `dim`, provenance `image_url`, `embedded_at`).
Catalog reads join `listings.content_hash` so stale vectors are invisible
without any cleanup job.

**Brute-force cosine in TS** over Float32Arrays loaded once into memory
(cache invalidated by count+max(embedded_at)): at 10k × 768-d that's ~8 M
multiply-adds ≈ single-digit ms, and ~30 MB RAM. **sqlite-vec deliberately not
added** — a native extension dependency isn't worth it below ~100k vectors;
the repository (`packages/db/src/query/embeddings.ts`) is the seam where a
`vec0` virtual table would slot in.

## 4. Similarity composition (blend, never replace)

- `packages/matching/src/embedding.ts` (pure): dense cosine, 0..1 mapping
  (same `(cos+1)/2` convention as `attributeSimilarity`), weighted averaging,
  and `createEmbeddingStyleSimilarity` — the literal `StyleSimilarity` adapter
  sketched in similarity.ts's upgrade-path comment (dense vectors serialized
  as `{"0": …}` at the contract boundary; zero contract changes).
- **Blend weight 0.6/0.4** (`EMBEDDING_BLEND_WEIGHT`): embedding leads,
  attribute anchors — the same split §6 uses for llmRank vs score₀. Applied
  inside the matching service via a new optional `embeddingScore` port
  (additive to `MatchingPorts`); `undefined`/`null` keeps scoring
  byte-identical to pre-ML.
- **Style profile from swipes**: weighted average of liked/saved item vectors
  (save = 1.25× like, reusing `SWIPE_VERDICT_WEIGHT`), L2-normalized, computed
  per request from `swipe_events` (last 200 positives) — nothing persisted, so
  it can't drift out of sync with the swipe log. Dislikes are NOT subtracted:
  mean-shift on the unit sphere at calibration sample sizes is noise; the
  attribute path already learns negatives.
- **find-similar**: visual tier first (photo bytes → base64 → sidecar; or
  imageUrl; or hint text via the text encoder), attribute tier untouched as
  fallback. Response gains additive `matchBasis: 'embedding' | 'attributes'`
  and `extractionMode: 'skipped'` on the visual tier (no extraction runs — no
  Haiku spend when vectors answer). Uploaded bytes stay in memory end-to-end.

## 5. Degradation matrix

| State | find-similar | feed ranking | `npm run embed` |
|---|---|---|---|
| No ml/.venv | attribute path (Haiku or rule engine) | attribute-only | "ml not set up — run `npm run ml:setup`" (exit 1) |
| venv, no vectors yet | attribute path (guard checks catalog count BEFORE spawning python) | attribute-only | embeds queue |
| vectors, venv later deleted | attribute path (probe needs python) | **still blended** — ranking only reads stored vectors | setup message |
| sidecar crash / bad image / timeout | per-request fallback to attribute path | unaffected | per-item failure count, run continues |

Fixture listings (placehold.co tiles) are deliberately excluded from embedding
(`PLACEHOLDER_HOSTS` in apps/ingest/src/embed.ts): they're SVG (PIL can't
decode) and would cluster into garbage matches if rasterized. They stay on the
attribute path; visual search covers real ingested listings.

## 6. Small notes

- `EMBEDDING_MODEL_TAG` / `EMBEDDING_DIM` added to contracts (additive
  constants); `ml/embed.py` mirrors the tag — bump both to swap models.
- `@hemline/matching` gained a `./embedder` subpath export so the node-only
  bridge (child_process) never enters the package index that client bundles
  might touch; the index only exports the pure math.
- eslint now ignores `ml/.venv`/`ml/.cache`; fixed a pre-existing unused
  `Browser` import in `e2e/qa.spec.ts` that failed `npm run lint` on this
  branch (one-line, outside my surface, needed for the green gate).
- Tests: pure vector math + BLOB roundtrip + repository staleness
  (packages/db, packages/matching), sidecar IO contract against a mocked
  embed.py (node stub speaking the JSONL protocol — no torch needed in CI),
  degradation-without-python, and style-port behavior with stored vectors.
  The pre-existing route tests double as the no-vectors degradation suite.
