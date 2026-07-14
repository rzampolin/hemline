/**
 * Restore drill (ops, 2026-07-13) — proves the Litestream→Tigris backup
 * actually restores. Bundled to dist/restore-drill.mjs (Dockerfile launcher
 * pattern); the EM runs it in prod over fly ssh:
 *
 *   fly ssh console -C "node /app/dist/restore-drill.mjs"        # dry-run plan
 *   fly ssh console -C "node /app/dist/restore-drill.mjs --run"  # real drill
 *
 * What --run does:
 *   1. safety refusal (restore-drill-core): output must be under /tmp, never
 *      the live db — hard abort before anything else;
 *   2. disk-space guard: free space at /tmp vs live-db size + headroom;
 *   3. `litestream restore -config /etc/litestream.yml -o /tmp/restore-drill.db
 *      /data/hemline.db` — restores FROM the replica TO the temp path (the
 *      trailing arg only selects the replica config entry; the live file is
 *      never written);
 *   4. PRAGMA integrity_check on the restored copy;
 *   5. per-table row-count comparison vs the live db (opened READ-ONLY),
 *      with a small tolerance window for replica lag;
 *   6. prints a PASS/FAIL report and deletes the temp file (use --keep to
 *      inspect it — it still lives in /tmp and dies with the machine).
 *
 * Flags: --run --keep --output <path> --live <path> --config <path>
 *        --timestamp <ISO8601 (point-in-time, last 72h)> --tolerance <frac>
 *
 * Dry-run is the DEFAULT: without --run it prints the resolved plan, runs the
 * safety + disk checks, and exits without touching anything.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  assertSafeOutputPath,
  checkDiskSpace,
  compareCounts,
  formatReport,
  parseDrillArgs,
} from './restore-drill-core';

const LITESTREAM_BIN = process.env.LITESTREAM_BIN ?? '/usr/local/bin/litestream';

function die(msg: string): never {
  console.error(`[restore-drill] ${msg}`);
  process.exit(1);
}

function tableCounts(dbPath: string): Record<string, number> {
  // strictly read-only; fileMustExist so a typo'd path can't create a file
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare(
        `select name from sqlite_master
         where type = 'table' and name not like 'sqlite_%' and name not like '\\_litestream%' escape '\\'`,
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      counts[name] = (db.prepare(`select count(*) as c from "${name.replaceAll('"', '""')}"`).get() as { c: number }).c;
    }
    return counts;
  } finally {
    db.close();
  }
}

function integrityCheck(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check') as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join('; ');
  } finally {
    db.close();
  }
}

function rmQuiet(p: string): void {
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function main(): void {
  const args = parseDrillArgs(process.argv.slice(2), process.env);

  // ── 1. safety refusal — ALWAYS, before any other work ─────────────────
  let output: string;
  try {
    output = assertSafeOutputPath(args.output, args.live);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }

  if (!fs.existsSync(args.live)) die(`live db not found at ${args.live} (set --live or DATABASE_PATH)`);
  const liveBytes = fs.statSync(args.live).size;

  // ── 2. disk-space guard ───────────────────────────────────────────────
  const outDir = path.dirname(output);
  const sf = fs.statfsSync(outDir);
  const disk = checkDiskSpace(sf.bavail * sf.bsize, liveBytes);
  if (!disk.ok) {
    die(
      `not enough free space at ${outDir}: ${(disk.freeBytes / 1e6).toFixed(0)}MB free, ` +
        `need ~${(disk.requiredBytes / 1e6).toFixed(0)}MB (live db is ${(liveBytes / 1e6).toFixed(0)}MB)`,
    );
  }

  const restoreArgv = [
    'restore',
    '-config',
    args.config,
    ...(args.timestamp ? ['-timestamp', args.timestamp] : []),
    '-o',
    output,
    args.live, // selects the replica entry in litestream.yml — never written
  ];

  console.log('[restore-drill] plan:');
  console.log(`  live db (read-only): ${args.live} (${(liveBytes / 1e6).toFixed(1)}MB)`);
  console.log(`  restore to:          ${output}${args.keep ? ' (kept: --keep)' : ' (deleted afterwards)'}`);
  console.log(`  point in time:       ${args.timestamp ?? 'latest'}`);
  console.log(`  free space check:    ok (${(disk.freeBytes / 1e6).toFixed(0)}MB free ≥ ${(disk.requiredBytes / 1e6).toFixed(0)}MB needed)`);
  console.log(`  command:             ${LITESTREAM_BIN} ${restoreArgv.join(' ')}`);

  if (!args.run) {
    console.log('[restore-drill] DRY RUN (default) — nothing executed. Re-run with --run to perform the drill.');
    return;
  }

  if (!fs.existsSync(LITESTREAM_BIN)) die(`litestream binary missing at ${LITESTREAM_BIN}`);
  if (!fs.existsSync(args.config)) die(`litestream config missing at ${args.config}`);

  rmQuiet(output); // stale output from an aborted earlier drill

  // ── 3. restore from the replica to the temp path ──────────────────────
  const t0 = Date.now();
  const res = spawnSync(LITESTREAM_BIN, restoreArgv, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (res.status !== 0) {
    rmQuiet(output);
    die(`litestream restore failed (exit ${res.status ?? 'signal'}) — see output above`);
  }
  const restoreSeconds = (Date.now() - t0) / 1000;

  try {
    // ── 4 + 5. verify: integrity + row counts vs the live db ────────────
    const integrityResult = integrityCheck(output);
    const counts = compareCounts(tableCounts(args.live), tableCounts(output), args.tolerance);
    const report = formatReport({
      livePath: args.live,
      outputPath: output,
      liveDbBytes: liveBytes,
      integrityResult,
      counts,
      tolerance: args.tolerance,
      restoreSeconds,
    });
    console.log(report.text);
    process.exitCode = report.pass ? 0 : 1;
  } finally {
    // ── 6. cleanup ───────────────────────────────────────────────────────
    if (args.keep) console.log(`[restore-drill] kept restored copy at ${output} (--keep)`);
    else rmQuiet(output);
  }
}

main();
