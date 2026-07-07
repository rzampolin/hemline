/**
 * Thin typed API client for apps/web — every call typed with
 * @hemline/contracts request/response shapes (docs/ARCHITECTURE.md §4.7).
 *
 * NEXT_PUBLIC_API_MOCK=1 → client-side mock layer (lib/mock) with realistic
 * fixture-derived data. Unset → real fetches against app/api route handlers
 * (backend-eng). Flip the env var, nothing else changes.
 */
import type {
  ApiResponse,
  BrandSizesPut,
  ColorAnalysisPut,
  ColorAnalysisQuizRequest,
  ColorAnalysisResult,
  ListingDetailResponse,
  MetaFiltersResponse,
  ProfilePatch,
  RankedListing,
  SwipesPost,
  SwipesPostResponse,
  UserProfile,
} from '@hemline/contracts';
import {
  MockApiError,
  mockColorAnalysis,
  mockColorAnalysisQuiz,
  mockGetListing,
  mockGetMetaFilters,
  mockGetSession,
  mockPatchProfile,
  mockPostSwipes,
  mockPutBrandSizes,
  mockPutColorSeason,
  mockRank,
  mockSimilarSearch,
  type FeedRankRequest,
  type SimilarSearchInput,
  type SimilarSearchResult,
} from './mock/mock-api';
import { KEYS, readLocal, writeLocal } from './local';

export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MOCK === '1';

export { MockApiError as ApiError };
export type { FeedRankRequest, FeedFilters, SourceKindFilter } from './mock/mock-api';
export type { SimilarSearchInput, SimilarSearchResult } from './mock/mock-api';

/* ── live fetch helper (ApiResponse envelope per contracts) ──────────────── */

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  let body: ApiResponse<T>;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new MockApiError('bad_response', `Unexpected response from ${path} (${res.status})`);
  }
  if (!body.ok) throw new MockApiError(body.error.code, body.error.message);
  return body.data;
}

/* ── the client ──────────────────────────────────────────────────────────── */

export const api = {
  getSession(): Promise<UserProfile> {
    return MOCK_MODE ? mockGetSession() : http<UserProfile>('/api/session');
  },

  patchProfile(patch: ProfilePatch): Promise<UserProfile> {
    return MOCK_MODE
      ? mockPatchProfile(patch)
      : http<UserProfile>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) });
  },

  putBrandSizes(sizes: BrandSizesPut): Promise<UserProfile> {
    return MOCK_MODE
      ? mockPutBrandSizes(sizes)
      : http<UserProfile>('/api/profile/brand-sizes', { method: 'PUT', body: JSON.stringify(sizes) });
  },

  postSwipes(events: SwipesPost): Promise<SwipesPostResponse> {
    return MOCK_MODE
      ? mockPostSwipes(events)
      : http<SwipesPostResponse>('/api/swipes', { method: 'POST', body: JSON.stringify(events) });
  },

  /**
   * Feed + search + deck all go through rank. `filters.sources` is a mock-only
   * extension (HardFilters lacks a source facet — flagged to architect); the
   * live path strips it so requests stay contract-exact.
   */
  rank(req: FeedRankRequest) {
    if (MOCK_MODE) return mockRank(req);
    const { sources: _sources, ...filters } = req.filters;
    return http<import('@hemline/contracts').RankResponse>('/api/rank', {
      method: 'POST',
      body: JSON.stringify({ ...req, filters }),
    });
  },

  getListing(id: string): Promise<ListingDetailResponse> {
    return MOCK_MODE
      ? mockGetListing(id)
      : http<ListingDetailResponse>(`/api/listings/${encodeURIComponent(id)}`);
  },

  colorAnalysis(selfie: File): Promise<ColorAnalysisResult> {
    if (MOCK_MODE) return mockColorAnalysis(selfie);
    const form = new FormData();
    form.append('selfie', selfie);
    return http<ColorAnalysisResult>('/api/color-analysis', { method: 'POST', body: form });
  },

  colorAnalysisQuiz(req: ColorAnalysisQuizRequest): Promise<ColorAnalysisResult> {
    return MOCK_MODE
      ? mockColorAnalysisQuiz(req)
      : http<ColorAnalysisResult>('/api/color-analysis/quiz', {
          method: 'POST',
          body: JSON.stringify(req),
        });
  },

  putColorSeason(req: ColorAnalysisPut): Promise<UserProfile> {
    return MOCK_MODE
      ? mockPutColorSeason(req)
      : http<UserProfile>('/api/color-analysis', { method: 'PUT', body: JSON.stringify(req) });
  },

  getMetaFilters(): Promise<MetaFiltersResponse> {
    return MOCK_MODE ? mockGetMetaFilters() : http<MetaFiltersResponse>('/api/meta/filters');
  },

  /**
   * Saved items ("My Rack"). No GET endpoint exists in the contract (friction
   * note — F1 needs one); both modes hydrate saved ids kept client-side
   * through the detail endpoint, so this works identically live and mocked.
   */
  async getSaved(): Promise<RankedListing[]> {
    const ids = readLocal<string[]>(KEYS.saved, []);
    const results = await Promise.allSettled(ids.map((id) => api.getListing(id)));
    return results
      .filter((r): r is PromiseFulfilledResult<ListingDetailResponse> => r.status === 'fulfilled')
      .map((r) => ({
        listing: r.value.listing,
        hem: r.value.hem,
        score: 1,
        whyItWorks: null,
        freshnessDecay: 1,
      }));
  },

  /**
   * "Find dresses like this" (B4). No contract endpoint yet (friction note);
   * mocked with deterministic attribute similarity. Live mode falls back to a
   * keyword rank until the vision endpoint lands.
   */
  async similarSearch(input: SimilarSearchInput): Promise<SimilarSearchResult> {
    if (MOCK_MODE) return mockSimilarSearch(input);
    const results = await api.rank({
      userId: 'me',
      filters: input.url ? { query: input.url } : {},
      limit: 24,
      personalize: true,
    });
    return { inferred: { descriptor: 'similar dresses' }, results };
  },
};

/* ── saved ids (client-side, shared by both modes) ───────────────────────── */

export function getSavedIds(): string[] {
  return readLocal<string[]>(KEYS.saved, []);
}

export function setSavedIds(ids: string[]): void {
  writeLocal(KEYS.saved, ids);
}
