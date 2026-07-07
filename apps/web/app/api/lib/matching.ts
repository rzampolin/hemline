/**
 * Stub-tolerant matching adapter (ARCHITECTURE §5/§6).
 *
 * Codes against @hemline/matching + @hemline/ai interfaces; every call is
 * wrapped so a "not yet implemented" stub falls back to a deterministic
 * in-route implementation of the documented formulas:
 *   - effective length: §5 formula + class priors (INLINE COPY — integration
 *     cleanup: delete `inlineHemForUser` once packages/matching lands)
 *   - score₀ = similarity × paletteBoost × freshnessDecay (§6)
 *   - re-rank: @hemline/ai rerank → templated deterministic `whyItWorks` (§7.5)
 * Fallback results are deterministic given the db state, so pagination and
 * tests are stable.
 */
import * as matching from '@hemline/matching';
import type {
  ColorTag,
  HardFilters,
  HemPosition,
  HemResult,
  Listing,
  PaletteColor,
  RankedListing,
  RankResponse,
  UserProfile,
} from '@hemline/contracts';
import type { CandidateListing } from '@hemline/db';

// ── effective length (§5) ────────────────────────────────────────────────

/** length-class → canonical inches for a 5'6" reference body (§5 fallback 2) */
const CLASS_PRIOR_INCHES: Record<string, number> = {
  micro: 30,
  mini: 33,
  above_knee: 36,
  knee: 39,
  midi: 44,
  mid_calf: 47,
  maxi: 55,
  floor: 60,
};

/**
 * INLINE fallback copy of docs/ARCHITECTURE.md §5 — used only while
 * packages/matching throws. Integration cleanup: remove in favor of
 * matching.hemForUser.
 */
export function inlineHemForUser(
  listing: Pick<Listing, 'lengthInches' | 'lengthClass'>,
  heightInches: number,
  heelInches = 0,
): HemResult {
  const measured = listing.lengthInches != null;
  const L = listing.lengthInches ?? (listing.lengthClass ? CLASS_PRIOR_INCHES[listing.lengthClass] : undefined);
  if (L == null || !Number.isFinite(heightInches) || heightInches <= 0) {
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }
  const hEff = heightInches + heelInches * 0.85;
  const s = 0.82 * hEff;
  const hemAboveFloor = s - L;
  const r = hemAboveFloor / hEff;
  let position: HemPosition;
  if (r > 0.42) position = 'upper_thigh';
  else if (r > 0.31) position = 'above_knee';
  else if (r > 0.26) position = 'knee';
  else if (r > 0.2) position = 'below_knee';
  else if (r > 0.12) position = 'mid_calf';
  else if (r > 0.03) position = 'ankle';
  else position = 'floor';
  return {
    position,
    hemAboveFloorInches: Math.round(hemAboveFloor * 10) / 10,
    basis: measured ? 'measured_length' : 'length_class_prior',
    confidence: measured ? 'high' : 'medium',
  };
}

/** Preferred path: packages/matching; deterministic inline fallback on stub throw. */
export function hemForUser(
  listing: Pick<Listing, 'lengthInches' | 'lengthClass'>,
  heightInches: number | null,
  heelInches = 0,
): HemResult {
  if (heightInches == null) {
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }
  try {
    return matching.hemForUser(listing, heightInches, heelInches);
  } catch {
    return inlineHemForUser(listing, heightInches, heelInches);
  }
}

// ── deterministic scoring fallbacks (§6) ─────────────────────────────────

function inlineCosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of Object.values(a)) na += v * v;
  for (const v of Object.values(b)) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  for (const [k, v] of Object.entries(a)) {
    const w = b[k];
    if (w !== undefined) dot += v * w;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function attributeSimilarity(
  userStyleTags: Record<string, number>,
  listingVector: Record<string, number>,
): number {
  try {
    return matching.attributeSimilarity(userStyleTags, listingVector);
  } catch {
    return inlineCosine(userStyleTags, listingVector);
  }
}

export function freshnessDecay(ageDays: number, halfLifeDays: number): number {
  try {
    return matching.freshnessDecay(ageDays, halfLifeDays);
  } catch {
    return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
  }
}

/** hex → coarse color family, for palette-vs-listing matching. */
export function hexToFamily(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const d = max - min;
  if (d < 24) {
    if (l < 0.18) return 'black';
    if (l > 0.85) return 'white';
    return 'gray';
  }
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const sat = d / 255;
  if (h < 15 || h >= 345) return l < 0.35 && sat < 0.5 ? 'brown' : 'red';
  if (h < 40) return l < 0.45 ? 'brown' : 'orange';
  if (h < 70) return sat < 0.35 && l < 0.5 ? 'brown' : 'yellow';
  if (h < 165) return 'green';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

export function paletteBoost(palette: PaletteColor[], colors: ColorTag[]): number {
  try {
    return matching.paletteBoost(palette, colors);
  } catch {
    if (palette.length === 0 || colors.length === 0) return 1.0;
    const paletteFamilies = new Set(
      palette.map((p) => hexToFamily(p.hex)).filter((f): f is string => f != null),
    );
    const matched = colors.filter(
      (c) =>
        (c.family && paletteFamilies.has(c.family.toLowerCase())) ||
        (c.hex && paletteFamilies.has(hexToFamily(c.hex) ?? '')),
    ).length;
    return 1.0 + 0.25 * Math.min(1, matched / colors.length);
  }
}

export function blendScores(llmRank: number, score0: number): number {
  try {
    return matching.blendScores(llmRank, score0);
  } catch {
    return 0.6 * llmRank + 0.4 * score0;
  }
}

// ── rank pipeline ────────────────────────────────────────────────────────

export interface RankOptions {
  limit: number;
  cursor?: string;
  personalize: boolean;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: number };
    return Number.isInteger(parsed.o) && (parsed.o as number) >= 0 ? (parsed.o as number) : 0;
  } catch {
    return 0;
  }
}

function templatedWhy(profile: UserProfile, item: CandidateListing, hem: HemResult): string {
  const bits: string[] = [];
  if (hem.position && profile.lengthPrefs.includes(hem.position)) {
    bits.push(`hits ${hem.position.replace(/_/g, ' ')} on you — your preferred length`);
  } else if (hem.position) {
    bits.push(`hits ${hem.position.replace(/_/g, ' ')} on you`);
  }
  const paletteFamilies = new Set(
    profile.palette.map((p) => hexToFamily(p.hex)).filter((f): f is string => f != null),
  );
  const paletteMatch = item.listing.colors.find(
    (c) => c.family && paletteFamilies.has(c.family.toLowerCase()),
  );
  if (paletteMatch) {
    bits.push(
      `${paletteMatch.name} works with your ${profile.colorSeason ? profile.colorSeason.replace(/_/g, ' ') : ''} palette`.trim(),
    );
  }
  const tagEntries = Object.entries(profile.styleTags).filter(([, w]) => w > 0);
  const overlapping = tagEntries
    .filter(([tag]) => (item.attributeVector[tag] ?? 0) > 0)
    .sort((a, b) => b[1] - a[1])[0];
  if (overlapping) {
    const label = overlapping[0].split(':').pop()?.replace(/_/g, ' ');
    if (label) bits.push(`the ${label} style matches your taste`);
  }
  if (bits.length === 0) return 'Fresh in your size and budget';
  const sentence = bits.slice(0, 2).join(', and ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface ScoredCandidate extends RankedListing {
  attributeVector: Record<string, number>;
}

/** Deterministic score₀ + hem for every candidate (§6). */
export function scoreCandidates(
  profile: UserProfile,
  candidates: CandidateListing[],
  now = Date.now(),
): ScoredCandidate[] {
  return candidates.map((c) => {
    const hem = hemForUser(c.listing, profile.heightInches, profile.heelPrefInches);
    const sim = attributeSimilarity(profile.styleTags, c.attributeVector);
    const simNorm = Object.keys(profile.styleTags).length === 0 ? 0.5 : (sim + 1) / 2;
    const boost = paletteBoost(profile.palette, c.listing.colors);
    const ageDays = Math.max(0, (now - c.listing.lastSeenAt) / 86_400_000);
    const halfLife = c.sourceKind === 'ebay' || c.listing.sourceId.includes('ebay') ? 7 : 21;
    const decay = freshnessDecay(ageDays, halfLife);
    // listings with parseable measurements rank above measurement-less (spec B1)
    const measurementBonus =
      c.listing.measurements.length != null || c.listing.lengthInches != null ? 0.05 : 0;
    const score = Math.min(1, Math.max(0, (simNorm * boost * decay) / 1.25 + measurementBonus));
    return {
      listing: c.listing,
      hem,
      score,
      whyItWorks: null,
      freshnessDecay: decay,
      attributeVector: c.attributeVector,
    };
  });
}

/** Post-SQL hem filter: "dresses that hit knee/midi ON ME" (§6 hard filter). */
export function applyLengthOnBodyFilter(
  scored: ScoredCandidate[],
  lengthOnBody: HemPosition[] | undefined,
): ScoredCandidate[] {
  if (!lengthOnBody || lengthOnBody.length === 0) return scored;
  const wanted = new Set(lengthOnBody);
  return scored.filter((s) => s.hem.position != null && wanted.has(s.hem.position));
}

/**
 * Full rank: score → sort → (optional) LLM re-rank of top 50 → paginate.
 * A stubbed @hemline/ai rerank drops us to the deterministic path with
 * templated `whyItWorks` (§7.5 degraded table).
 */
export async function rankCandidates(
  profile: UserProfile,
  candidates: CandidateListing[],
  filters: Pick<HardFilters, 'lengthOnBody'>,
  opts: RankOptions,
): Promise<RankResponse> {
  const scored = applyLengthOnBodyFilter(scoreCandidates(profile, candidates), filters.lengthOnBody);
  // stable deterministic order: score desc, then recency, then id
  scored.sort(
    (a, b) =>
      b.score - a.score || b.listing.lastSeenAt - a.listing.lastSeenAt || (a.listing.id < b.listing.id ? -1 : 1),
  );

  let mode: RankResponse['rerank']['mode'] = 'deterministic';
  let costUsd: number | null = null;

  if (opts.personalize && scored.length > 0) {
    try {
      const ai = await import('@hemline/ai');
      const topN = scored.slice(0, 50);
      const res = await ai.rerank(profile, topN);
      const order = new Map(res.ranking.map((id, i) => [id, i]));
      topN.sort((a, b) => (order.get(a.listing.id) ?? 99) - (order.get(b.listing.id) ?? 99));
      topN.forEach((item, i) => {
        item.whyItWorks = res.reasons[item.listing.id] ?? null;
        item.score = blendScores(1 - i / Math.max(1, topN.length - 1), item.score);
      });
      scored.splice(0, topN.length, ...topN);
      mode = 'llm';
      costUsd = res.costUsd;
    } catch {
      mode = 'deterministic'; // §7.5: stub/no-key → deterministic + templated why
    }
  }

  const offset = decodeCursor(opts.cursor);
  const page = scored.slice(offset, offset + opts.limit);
  // templated one-liners for the returned page when the LLM didn't provide them
  for (const item of page) {
    if (item.whyItWorks == null) {
      const cand: CandidateListing = {
        listing: item.listing,
        attributeVector: item.attributeVector,
        sourceKind: item.listing.sourceId.includes('ebay') ? 'ebay' : 'other',
      };
      item.whyItWorks = templatedWhy(profile, cand, item.hem);
    }
  }

  return {
    items: page.map(({ attributeVector: _av, ...rest }) => rest),
    nextCursor: offset + opts.limit < scored.length ? encodeCursor(offset + opts.limit) : null,
    totalMatched: scored.length,
    rerank: { mode, costUsd },
  };
}
