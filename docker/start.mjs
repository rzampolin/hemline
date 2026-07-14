/**
 * Production supervisor — the container's PID 1 (via `node docker/start.mjs`).
 *
 * Runs the long-lived processes in one container, because the SQLite file
 * lives on a single-machine Fly volume (single writer, docs/decisions-deploy.md):
 *   1. web        — Next standalone server  (apps/web/server.js)
 *   2. scheduler  — node-cron ingest loop   (dist/ingest-scheduler.mjs)
 *   3. litestream — continuous SQLite backup to S3-compatible storage
 *                   (only when the Tigris/S3 secrets are present; sidecar
 *                   replicating the live db — docs/decisions-deploy.md §7)
 *
 * Why a ~100-line hand-rolled supervisor instead of `concurrently`/pm2:
 *  - zero extra runtime dependencies in the image;
 *  - exact policy control: web death = container death (Fly restarts the
 *    machine → clean state), scheduler death = restart with capped backoff
 *    (a crashed crawler must never take the storefront down);
 *  - proper SIGTERM/SIGINT forwarding so `fly deploy` rotations and
 *    `docker stop` shut down WAL-checkpointed and clean.
 *
 * Env:
 *   INGEST_SCHEDULER=off      → no in-container ingest cron
 *   LITESTREAM_REPLICATE=off  → no backup child even when secrets are present
 *                               (used during restores — see DEPLOY.md)
 *   BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 *   AWS_ENDPOINT_URL_S3       → all four present = litestream child runs
 *   PORT / HOSTNAME           → passed through to the Next server (default 3000 / 0.0.0.0)
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SERVER = path.join(ROOT, 'apps', 'web', 'server.js');
const SCHEDULER = path.join(ROOT, 'dist', 'ingest-scheduler.mjs');

// ── privilege drop ──────────────────────────────────────────────────────────
// Fly mounts volumes root-owned, so the container starts as root ONLY to
// chown the data dir, then irreversibly drops to the unprivileged `node`
// user before anything else runs. (`docker run` bind mounts get the same
// treatment; already-non-root runs skip this block.)
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const dataDir = path.dirname(process.env.DATABASE_PATH ?? '/data/hemline.db');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    execFileSync('chown', ['-R', 'node:node', dataDir]);
  } catch (err) {
    console.warn(`[start] could not chown ${dataDir}: ${err.message}`);
  }
  process.env.HOME = '/home/node';
  process.initgroups('node', 'node');
  process.setgid('node');
  process.setuid('node');
  console.log(`[start] dropped privileges to node (data dir: ${dataDir})`);
}

// ── production env validation (same rules as apps/web/instrumentation.ts) ──
const PLACEHOLDER_SECRETS = new Set([
  'change-me-32-chars-minimum-random',
  'hemline-dev-secret-do-not-use-in-prod',
]);

if (process.env.NODE_ENV === 'production') {
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret || PLACEHOLDER_SECRETS.has(secret) || secret.length < 32) {
    console.error(
      '[start] FATAL: SESSION_SECRET missing/placeholder/too short (need >= 32 random chars).\n' +
        '[start]   generate: openssl rand -hex 32\n' +
        '[start]   set:      fly secrets set SESSION_SECRET=<value>',
    );
    process.exit(1);
  }
  if (!process.env.ADMIN_BASIC_AUTH) {
    console.warn('[start] ADMIN_BASIC_AUTH not set — /api/admin/* returns 401 for everyone');
  }
}

const children = new Map(); // name → ChildProcess
let shuttingDown = false;

// ── supervisor status file (ops, 2026-07-13) ────────────────────────────────
// /api/health reads this to self-diagnose "litestream child down" (and to
// surface child crash context) without the web process being able to see the
// supervisor's children directly. Written on every spawn/exit — tiny JSON,
// /tmp only. Honest limits (docs/decisions-ops.md): if the supervisor itself
// dies the file goes stale (but then the whole container restarts), and the
// file resets on every boot (/tmp is container-local).
// /tmp/litestream-alive is a second, dumber signal: touched on every
// litestream spawn/restart — the documented heartbeat fallback for health.
const STATUS_FILE = process.env.SUPERVISOR_STATUS_FILE ?? '/tmp/hemline-supervisor.json';
const LITESTREAM_HEARTBEAT = process.env.LITESTREAM_HEARTBEAT_FILE ?? '/tmp/litestream-alive';
const STDERR_TAIL_LINES = 20;
const childStatus = {}; // name → { up, pid, startedAt, restarts, lastExit, stderrTail }

function writeStatus() {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ updatedAt: Date.now(), children: childStatus }));
  } catch (err) {
    console.warn(`[start] could not write ${STATUS_FILE}: ${err.message}`);
  }
}

function prefix(name, stream, out, tail) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      out.write(`[${name}] ${line}\n`);
      if (tail) {
        tail.push(line);
        if (tail.length > STDERR_TAIL_LINES) tail.shift();
      }
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => {
    if (buf) out.write(`[${name}] ${buf}\n`);
  });
}

function launch(name, argv, { onExit }) {
  const [cmd, ...args] = argv;
  const child = spawn(cmd, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  const stderrTail = []; // last N stderr lines — crash context in the status file
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr, stderrTail);
  const prev = childStatus[name];
  childStatus[name] = {
    up: true,
    pid: child.pid,
    startedAt: Date.now(),
    restarts: prev ? (prev.restarts ?? 0) + 1 : 0,
    lastExit: prev?.lastExit ?? null,
  };
  writeStatus();
  if (name === 'litestream') {
    try {
      fs.writeFileSync(LITESTREAM_HEARTBEAT, String(Date.now()));
    } catch {
      /* heartbeat is best-effort */
    }
  }
  console.log(`[start] ${name} up (pid ${child.pid}) — ${argv.join(' ')}`);
  child.on('exit', (code, signal) => {
    children.delete(name);
    childStatus[name] = {
      ...childStatus[name],
      up: false,
      lastExit: { code: code ?? null, signal: signal ?? null, at: Date.now() },
      stderrTail: stderrTail.slice(),
    };
    writeStatus();
    if (!shuttingDown) onExit(code, signal);
  });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[start] ${signal} — stopping children`);
  for (const child of children.values()) child.kill('SIGTERM');
  // escalate if anything survives the grace window
  setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(0);
  }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── web: standalone Next server; its death is fatal ────────────────────────
launch('web', [process.execPath, WEB_SERVER], {
  onExit(code, signal) {
    console.error(`[start] web exited (code=${code} signal=${signal}) — stopping container`);
    shutdown('web-exit');
    process.exitCode = code ?? 1;
    setTimeout(() => process.exit(code ?? 1), 8500).unref();
  },
});

// ── scheduler: optional, restart with capped backoff ───────────────────────
if (process.env.INGEST_SCHEDULER === 'off') {
  console.log('[start] scheduler disabled (INGEST_SCHEDULER=off)');
} else if (!fs.existsSync(SCHEDULER)) {
  console.warn(`[start] scheduler bundle missing at ${SCHEDULER} — web only`);
} else {
  let backoffMs = 5_000;
  const startScheduler = () =>
    launch('scheduler', [process.execPath, SCHEDULER], {
      onExit(code, signal) {
        console.error(
          `[start] scheduler exited (code=${code} signal=${signal}) — restarting in ${backoffMs / 1000}s`,
        );
        setTimeout(() => {
          if (!shuttingDown) startScheduler();
        }, backoffMs).unref();
        backoffMs = Math.min(backoffMs * 2, 300_000); // cap at 5 min
      },
    });
  startScheduler();
}

// ── litestream: continuous SQLite backup, only when secrets exist ──────────
// Sidecar replicating the live db over its own read-only SQLite handle (safe
// with WAL) — NOT `litestream replicate -exec`, which would invert process
// ownership (docs/decisions-deploy.md §7). Death policy mirrors the
// scheduler: restart with capped backoff; a broken backup pipe must never
// take the storefront down (Fly volume snapshots still exist underneath).
const LITESTREAM_BIN = '/usr/local/bin/litestream';
const LITESTREAM_CONFIG = '/etc/litestream.yml';
const S3_VARS = ['BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3'];

if (process.env.LITESTREAM_REPLICATE === 'off') {
  console.log('[start] litestream disabled (LITESTREAM_REPLICATE=off)');
} else if (S3_VARS.some((v) => !process.env[v])) {
  console.log(
    `[start] litestream backup off — missing ${S3_VARS.filter((v) => !process.env[v]).join(', ')} (fly storage create + fly secrets set to enable; see DEPLOY.md)`,
  );
} else if (!fs.existsSync(LITESTREAM_BIN)) {
  console.warn(`[start] litestream binary missing at ${LITESTREAM_BIN} — backup off`);
} else {
  let lsBackoffMs = 5_000;
  const startLitestream = () =>
    launch('litestream', [LITESTREAM_BIN, 'replicate', '-config', LITESTREAM_CONFIG], {
      onExit(code, signal) {
        console.error(
          `[start] litestream exited (code=${code} signal=${signal}) — restarting in ${lsBackoffMs / 1000}s`,
        );
        setTimeout(() => {
          if (!shuttingDown) startLitestream();
        }, lsBackoffMs).unref();
        lsBackoffMs = Math.min(lsBackoffMs * 2, 300_000); // cap at 5 min
      },
    });
  startLitestream();
}
