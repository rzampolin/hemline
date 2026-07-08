/**
 * Connector assembly + source selection shared by run.ts and schedule.ts.
 * Default set: fixtures + eBay (mock without keys) + every live-verified
 * Shopify store from stores.json + every live-verified JSON-LD store from
 * jsonld-stores.json. `--source` / `--store` narrow it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { SourceConnector } from '@hemline/contracts';
import {
  createJsonldConnector,
  createShopifyConnector,
  ebayConnector,
  findJsonldStore,
  findShopifyStore,
  fixturesConnector,
  verifiedJsonldStores,
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
  embed: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    source: get('source'),
    store: get('store'),
    watch: argv.includes('--watch'),
    extract: !argv.includes('--no-extract'),
    embed: !argv.includes('--no-embed'),
  };
}

export function buildConnectors(args: Pick<CliArgs, 'source' | 'store'>): SourceConnector[] {
  // --source=jsonld:domain → exactly that JSON-LD store (must be in jsonld-stores.json
  // — the connector needs its productUrlPattern; ad-hoc domains have none)
  if (args.source?.startsWith('jsonld:')) {
    const domain = args.source.slice('jsonld:'.length);
    const store = findJsonldStore(domain);
    if (!store) {
      throw new Error(`unknown JSON-LD store '${domain}' — add it to jsonld-stores.json first`);
    }
    return [createJsonldConnector(store)];
  }

  // --store=domain (or --source=shopify:domain) → exactly that store.
  // JSON-LD stores win when the domain is configured there (they are exactly
  // the stores the Shopify connector cannot crawl).
  const storeDomain =
    args.store ?? (args.source?.startsWith('shopify:') ? args.source.slice('shopify:'.length) : undefined);
  if (storeDomain) {
    if (!args.source?.startsWith('shopify:')) {
      const jsonldStore = findJsonldStore(storeDomain);
      if (jsonldStore) return [createJsonldConnector(jsonldStore)];
    }
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
    ...verifiedJsonldStores().map((s) => createJsonldConnector(s)),
  ];

  if (!args.source) return all;
  const wanted = args.source;
  const selected = all.filter((c) => c.id === wanted || c.kind === wanted);
  if (selected.length === 0) {
    throw new Error(
      `unknown --source=${wanted} (use fixtures | ebay | shopify | shopify:<domain> | jsonld | jsonld:<domain>)`,
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
