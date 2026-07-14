/**
 * Ops bundle (2026-07-13): error capture wiring (envelope + onRequestError),
 * /api/admin/errors, and the /api/health `errors` + `alerts` additions.
 *
 * Own temp db (never the seeded corpus) — these tests mutate app_errors and
 * ingest_runs, and flip health-related env vars, so isolation matters.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appErrors, createDb, ensureSchema, ingestRuns, sources, type Db } from '@hemline/db';
import { __resetDbCache } from '../lib/db';
import { serverError } from '../lib/envelope';
import { captureRequestError } from '../../../instrumentation-node';
import { GET as healthGET } from '../health/route';
import { GET as adminErrorsGET } from '../admin/errors/route';

let tmpDir: string;
let db: Db;
let prevDbPath: string | undefined;

const HEALTH_ENV = [
  'ADMIN_BASIC_AUTH',
  'HEALTH_ERROR_SPIKE_THRESHOLD',
  'HEALTH_INGEST_STALE_HOURS',
  'BUCKET_NAME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ENDPOINT_URL_S3',
  'LITESTREAM_REPLICATE',
  'SUPERVISOR_STATUS_FILE',
  'LITESTREAM_HEARTBEAT_FILE',
  'HEMLINE_ML_EAGER',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-ops-test-'));
  const dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  prevDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;
  __resetDbCache();
  for (const k of HEALTH_ENV) savedEnv[k] = process.env[k];
});

afterAll(() => {
  if (prevDbPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = prevDbPath;
  __resetDbCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const k of HEALTH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function healthData() {
  const res = await healthGET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: any };
  expect(body.ok).toBe(true);
  return body.data;
}

describe('error capture wiring', () => {
  it('serverError records a deduped app_errors row and still returns the 500 envelope', async () => {
    const boom = new Error('capture me 42');
    const res1 = serverError('ops-test', boom);
    const res2 = serverError('ops-test', new Error('capture me 43')); // digits normalized → same group
    expect(res1.status).toBe(500);
    const body = (await res1.json()) as { ok: boolean; error: { code: string } };
    expect(body).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    void res2;

    const rows = db.select().from(appErrors).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('api:ops-test');
    expect(rows[0].count).toBe(2);
    expect(rows[0].stack).toContain('Error: capture me');
  });

  it('captureRequestError (instrumentation onRequestError body) records with route context', () => {
    captureRequestError(
      new Error('uncaught render explosion'),
      { path: '/dress/abc', method: 'GET' },
      { routerKind: 'App Router', routePath: '/dress/[id]', routeType: 'render' },
    );
    const row = db
      .select()
      .from(appErrors)
      .all()
      .find((r) => r.route.startsWith('onRequestError:'));
    expect(row).toBeDefined();
    expect(row!.route).toBe('onRequestError:/dress/[id] (GET render)');
    expect(row!.message).toBe('uncaught render explosion');
  });
});

describe('GET /api/admin/errors', () => {
  it('requires basic auth when ADMIN_BASIC_AUTH is set', async () => {
    process.env.ADMIN_BASIC_AUTH = 'admin:pw';
    const res = await adminErrorsGET(new Request('http://test/api/admin/errors'));
    expect(res.status).toBe(401);
  });

  it('returns grouped errors + stats with valid auth', async () => {
    process.env.ADMIN_BASIC_AUTH = 'admin:pw';
    const res = await adminErrorsGET(
      new Request('http://test/api/admin/errors?limit=10', {
        headers: { authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: any };
    expect(body.ok).toBe(true);
    expect(body.data.stats.groups).toBeGreaterThanOrEqual(2);
    const group = body.data.errors.find((e: any) => e.route === 'api:ops-test');
    expect(group).toMatchObject({ count: 2 });
    expect(group.stackHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GET /api/health — errors + alerts (additive)', () => {
  it('reports error counts and an empty alerts array in a quiet system', async () => {
    const data = await healthData();
    expect(data.status).toBe('ok');
    expect(data.db.reachable).toBe(true);
    expect(data.errors.groups).toBeGreaterThanOrEqual(2); // from the capture tests above
    expect(typeof data.errors.lastHour).toBe('number');
    // no S3 secrets, no eager ML, fresh-enough ingest state → nothing to flag
    expect(data.alerts).toEqual([]);
  });

  it('flags an error spike when lastHour crosses the threshold', async () => {
    process.env.HEALTH_ERROR_SPIKE_THRESHOLD = '1';
    const data = await healthData();
    const spike = data.alerts.find((a: any) => a.code === 'error_spike');
    expect(spike).toBeDefined();
    expect(spike.message).toContain('threshold 1');
  });

  it('flags stale ingest (> 36h since the last run started)', async () => {
    db.insert(sources)
      .values({ id: 'fixture:ops', kind: 'fixture', displayName: 'Ops', cadenceCron: '0 6 * * *' })
      .run();
    db.insert(ingestRuns)
      .values({
        sourceId: 'fixture:ops',
        startedAt: Date.now() - 40 * 3_600_000,
        finishedAt: Date.now() - 40 * 3_600_000 + 60_000,
        status: 'ok',
      })
      .run();
    const data = await healthData();
    expect(data.lastIngest.sourceId).toBe('fixture:ops');
    const stale = data.alerts.find((a: any) => a.code === 'ingest_stale');
    expect(stale).toBeDefined();
    expect(stale.message).toMatch(/40h ago/);

    // a fresh run clears it
    db.insert(ingestRuns)
      .values({ sourceId: 'fixture:ops', startedAt: Date.now(), status: 'ok' })
      .run();
    const fresh = await healthData();
    expect(fresh.alerts.find((a: any) => a.code === 'ingest_stale')).toBeUndefined();
  });

  it('flags litestream down from the supervisor status file when backups are expected', async () => {
    process.env.BUCKET_NAME = 'test-bucket';
    process.env.AWS_ACCESS_KEY_ID = 'tid_x';
    process.env.AWS_SECRET_ACCESS_KEY = 'tsec_x';
    process.env.AWS_ENDPOINT_URL_S3 = 'https://example.test';
    const statusPath = path.join(tmpDir, 'supervisor.json');
    process.env.SUPERVISOR_STATUS_FILE = statusPath;

    // child down → alert
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: Date.now(),
        children: { litestream: { up: false, lastExit: { code: 1, signal: null, at: Date.now() } } },
      }),
    );
    let data = await healthData();
    expect(data.alerts.find((a: any) => a.code === 'litestream_down')).toBeDefined();

    // child up → no alert
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ updatedAt: Date.now(), children: { litestream: { up: true } } }),
    );
    data = await healthData();
    expect(data.alerts.find((a: any) => a.code === 'litestream_down')).toBeUndefined();

    // no status file → heartbeat fallback decides
    fs.rmSync(statusPath);
    process.env.LITESTREAM_HEARTBEAT_FILE = path.join(tmpDir, 'litestream-alive');
    data = await healthData();
    expect(data.alerts.find((a: any) => a.code === 'litestream_down')).toBeDefined();
    fs.writeFileSync(path.join(tmpDir, 'litestream-alive'), String(Date.now()));
    data = await healthData();
    expect(data.alerts.find((a: any) => a.code === 'litestream_down')).toBeUndefined();
  });

  it('never alerts about litestream when the backup is intentionally off', async () => {
    process.env.BUCKET_NAME = 'test-bucket';
    process.env.AWS_ACCESS_KEY_ID = 'tid_x';
    process.env.AWS_SECRET_ACCESS_KEY = 'tsec_x';
    process.env.AWS_ENDPOINT_URL_S3 = 'https://example.test';
    process.env.LITESTREAM_REPLICATE = 'off'; // restore runbook state
    const data = await healthData();
    expect(data.alerts.find((a: any) => a.code === 'litestream_down')).toBeUndefined();
  });
});
