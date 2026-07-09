/**
 * Production seed entrypoint — bundled by the Dockerfile into
 * /app/dist/seed.mjs so a fresh EMPTY volume can be populated without tsx or
 * devDependencies:
 *
 *   fly ssh console -C "node /app/dist/seed.mjs"
 *
 * Creates the schema (idempotent) then loads the fixture corpus + demo user.
 * NOT run automatically: production normally receives the founder's real
 * data/hemline.db via sftp (DEPLOY.md) — this exists so an empty volume still
 * yields a demo-able app.
 */
import { createDb, ensureSchema, resolveDbPath, runSeed } from '@hemline/db';

const dbPath = resolveDbPath();
console.log(`[seed] target db: ${dbPath}`);
ensureSchema(createDb({ dbPath }));
const { listingCount } = runSeed(dbPath);
console.log(`[seed] done — ${listingCount} fixture listings loaded`);
