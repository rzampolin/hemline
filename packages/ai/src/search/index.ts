/** Hybrid free-text search: stage-1 deterministic parse + stage-3 Haiku
 * enrichment (docs/decisions-search.md). Stage 2 (semantic embeddings) lives
 * in packages/matching + the web wiring — no LLM involved. */
export {
  parseQueryDeterministic,
  expandKnownBrand,
  COLOR_FAMILIES,
  type ParsedQuery,
  type ParsedQueryHard,
  type ParsedQuerySoft,
  type ParseQueryOptions,
  type QuerySignal,
  type QuerySignalKind,
} from './parse';
export {
  createQueryParser,
  queryParseCacheKey,
  InMemoryQueryParseCache,
  LlmQueryParseSchema,
  QUERY_PARSE_SYSTEM_PROMPT,
  QUERY_PARSE_TTL_MS,
  QUERY_PARSE_FAILURE_TTL_MS,
  QUERY_PARSE_TIMEOUT_MS,
  type CachedQueryParse,
  type LlmQueryParse,
  type QueryParseCacheStore,
  type QueryParseOutcome,
  type QueryParser,
  type QueryParserOptions,
} from './llm';
export { mergeQueryParse, type MergedQuery } from './merge';
