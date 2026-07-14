/**
 * Restore-drill pure logic (ops, 2026-07-13) — the testable half of
 * docker/restore-drill.ts: output-path safety refusal, disk-space guard,
 * row-count comparison, and the PASS/FAIL report. No fs/child_process here;
 * the entrypoint owns all side effects.
 *
 * SAFETY CONTRACT (hard): a drill may only ever WRITE under the OS temp dir.
 * The live database path is opened strictly read-only by the entrypoint and
 * is never a legal output destination — assertSafeOutputPath throws before
 * any restore starts.
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_OUTPUT = '/tmp/restore-drill.db';
export const DEFAULT_LIVE_DB = '/data/hemline.db';
export const DEFAULT_TOLERANCE = 0.02;

/** free space required: restored file ≈ live size, plus WAL headroom + slack */
const HEADROOM_FACTOR = 1.2;
const HEADROOM_FLAT_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Refuse any output path that could touch the live database. Rules, in
 * order:
 *  1. output must live under /tmp (or the platform temp dir — same thing in
 *     the prod container; keeps local/macOS drills possible);
 *  2. output must never be under /data (belt and braces — rule 1 already
 *     excludes it, but the refusal must survive refactors);
 *  3. output must not equal the live db or its -wal/-shm sidecars.
 * Returns the resolved absolute output path.
 */
export function assertSafeOutputPath(outputPath: string, liveDbPath: string): string {
  const out = path.resolve(outputPath);
  const live = path.resolve(liveDbPath);
  const tmpPrefixes = ['/tmp' + path.sep, path.resolve(os.tmpdir()) + path.sep];
  if (out.startsWith('/data' + path.sep) || out === '/data') {
    throw new Error(`REFUSED: output ${out} is under /data — restore drills never write near the live db`);
  }
  if (!tmpPrefixes.some((p) => out.startsWith(p))) {
    throw new Error(
      `REFUSED: output ${out} is outside the temp dir — drills only write under /tmp (got prefixes ${tmpPrefixes.join(', ')})`,
    );
  }
  if (out === live || out === `${live}-wal` || out === `${live}-shm`) {
    throw new Error(`REFUSED: output ${out} IS the live database (or its WAL/SHM) — aborting`);
  }
  return out;
}

export interface DiskCheck {
  ok: boolean;
  freeBytes: number;
  requiredBytes: number;
}

/** Guard: enough free space at the output location for the restored copy. */
export function checkDiskSpace(freeBytes: number, liveDbBytes: number): DiskCheck {
  const requiredBytes = Math.ceil(liveDbBytes * HEADROOM_FACTOR) + HEADROOM_FLAT_BYTES;
  return { ok: freeBytes >= requiredBytes, freeBytes, requiredBytes };
}

export interface TableComparison {
  table: string;
  live: number;
  /** -1 = table missing from the restored db */
  restored: number;
  ok: boolean;
}

export interface CountComparison {
  tables: TableComparison[];
  pass: boolean;
}

/**
 * Compare per-table row counts, live vs restored. The replica legitimately
 * lags the live db (10s sync interval + whatever wrote during the drill), so
 * each table gets a tolerance window: |restored − live| ≤
 * max(ceil(live × tolerance), 5). A table missing from the restored db is an
 * automatic failure.
 */
export function compareCounts(
  live: Record<string, number>,
  restored: Record<string, number>,
  tolerance: number = DEFAULT_TOLERANCE,
): CountComparison {
  const tables = Object.keys(live)
    .sort()
    .map((table) => {
      const l = live[table];
      const r = restored[table];
      if (r === undefined) return { table, live: l, restored: -1, ok: false };
      const allowed = Math.max(Math.ceil(l * tolerance), 5);
      return { table, live: l, restored: r, ok: Math.abs(r - l) <= allowed };
    });
  return { tables, pass: tables.every((t) => t.ok) };
}

export interface DrillReportInput {
  livePath: string;
  outputPath: string;
  liveDbBytes: number;
  integrityResult: string;
  counts: CountComparison;
  tolerance: number;
  restoreSeconds: number;
}

/** Human-readable PASS/FAIL report for the EM's terminal (and fly logs). */
export function formatReport(r: DrillReportInput): { pass: boolean; text: string } {
  const integrityOk = r.integrityResult.trim().toLowerCase() === 'ok';
  const pass = integrityOk && r.counts.pass;
  const lines: string[] = [];
  lines.push('=== Hemline restore drill report ===');
  lines.push(`live db:      ${r.livePath} (${(r.liveDbBytes / 1024 / 1024).toFixed(1)} MiB, opened read-only)`);
  lines.push(`restored to:  ${r.outputPath} (deleted after the drill)`);
  lines.push(`restore took: ${r.restoreSeconds.toFixed(1)}s`);
  lines.push(`integrity_check: ${integrityOk ? 'ok' : `FAILED — ${r.integrityResult.slice(0, 300)}`}`);
  lines.push(`row counts (tolerance ±max(${(r.tolerance * 100).toFixed(1)}%, 5 rows) — replica lags up to ~10s):`);
  const w = Math.max(...r.counts.tables.map((t) => t.table.length), 5);
  for (const t of r.counts.tables) {
    const restored = t.restored === -1 ? 'MISSING' : String(t.restored);
    lines.push(
      `  ${t.ok ? 'ok  ' : 'FAIL'}  ${t.table.padEnd(w)}  live=${String(t.live).padStart(8)}  restored=${restored.padStart(8)}`,
    );
  }
  lines.push(pass ? 'RESULT: PASS — the replica restores to a healthy, current database' : 'RESULT: FAIL — investigate before trusting the backup');
  return { pass, text: lines.join('\n') };
}

export interface DrillArgs {
  run: boolean;
  keep: boolean;
  output: string;
  live: string;
  config: string;
  timestamp: string | null;
  tolerance: number;
}

/** argv parser (exported for tests). Unknown flags throw — fail loud in prod. */
export function parseDrillArgs(
  argv: string[],
  env: Record<string, string | undefined> = {},
): DrillArgs {
  const args: DrillArgs = {
    run: false,
    keep: false,
    output: DEFAULT_OUTPUT,
    live: env.DATABASE_PATH ?? DEFAULT_LIVE_DB,
    config: env.LITESTREAM_CONFIG ?? '/etc/litestream.yml',
    timestamp: null,
    tolerance: DEFAULT_TOLERANCE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--run':
        args.run = true;
        break;
      case '--keep':
        args.keep = true;
        break;
      case '--output':
        args.output = next();
        break;
      case '--live':
        args.live = next();
        break;
      case '--config':
        args.config = next();
        break;
      case '--timestamp':
        args.timestamp = next();
        break;
      case '--tolerance': {
        const t = Number(next());
        if (!Number.isFinite(t) || t < 0 || t >= 1) throw new Error('--tolerance must be a fraction in [0, 1)');
        args.tolerance = t;
        break;
      }
      default:
        throw new Error(`unknown flag ${a} (known: --run --keep --output --live --config --timestamp --tolerance)`);
    }
  }
  return args;
}
