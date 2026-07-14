/**
 * Restore-drill safety + verification logic (ops, 2026-07-13). The refusal
 * tests are load-bearing: the drill must be impossible to point at the live
 * database.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeOutputPath,
  checkDiskSpace,
  compareCounts,
  formatReport,
  parseDrillArgs,
  DEFAULT_OUTPUT,
  DEFAULT_LIVE_DB,
} from './restore-drill-core';

const LIVE = '/data/hemline.db';

describe('assertSafeOutputPath (hard refusal)', () => {
  it('accepts the default /tmp output', () => {
    expect(assertSafeOutputPath(DEFAULT_OUTPUT, LIVE)).toBe('/tmp/restore-drill.db');
  });

  it('accepts paths under the platform temp dir', () => {
    const p = path.join(os.tmpdir(), 'drill.db');
    expect(assertSafeOutputPath(p, LIVE)).toBe(path.resolve(p));
  });

  it('REFUSES the live db itself', () => {
    expect(() => assertSafeOutputPath('/data/hemline.db', LIVE)).toThrow(/REFUSED/);
  });

  it('REFUSES anything under /data', () => {
    expect(() => assertSafeOutputPath('/data/restore-drill.db', LIVE)).toThrow(/REFUSED.*\/data/);
    expect(() => assertSafeOutputPath('/data', LIVE)).toThrow(/REFUSED/);
  });

  it('REFUSES sneaky relative paths that resolve into /data', () => {
    expect(() => assertSafeOutputPath('/tmp/../data/hemline.db', LIVE)).toThrow(/REFUSED/);
  });

  it('REFUSES non-tmp locations generally', () => {
    expect(() => assertSafeOutputPath('/app/restore.db', LIVE)).toThrow(/REFUSED/);
    expect(() => assertSafeOutputPath('./restore.db', LIVE)).toThrow(/REFUSED/);
  });

  it('REFUSES the live WAL/SHM sidecars even when live is in /tmp (test rigs)', () => {
    expect(() => assertSafeOutputPath('/tmp/live.db', '/tmp/live.db')).toThrow(/REFUSED/);
    expect(() => assertSafeOutputPath('/tmp/live.db-wal', '/tmp/live.db')).toThrow(/REFUSED/);
    expect(() => assertSafeOutputPath('/tmp/live.db-shm', '/tmp/live.db')).toThrow(/REFUSED/);
  });
});

describe('checkDiskSpace', () => {
  it('requires live size + 20% + 64MiB flat headroom', () => {
    const liveBytes = 100 * 1024 * 1024;
    const { requiredBytes } = checkDiskSpace(0, liveBytes);
    expect(requiredBytes).toBe(Math.ceil(liveBytes * 1.2) + 64 * 1024 * 1024);
  });

  it('passes with room, fails without', () => {
    expect(checkDiskSpace(1e12, 12e6).ok).toBe(true);
    expect(checkDiskSpace(10e6, 12e6).ok).toBe(false);
  });
});

describe('compareCounts', () => {
  it('passes identical counts', () => {
    const res = compareCounts({ listings: 100, users: 5 }, { listings: 100, users: 5 });
    expect(res.pass).toBe(true);
  });

  it('tolerates small replica lag (max of % and 5-row floor)', () => {
    // 2% of 1000 = 20 allowed
    expect(compareCounts({ listings: 1000 }, { listings: 985 }).pass).toBe(true);
    expect(compareCounts({ listings: 1000 }, { listings: 970 }).pass).toBe(false);
    // small tables get the 5-row floor
    expect(compareCounts({ users: 3 }, { users: 1 }).pass).toBe(true);
    expect(compareCounts({ users: 3 }, { users: 9 }).pass).toBe(false);
  });

  it('fails on a table missing from the restored db', () => {
    const res = compareCounts({ listings: 10, users: 2 }, { listings: 10 });
    expect(res.pass).toBe(false);
    expect(res.tables.find((t) => t.table === 'users')).toMatchObject({ restored: -1, ok: false });
  });

  it('respects a custom tolerance', () => {
    expect(compareCounts({ listings: 1000 }, { listings: 910 }, 0.1).pass).toBe(true);
  });
});

describe('formatReport', () => {
  const base = {
    livePath: LIVE,
    outputPath: DEFAULT_OUTPUT,
    liveDbBytes: 12e6,
    tolerance: 0.02,
    restoreSeconds: 3.2,
  };

  it('PASS when integrity ok and counts pass', () => {
    const r = formatReport({
      ...base,
      integrityResult: 'ok',
      counts: compareCounts({ listings: 100 }, { listings: 100 }),
    });
    expect(r.pass).toBe(true);
    expect(r.text).toContain('RESULT: PASS');
    expect(r.text).toContain('integrity_check: ok');
  });

  it('FAIL on integrity corruption even with matching counts', () => {
    const r = formatReport({
      ...base,
      integrityResult: 'row 3 missing from index idx_x',
      counts: compareCounts({ listings: 100 }, { listings: 100 }),
    });
    expect(r.pass).toBe(false);
    expect(r.text).toContain('RESULT: FAIL');
  });

  it('FAIL on count drift beyond tolerance', () => {
    const r = formatReport({
      ...base,
      integrityResult: 'ok',
      counts: compareCounts({ listings: 100 }, { listings: 10 }),
    });
    expect(r.pass).toBe(false);
    expect(r.text).toContain('FAIL  listings');
  });
});

describe('parseDrillArgs (dry-run by default)', () => {
  it('defaults: dry run, /tmp output, env-driven live path', () => {
    const args = parseDrillArgs([], { DATABASE_PATH: '/data/hemline.db' });
    expect(args.run).toBe(false);
    expect(args.output).toBe(DEFAULT_OUTPUT);
    expect(args.live).toBe(DEFAULT_LIVE_DB);
    expect(args.config).toBe('/etc/litestream.yml');
    expect(args.timestamp).toBeNull();
  });

  it('parses flags', () => {
    const args = parseDrillArgs(
      ['--run', '--keep', '--output', '/tmp/x.db', '--timestamp', '2026-07-12T00:00:00Z', '--tolerance', '0.05'],
      {},
    );
    expect(args).toMatchObject({
      run: true,
      keep: true,
      output: '/tmp/x.db',
      timestamp: '2026-07-12T00:00:00Z',
      tolerance: 0.05,
    });
  });

  it('rejects unknown flags and bad tolerance', () => {
    expect(() => parseDrillArgs(['--force'], {})).toThrow(/unknown flag/);
    expect(() => parseDrillArgs(['--tolerance', '2'], {})).toThrow(/tolerance/);
    expect(() => parseDrillArgs(['--output'], {})).toThrow(/requires a value/);
  });
});
