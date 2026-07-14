/**
 * Scheduler heartbeat (docs/decisions-scheduler.md #5) — the observability the
 * 2026-07-10 outage lacked: the scheduler proves it is alive independently of
 * whether any job produced an ingest_runs row.
 *
 * Mechanism mirrors the ops-bundle litestream heartbeat (a tiny /tmp JSON file
 * rather than a table: the web process reads it in-container with zero DB
 * coupling, and a stale file after a container restart is impossible because
 * /tmp resets with the container). Written every HEARTBEAT_INTERVAL and on
 * every executed tick. /api/health raises `scheduler_dead` when the file is
 * older than ~30min.
 *
 * Also logs a per-day summary line ("N scheduled tick(s) executed on <date>")
 * at the first beat after a UTC date rollover, so a silent-cron failure is
 * diagnosable from logs alone next time.
 */
import fs from 'node:fs';
import type { Logger } from '@hemline/contracts';
import { consoleLogger } from './pipeline';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export function heartbeatFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCHEDULER_HEARTBEAT_FILE ?? '/tmp/hemline-scheduler-heartbeat.json';
}

export interface SchedulerHeartbeatState {
  /** last write, epoch ms — the liveness signal /api/health checks */
  updatedAt: number;
  startedAt: number;
  pid: number;
  /** UTC day the counters cover, YYYY-MM-DD */
  date: string;
  /** executed (not merely enqueued) ticks today, per job id */
  ticksToday: Record<string, number>;
}

export interface SchedulerHeartbeat {
  start(): void;
  stop(): void;
  /** count an executed tick (called from the chain body) + beat immediately */
  recordTick(jobId: string): void;
  /** write the file now (also called on the interval) */
  beat(): void;
  /** current in-memory state (tests) */
  state(): SchedulerHeartbeatState;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function createSchedulerHeartbeat(
  opts: {
    file?: string;
    intervalMs?: number;
    logger?: Logger;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
  } = {},
): SchedulerHeartbeat {
  const file = opts.file ?? heartbeatFilePath(opts.env);
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const logger = opts.logger ?? consoleLogger;
  const now = opts.now ?? Date.now;

  const startedAt = now();
  let date = utcDay(startedAt);
  let ticksToday: Record<string, number> = {};
  let timer: NodeJS.Timeout | null = null;

  function rolloverIfNeeded(): void {
    const today = utcDay(now());
    if (today === date) return;
    const total = Object.values(ticksToday).reduce((a, b) => a + b, 0);
    const byJob = Object.entries(ticksToday)
      .map(([id, n]) => `${id}=${n}`)
      .join(', ');
    logger.info(
      `[ingest:watch] daily summary ${date}: ${total} scheduled tick(s) executed${byJob ? ` (${byJob})` : ''}`,
    );
    date = today;
    ticksToday = {};
  }

  function state(): SchedulerHeartbeatState {
    return { updatedAt: now(), startedAt, pid: process.pid, date, ticksToday };
  }

  function beat(): void {
    rolloverIfNeeded();
    try {
      fs.writeFileSync(file, JSON.stringify(state()));
    } catch (e) {
      // observability must never break the scheduler
      logger.warn(`[ingest:watch] could not write heartbeat ${file}:`, e);
    }
  }

  return {
    start() {
      beat();
      timer = setInterval(beat, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    recordTick(jobId) {
      rolloverIfNeeded();
      ticksToday[jobId] = (ticksToday[jobId] ?? 0) + 1;
      beat();
    },
    beat,
    state,
  };
}
