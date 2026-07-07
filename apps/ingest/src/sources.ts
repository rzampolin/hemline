/**
 * Connector assembly + source selection shared by run.ts and schedule.ts.
 * Default set: fixtures + eBay (mock without keys) + every live-verified
 * Shopify store from stores.json. `--source` / `--store` narrow it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { SourceConnector } from '@hemline/contracts';
import {
  createShopifyConnector,
  ebayConnector,
  findShopifyStore,
  fixturesConnector,
  verifiedShopifyStores,
} from '@hemline/connectors';
import { createDb, sources, type Db } from '@hemline/db';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..');

/** Resolve the db path relative to the repo root (script-cwd independent). */
export function openDb(): Db {
  const dbPath = process.env.DATABASE_PATH
    ? path.resolve(REPO_ROOT, process.env.DATABASE_PATH)
    : path.join(REPO_ROOT, 'data', 'hemline.db');
  return createDb({ dbPath });
}

export interface CliArgs {
  source?: string;
  store?: string;
  watch: boolean;
  extract: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    source: get('source'),
    store: get('store'),
    watch: argv.includes('--watch'),
    extract: !argv.includes('--no-extract'),
  };
}

export function buildConnectors(args: Pick<CliArgs, 'source' | 'store'>): SourceConnector[] {
  // --store=domain (or --source=shopify:domain) → exactly that store
  const storeDomain =
    args.store ?? (args.source?.startsWith('shopify:') ? args.source.slice('shopify:'.length) : undefined);
  if (storeDomain) {
    const store = findShopifyStore(storeDomain) ?? {
      domain: storeDomain,
      displayName: storeDomain,
      verified: false,
    };
    return [createShopifyConnector(store)];
  }

  const all: SourceConnector[] = [
    fixturesConnector,
    ebayConnector,
    ...verifiedShopifyStores().map((s) => createShopifyConnector(s)),
  ];

  if (!args.source) return all;
  const wanted = args.source;
  const selected = all.filter((c) => c.id === wanted || c.kind === wanted);
  if (selected.length === 0) {
    throw new Error(
      `unknown --source=${wanted} (use fixtures | ebay | shopify | shopify:<domain>)`,
    );
  }
  return selected;
}

/** sources.enabled=0 (admin toggle, product spec G3) wins over the CLI. */
export function isSourceEnabled(db: Db, sourceId: string): boolean {
  const row = db
    .select({ enabled: sources.enabled })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .get();
  return row?.enabled !== false;
}

/** Per-source cadence: sources.cadence_cron override, else connector default. */
export function cadenceFor(db: Db, connector: SourceConnector): string {
  const row = db
    .select({ cadence: sources.cadenceCron })
    .from(sources)
    .where(eq(sources.id, connector.id))
    .get();
  return row?.cadence ?? connector.defaultCadence;
}
