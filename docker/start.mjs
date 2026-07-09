/**
 * Production supervisor — the container's PID 1 (via `node docker/start.mjs`).
 *
 * Runs BOTH long-lived processes in one container, because the SQLite file
 * lives on a single-machine Fly volume (single writer, docs/decisions-deploy.md):
 *   1. web       — Next standalone server  (apps/web/server.js)
 *   2. scheduler — node-cron ingest loop   (dist/ingest-scheduler.mjs)
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
 *   INGEST_SCHEDULER=off  → web only (e.g. a throwaway debug machine)
 *   PORT / HOSTNAME       → passed through to the Next server (default 3000 / 0.0.0.0)
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

function prefix(name, stream, out) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      out.write(`[${name}] ${buf.slice(0, nl)}\n`);
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => {
    if (buf) out.write(`[${name}] ${buf}\n`);
  });
}

function launch(name, script, { onExit }) {
  const child = spawn(process.execPath, [script], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  console.log(`[start] ${name} up (pid ${child.pid}) — ${path.relative(ROOT, script)}`);
  child.on('exit', (code, signal) => {
    children.delete(name);
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
launch('web', WEB_SERVER, {
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
    launch('scheduler', SCHEDULER, {
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
