/**
 * Before/after demo for hybrid free-text search (docs/decisions-search.md).
 *
 * BEFORE = the legacy token-AND LIKE path (queryCandidates {query}).
 * AFTER  = the shipped hybrid path (rankForUser with interpretation on).
 *
 * Runs against a COPY of the prod db — never data/hemline.db itself:
 *   cp data/hemline.db /tmp/hemline-search-demo.db
 *   HEMLINE_ML_DIR=<repo>/ml npx tsx scripts/search-demo.ts /tmp/hemline-search-demo.db
 */
import { createDb, queryCandidates } from '@hemline/db';
import type { UserProfile } from '@hemline/contracts';
import { warmSharedEmbedder, sidecarStatus } from '@hemline/matching/embedder';
import { rankForUser } from '../apps/web/app/api/lib/matching';

const QUERIES = ['summer formal', 'pink', 'silk midi under $200'];

const GUEST: UserProfile = {
  id: 'guest',
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

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath || dbPath.includes('data/hemline.db')) {
    console.error('usage: tsx scripts/search-demo.ts <path-to-DB-COPY>  (never the live db)');
    process.exit(1);
  }
  const db = createDb({ dbPath });

  console.log(`db: ${dbPath}`);
  console.log(`sidecar: ${JSON.stringify(sidecarStatus())}`);
  if (sidecarStatus().state !== 'unavailable') {
    console.log('warming FashionSigLIP…');
    const ok = await warmSharedEmbedder();
    console.log(`warm: ${ok} → ${JSON.stringify(sidecarStatus())}`);
  }

  for (const q of QUERIES) {
    console.log(`\n━━━ "${q}" ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // BEFORE: token-AND LIKE over title/brand/description
    const before = queryCandidates(db, { query: q });
    console.log(`BEFORE (LIKE): ${before.length} matches`);
    before.slice(0, 5).forEach((c, i) =>
      console.log(`  ${i + 1}. ${c.listing.title}  [${c.listing.brand ?? '—'}]`),
    );

    // AFTER: hybrid interpretation
    const res = await rankForUser(
      db,
      GUEST,
      { query: q },
      {},
      { limit: 5, personalize: false },
    );
    const chips = res.interpreted
      ? res.interpreted.signals
          .map((s) => `${s.kind}:${s.value}${s.hard ? '*' : ''}`)
          .concat(res.interpreted.vibe.map((v) => `vibe:${v}`))
          .join(' ')
      : '';
    console.log(
      `AFTER (hybrid): ${res.totalMatched} matches | parser=${res.interpreted?.parser} semantic=${res.interpreted?.semantic}`,
    );
    console.log(`  interpreted: ${chips}  (*=hard filter)`);
    res.items.forEach((item, i) =>
      console.log(
        `  ${i + 1}. ${item.listing.title}  [${item.listing.brand ?? '—'}] $${(item.listing.priceCents / 100).toFixed(0)} score=${item.score.toFixed(3)}`,
      ),
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
