/**
 * 20-query search-parse eval (docs/decisions-search.md).
 *
 * Always prints the deterministic (stage 1) parse table. When
 * ANTHROPIC_API_KEY is set, ALSO runs each query through the live Haiku
 * parser ONCE (fresh in-memory cache; ~$0.02 total), asserting only
 * SCHEMA-validity live — semantic quality is reported, not asserted.
 *
 *   npx tsx scripts/search-eval.ts                  # deterministic only
 *   node --env-file=.env --import tsx scripts/search-eval.ts   # + live Haiku
 */
import {
  createAiClient,
  createQueryParser,
  InMemoryQueryParseCache,
  mergeQueryParse,
  parseQueryDeterministic,
  type ParsedQuery,
} from '@hemline/ai';

const EVAL_QUERIES = [
  'summer formal',
  'petite wedding guest dress',
  'black midi under $150',
  'silk slip',
  'cottagecore',
  'something for a work event',
  'blush maxi size 12',
  'STAUD mini',
  'pink',
  'red wrap dress under 100 dollars',
  'linen midi dress for vacation',
  'floral maxi',
  'cocktail dress size 8',
  '$100-$200 wedding guest',
  'navy bodycon mini',
  'elegant evening gown',
  'reformation silk dress',
  'square neck linen dress',
  'casual brunch dress',
  'vintage 90s slip dress in emerald',
];

/** Representative catalog brand labels (same shapes as prod). */
const KNOWN_BRANDS = ['STAUD', 'STAUD FALL 2025', 'Reformation', 'Christy Dawn', 'Sister Jane Exclusives'];

function fmtHard(h: ParsedQuery['hard']): string {
  const parts: string[] = [];
  if (h.priceMinCents != null) parts.push(`min$${h.priceMinCents / 100}`);
  if (h.priceMaxCents != null) parts.push(`max$${h.priceMaxCents / 100}`);
  if (h.sizesNormalized?.length) parts.push(`size:${h.sizesNormalized.join('/')}`);
  if (h.lengthClasses?.length) parts.push(`len:${h.lengthClasses.join('/')}`);
  if (h.brands?.length) parts.push(`brand×${h.brands.length}`);
  return parts.join(' ') || '—';
}

function fmtSoft(s: ParsedQuery['soft']): string {
  const parts: string[] = [];
  if (s.occasions.length) parts.push(`occ:${s.occasions.join('/')}`);
  if (s.colorFamilies.length) parts.push(`color:${s.colorFamilies.join('/')}`);
  if (s.fabrics.length) parts.push(`fab:${s.fabrics.join('/')}`);
  if (s.silhouettes.length) parts.push(`sil:${s.silhouettes.join('/')}`);
  if (s.necklines.length) parts.push(`neck:${s.necklines.join('/')}`);
  if (s.patterns.length) parts.push(`pat:${s.patterns.join('/')}`);
  return parts.join(' ') || '—';
}

async function main() {
  const client = createAiClient();
  const live = client.effectiveMode() === 'live';
  const parser = live
    ? createQueryParser({ client, cache: new InMemoryQueryParseCache() })
    : null;
  console.log(`mode: ${live ? 'deterministic + LIVE Haiku' : 'deterministic only (no key)'}\n`);

  const deadlineMisses: string[] = [];
  let schemaFailures = 0;
  const report = (q: string, stage1: ParsedQuery, outcome: Awaited<ReturnType<NonNullable<typeof parser>>>) => {
    if (!outcome) return false;
    const merged = mergeQueryParse(stage1, outcome.parse, { knownBrands: KNOWN_BRANDS });
    console.log(
      `   haiku   ✓ hard[${fmtHard(merged.hard)}] soft[${fmtSoft(merged.soft)}] vibe["${merged.vibeText ?? ''}"] ($${outcome.costUsd?.toFixed(4)})`,
    );
    return true;
  };

  for (const q of EVAL_QUERIES) {
    const stage1 = parseQueryDeterministic(q, { knownBrands: KNOWN_BRANDS });
    console.log(`▶ "${q}"`);
    console.log(`   stage1  hard[${fmtHard(stage1.hard)}] soft[${fmtSoft(stage1.soft)}] residual[${stage1.residualTokens.join(', ') || '—'}]`);
    if (parser && !report(q, stage1, await parser(q))) {
      deadlineMisses.push(q);
      console.log('   haiku   … missed the 2.5s request deadline (fill continues in background)');
    }
  }

  // Deadline misses served stage-1 in production; the background fill keeps
  // going and caches. Re-check them once — anything STILL failing is a real
  // schema/API failure (negative-cached), which is the only live assertion.
  if (parser && deadlineMisses.length > 0) {
    console.log(`\nre-checking ${deadlineMisses.length} deadline miss(es) after the background fill…`);
    await new Promise((r) => setTimeout(r, 10_000));
    for (const q of deadlineMisses) {
      const stage1 = parseQueryDeterministic(q, { knownBrands: KNOWN_BRANDS });
      console.log(`▶ "${q}" (retry)`);
      if (!report(q, stage1, await parser(q))) {
        schemaFailures++;
        console.log('   haiku   ✗ FAILED (schema-invalid / API error — negative-cached)');
      }
    }
  }

  if (live) {
    console.log(`\nlive schema validity: ${EVAL_QUERIES.length - schemaFailures}/${EVAL_QUERIES.length}`);
    console.log(`total live cost: $${client.meter.totalUsd().toFixed(4)}`);
    if (schemaFailures > 0) process.exit(1); // schema validity is the only live assertion
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
