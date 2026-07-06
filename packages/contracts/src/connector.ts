/**
 * Connector framework contracts — docs/ARCHITECTURE.md §4.2
 * Boundary: data-eng ⇄ backend-eng. FROZEN.
 */
import type { RawListing } from './listing';

export interface FetchContext {
  /** typed in packages/db; opaque here */
  db: unknown;
  etagCache: EtagCache;
  logger: Logger;
  /** true when required env keys are missing → connector must serve fixtures */
  mockMode: boolean;
}

export interface FetchResult {
  listings: RawListing[];
  stats: { fetched: number; errors: number };
  /** ids the source explicitly reported gone (optional; absence ≠ removal) */
  removedSourceListingIds?: string[];
}

export interface SourceConnector {
  /** matches sources.id */
  readonly id: string;
  /** 'ebay' | 'shopify' | 'fixture' | ... */
  readonly kind: string;
  /** cron expression; scheduler reads this. Shopify: max 1/day/store. */
  readonly defaultCadence: string;
  /** Are required credentials present? If false, framework runs it in mockMode. */
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  fetchListings(ctx: FetchContext): Promise<FetchResult>;
  /** Later: query-time re-verification. MVP connectors may return 'unsupported'. */
  verify?(sourceListingId: string): Promise<'active' | 'gone' | 'unsupported'>;
}

export interface EtagCache {
  get(url: string): Promise<{ etag?: string; lastModified?: string } | null>;
  set(url: string, v: { etag?: string; lastModified?: string }): Promise<void>;
}

export interface Logger {
  info(msg: string, meta?: object): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}
