/**
 * Mock implementation of the API surface (docs/ARCHITECTURE.md §4.7), used
 * when NEXT_PUBLIC_API_MOCK=1. Runs entirely client-side: the anonymous
 * profile lives in localStorage, the catalog comes from the fixture-derived
 * dataset, ranking mirrors the deterministic path of §6, and the hem is
 * computed with the §5 formula. Everything returns contract-shaped data.
 */
import type {
  BrandSizesPut,
  ColorAnalysisPut,
  ColorAnalysisQuizRequest,
  ColorAnalysisResult,
  ColorSeason,
  HemPosition,
  Listing,
  ListingDetailResponse,
  MetaFiltersResponse,
  ProfilePatch,
  QuizAnswers,
  RankedListing,
  RankRequest,
  RankResponse,
  SwipesPost,
  SwipesPostResponse,
  UserProfile,
} from '@hemline/contracts';
import { CATALOG, BY_ID, cosine, hexToFamily, type CatalogEntry } from './data';
import { DEFAULT_HEIGHT_INCHES, hemForUser } from '../hem';
import { SEASONS } from '../seasons';
import { KEYS, readLocal, writeLocal } from '../local';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── profile persistence ─────────────────────────────────────────────────── */

function defaultProfile(): UserProfile {
  return {
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `anon-${Date.now()}`,
    heightInches: null,
    heelPrefInches: 0,
    sizesNormalized: [],
    bodyMeasurements: { bust: null, waist: null, hip: null },
    brandSizes: [],
    lengthPrefs: [],
    coveragePrefs: {},
    budget: { minCents: null, maxCents: null },
    colorSeason: null,
    palette: [],
    styleTags: {},
    onboarded: false,
  };
}

function getProfile(): UserProfile {
  const stored = readLocal<UserProfile | null>(KEYS.profile, null);
  if (stored) return stored;
  const fresh = defaultProfile();
  writeLocal(KEYS.profile, fresh);
  return fresh;
}

function saveProfile(p: UserProfile): UserProfile {
  writeLocal(KEYS.profile, p);
  return p;
}

/* ── session / profile ───────────────────────────────────────────────────── */

export async function mockGetSession(): Promise<UserProfile> {
  await delay(60);
  return getProfile();
}

export async function mockPatchProfile(patch: ProfilePatch): Promise<UserProfile> {
  await delay(60);
  return saveProfile({ ...getProfile(), ...patch });
}

export async function mockPutBrandSizes(sizes: BrandSizesPut): Promise<UserProfile> {
  await delay(60);
  return saveProfile({ ...getProfile(), brandSizes: sizes });
}

/* ── swipes → learned styleTags ──────────────────────────────────────────── */

const VERDICT_WEIGHT: Record<string, number> = { like: 0.35, save: 0.5, dislike: -0.3, skip: 0 };

export async function mockPostSwipes(events: SwipesPost): Promise<SwipesPostResponse> {
  await delay(90);
  const p = getProfile();
  const tags = { ...p.styleTags };
  for (const ev of events) {
    const entry = BY_ID.get(ev.listingId);
    if (!entry) continue;
    const w = VERDICT_WEIGHT[ev.verdict] ?? 0;
    if (w === 0) continue;
    for (const [tag, weight] of Object.entries(entry.attributeVector)) {
      tags[tag] = Math.max(-1.5, Math.min(3, (tags[tag] ?? 0) + w * weight));
    }
  }
  saveProfile({ ...p, styleTags: tags });
  return { styleTags: tags };
}

/* ── ranking (deterministic path of ARCHITECTURE §6) ─────────────────────── */

/**
 * PROPOSED contract addition (friction note): HardFilters has no source
 * facet, but PRODUCT_SPEC B3 requires a source filter. The mock honors an
 * optional `sources` extension; the live client strips it until the contract
 * grows one.
 */
export type SourceKindFilter = 'resale' | 'brand';
export type FeedFilters = RankRequest['filters'] & { sources?: SourceKindFilter[] };
export type FeedRankRequest = Omit<RankRequest, 'filters'> & { filters: FeedFilters };

const kindOf = (sourceId: string): SourceKindFilter =>
  sourceId.includes('ebay') ? 'resale' : 'brand';

function paletteFamilies(p: UserProfile): Set<string> {
  return new Set(p.palette.map((c) => hexToFamily(c.hex)));
}

function matchesPalette(listing: Listing, families: Set<string>): boolean {
  return listing.colors.some((c) => families.has(c.family));
}

function freshnessDecay(listing: Listing): number {
  const ageDays = (Date.now() - listing.lastSeenAt) / 86_400_000;
  const halfLife = kindOf(listing.sourceId) === 'resale' ? 7 : 21;
  return Math.exp((-Math.LN2 * ageDays) / halfLife);
}

function passesFilters(
  entry: CatalogEntry,
  filters: FeedFilters,
  hemPos: HemPosition | null,
): boolean {
  const l = entry.listing;
  const f = filters;
  if (f.sizesNormalized?.length) {
    if (!l.sizeNormalized.some((s) => f.sizesNormalized!.includes(s))) return false;
  }
  if (f.priceMinCents != null && l.priceCents < f.priceMinCents) return false;
  if (f.priceMaxCents != null && l.priceCents > f.priceMaxCents) return false;
  if (f.conditions?.length && !f.conditions.includes(l.condition)) return false;
  if (f.brands?.length && (!l.brand || !f.brands.includes(l.brand))) return false;
  if (f.colorFamilies?.length && !l.colors.some((c) => f.colorFamilies!.includes(c.family)))
    return false;
  if (f.lengthOnBody?.length && (!hemPos || !f.lengthOnBody.includes(hemPos))) return false;
  if (f.sources?.length && !f.sources.includes(kindOf(l.sourceId))) return false;
  if (f.query) {
    const hay = `${l.title} ${l.brand ?? ''} ${l.colors.map((c) => c.name).join(' ')} ${l.fabric ?? ''} ${l.silhouette ?? ''}`.toLowerCase();
    const tokens = f.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.every((t) => hay.includes(t))) return false;
  }
  return true;
}

function whyItWorksLine(
  entry: CatalogEntry,
  profile: UserProfile,
  hemPos: HemPosition | null,
  palette: boolean,
): string {
  const bits: string[] = [];
  if (hemPos && profile.lengthPrefs.includes(hemPos)) {
    bits.push(`hits ${hemPos.replace('_', ' ')} on you — right where you like it`);
  } else if (hemPos) {
    bits.push(`falls ${hemPos.replace('_', ' ')} on your frame`);
  }
  if (palette && profile.colorSeason) {
    bits.push(`sits inside your ${SEASONS[profile.colorSeason].label} palette`);
  }
  const brandMatch = profile.brandSizes.find((b) => b.brand === entry.listing.brand);
  if (brandMatch) bits.push(`you already know your ${brandMatch.brand} size (${brandMatch.sizeLabel})`);
  if (entry.listing.measurements.length != null && bits.length < 2)
    bits.push('seller listed real measurements');
  if (bits.length === 0) bits.push('close to the styles you liked while swiping');
  const line = bits.slice(0, 2).join(', and ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

export async function mockRank(req: FeedRankRequest): Promise<RankResponse> {
  await delay(140);
  const profile = getProfile();
  const height = profile.heightInches ?? DEFAULT_HEIGHT_INCHES;
  const heel = profile.heelPrefInches;
  const boostEnabled = readLocal<boolean>(KEYS.paletteBoost, true);
  const dismissed = new Set(readLocal<string[]>(KEYS.paletteDismissedCards, []));
  const families = boostEnabled ? paletteFamilies(profile) : new Set<string>();

  const scored = CATALOG.map((entry) => {
    const hem = hemForUser(entry.listing, height, heel);
    return { entry, hem };
  })
    .filter(({ entry, hem }) => passesFilters(entry, req.filters, hem.position))
    .map(({ entry, hem }) => {
      const tagScore =
        Object.keys(profile.styleTags).length > 0
          ? 0.5 + 0.5 * cosine(profile.styleTags, entry.attributeVector)
          : 0.5;
      const palette =
        families.size > 0 && !dismissed.has(entry.listing.id) && matchesPalette(entry.listing, families);
      const decay = freshnessDecay(entry.listing);
      const measuredBoost = entry.listing.measurements.length != null ? 1.06 : 1;
      const score = Math.min(1, tagScore * (palette ? 1.2 : 1) * measuredBoost * decay);
      return { entry, hem, score, decay, palette };
    })
    .sort((a, b) => b.score - a.score || b.entry.listing.lastSeenAt - a.entry.listing.lastSeenAt);

  const offset = req.cursor ? parseInt(req.cursor, 10) || 0 : 0;
  const page = scored.slice(offset, offset + req.limit);

  const items: RankedListing[] = page.map(({ entry, hem, score, decay, palette }, i) => ({
    listing: entry.listing,
    hem,
    score,
    whyItWorks:
      req.personalize && offset === 0 && i < 10
        ? whyItWorksLine(entry, profile, hem.position, palette)
        : null,
    freshnessDecay: decay,
  }));

  return {
    items,
    nextCursor: offset + req.limit < scored.length ? String(offset + req.limit) : null,
    totalMatched: scored.length,
    rerank: { mode: 'deterministic', costUsd: null },
  };
}

/* ── listing detail ──────────────────────────────────────────────────────── */

export async function mockGetListing(id: string): Promise<ListingDetailResponse> {
  await delay(110);
  const entry = BY_ID.get(id);
  if (!entry) throw new MockApiError('not_found', 'This dress is no longer listed.');
  const profile = getProfile();
  const hem = hemForUser(entry.listing, profile.heightInches ?? DEFAULT_HEIGHT_INCHES, profile.heelPrefInches);
  const similar = CATALOG.filter((e) => e.listing.id !== id)
    .map((e) => ({ e, sim: cosine(entry.attributeVector, e.attributeVector) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 8)
    .map(({ e }) => e.listing);
  return { listing: entry.listing, hem, similar };
}

export class MockApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ── color analysis ──────────────────────────────────────────────────────── */

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function buildResult(season: ColorSeason, confidence: number, caveat: string | null): ColorAnalysisResult {
  const info = SEASONS[season];
  const cool = season.includes('winter') || season.includes('summer');
  const deep = season.startsWith('dark');
  const light = season.startsWith('light');
  const skinL = light ? 68 : deep ? 34 : 54;
  const warmth = cool ? -0.4 : 0.45;
  return {
    season,
    confidence,
    palette: info.palette,
    avoid: info.avoid,
    explanation: `Your skin reads ${cool ? 'cool' : 'warm'}-leaning (b* ${warmth > 0 ? '+' : ''}${Math.round(warmth * 20)}), with ${deep ? 'deep' : light ? 'light' : 'medium'} value and ${season.startsWith('bright') ? 'high' : season.startsWith('soft') ? 'gentle' : 'balanced'} contrast against your hair — the ${info.label} signature. ${info.tagline}.`,
    measured: {
      skin: { L: skinL, a: 12, b: cool ? 8 : 18, hex: cool ? '#E8C4B8' : '#E6B89C' },
      hair: { L: deep ? 18 : light ? 62 : 32, a: 6, b: cool ? 4 : 22, hex: deep ? '#2A211C' : '#6B4F3A' },
      eyes: { L: 28, a: 8, b: 14, hex: '#4A3728' },
      contrast: deep || season.startsWith('bright') ? 0.72 : 0.45,
      warmth,
      chroma: season.startsWith('bright') ? 0.7 : season.startsWith('soft') ? 0.3 : 0.5,
      sampleQuality: caveat ? 'poor' : 'good',
    },
    caveat,
  };
}

const SEASON_KEYS = Object.keys(SEASONS) as ColorSeason[];

export async function mockColorAnalysis(selfie: File): Promise<ColorAnalysisResult> {
  await delay(1400); // real analysis takes a beat — let the analyzing state breathe
  const h = hashString(`${selfie.name}:${selfie.size}`);
  const season = SEASON_KEYS[h % SEASON_KEYS.length];
  const caveat =
    h % 5 === 0
      ? 'Lighting made your undertone hard to read — the 60-second quiz can double-check this.'
      : null;
  return buildResult(season, caveat ? 0.62 : 0.86, caveat);
}

export async function mockColorAnalysisQuiz(
  req: ColorAnalysisQuizRequest,
): Promise<ColorAnalysisResult> {
  await delay(700);
  const a: QuizAnswers = req.answers;

  let warm = 0;
  if (a.veinColor === 'green') warm += 2;
  if (a.veinColor === 'blue_purple') warm -= 2;
  if (a.jewelryMetal === 'gold') warm += 1.5;
  if (a.jewelryMetal === 'silver') warm -= 1.5;
  if (a.whiteVsCream === 'cream') warm += 1;
  if (a.whiteVsCream === 'white') warm -= 1;
  if (a.sunReaction === 'tans_easily' || a.sunReaction === 'rarely_burns') warm += 0.5;
  if (a.sunReaction === 'burns_easily') warm -= 0.5;
  if (['red', 'auburn', 'strawberry_blonde'].includes(a.naturalHair)) warm += 1;

  const deepHair = ['black', 'dark_brown'].includes(a.naturalHair);
  const lightHair = ['blonde', 'strawberry_blonde', 'gray_white'].includes(a.naturalHair);
  const deepEyes = ['dark_brown', 'brown'].includes(a.eyeColor);
  const brightEyes = ['green', 'blue'].includes(a.eyeColor);
  const highContrast = deepHair && !deepEyes ? true : deepHair && brightEyes;

  let season: ColorSeason;
  if (warm > 0.5) {
    season = deepHair
      ? 'dark_autumn'
      : lightHair
        ? 'light_spring'
        : brightEyes
          ? 'bright_spring'
          : warm > 2
            ? 'true_autumn'
            : 'soft_autumn';
  } else if (warm < -0.5) {
    season = deepHair
      ? highContrast
        ? 'bright_winter'
        : 'dark_winter'
      : lightHair
        ? 'light_summer'
        : brightEyes
          ? 'true_summer'
          : 'soft_summer';
  } else {
    season = deepHair ? 'true_winter' : lightHair ? 'light_summer' : 'soft_summer';
  }

  return buildResult(season, 0.72, null);
}

export async function mockPutColorSeason(req: ColorAnalysisPut): Promise<UserProfile> {
  await delay(80);
  const p = getProfile();
  return saveProfile({ ...p, colorSeason: req.season, palette: SEASONS[req.season].palette });
}

/* ── meta ────────────────────────────────────────────────────────────────── */

export async function mockGetMetaFilters(): Promise<MetaFiltersResponse> {
  await delay(70);
  const brands = [...new Set(CATALOG.map((e) => e.listing.brand).filter((b): b is string => !!b))].sort();
  const colorFamilies = [...new Set(CATALOG.flatMap((e) => e.listing.colors.map((c) => c.family)))].sort();
  const prices = CATALOG.map((e) => e.listing.priceCents);
  return { brands, colorFamilies, priceRange: [Math.min(...prices), Math.max(...prices)] };
}

/* ── "find dresses like this" (no contract endpoint yet — friction note) ─── */

export interface SimilarSearchInput {
  /** live mode uploads the actual file (multipart `photo`); mock keys off the name */
  file?: File;
  fileName?: string;
  url?: string;
}
export interface SimilarSearchResult {
  inferred: { descriptor: string };
  results: RankResponse;
}

export async function mockSimilarSearch(input: SimilarSearchInput): Promise<SimilarSearchResult> {
  await delay(1600); // vision extraction takes a few seconds live (<8s p95 per spec)
  const profile = getProfile();
  const height = profile.heightInches ?? DEFAULT_HEIGHT_INCHES;

  // Deterministic "vision": seed an anchor listing from the input; if a
  // catalog URL was pasted, anchor to that exact dress.
  const byUrl = input.url ? CATALOG.find((e) => input.url!.includes(e.listing.sourceUrl)) : undefined;
  const anchor =
    byUrl ?? CATALOG[hashString(input.fileName ?? input.url ?? 'dress') % CATALOG.length];

  const ranked = CATALOG.filter((e) => e.listing.id !== anchor.listing.id)
    .map((e) => ({ e, sim: cosine(anchor.attributeVector, e.attributeVector) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 24);

  const items: RankedListing[] = ranked.map(({ e, sim }) => ({
    listing: e.listing,
    hem: hemForUser(e.listing, height, profile.heelPrefInches),
    score: sim,
    whyItWorks: null,
    freshnessDecay: freshnessDecay(e.listing),
  }));

  const colors = anchor.listing.colors.map((c) => c.name).slice(0, 2).join(' and ');
  const descriptor = [
    colors,
    anchor.listing.silhouette?.replace(/_/g, ' '),
    anchor.listing.lengthClass ? `${anchor.listing.lengthClass.replace(/_/g, ' ')} length` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    inferred: { descriptor },
    results: {
      items,
      nextCursor: null,
      totalMatched: items.length,
      rerank: { mode: 'deterministic', costUsd: null },
    },
  };
}
