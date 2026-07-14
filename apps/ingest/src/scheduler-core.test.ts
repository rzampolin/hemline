/**
 * Scheduler reliability tests (post-incident 2026-07-10,
 * docs/decisions-scheduler.md): chain poisoning, watchdog timeout, zombie
 * sweep, heartbeat rollover. These pin the exact failure class that took the
 * daily crawls down for 3 days.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger, SourceConnector } from '@hemline/contracts';
import { ingestRuns, sources } from '@hemline/db';
import {
  createTickChain,
  markAbandonedRuns,
  runConnectorTick,
  sweepZombieRuns,
  tickTimeoutMs,
  zombieMaxAgeHours,
} from './scheduler-core';
import { createSchedulerHeartbeat } from './scheduler-heartbeat';
import { createTestDb } from './testing/test-db';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeConnector(id = 'shopify:test.store'): SourceConnector {
  return {
    id,
    kind: 'shopify',
    defaultCadence: '0 6 * * *',
    isConfigured: () => true,
    fetchListings: async () => ({
      listings: [],
      stats: { fetched: 0, errors: 0 },
    }),
  } as unknown as SourceConnector;
}

describe('createTickChain — poison-proofing', () => {
  it('a tick whose body throws synchronously does not prevent later ticks (the incident)', async () => {
    const chain = createTickChain(silent);
    const ran: string[] = [];
    chain.enqueue('poison', () => {
      // exactly the old bug shape: shouldRunConnector throwing SQLITE_BUSY
      throw new Error('SQLITE_BUSY: database is locked');
    });
    chain.enqueue('ebay', async () => {
      ran.push('ebay');
    });
    chain.enqueue('shopify:store-a', async () => {
      ran.push('shopify:store-a');
    });
    await chain.whenIdle();
    expect(ran).toEqual(['ebay', 'shopify:store-a']);
  });

  it('a rejecting tick does not prevent later ticks and never surfaces an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const logger: Logger = { ...silent, error: (...a) => void errors.push(a) };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const chain = createTickChain(logger);
      const ran: string[] = [];
      chain.enqueue('bad', async () => {
        throw new Error('fetch exploded');
      });
      chain.enqueue('good', async () => {
        ran.push('good');
      });
      await chain.whenIdle();
      // give the microtask queue a turn for any would-be unhandledRejection
      await new Promise((r) => setImmediate(r));
      expect(ran).toEqual(['good']);
      expect(errors.length).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('ticks stay strictly serialized', async () => {
    const chain = createTickChain(silent);
    const order: string[] = [];
    chain.enqueue('slow', async () => {
      order.push('slow:start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow:end');
    });
    chain.enqueue('fast', async () => {
      order.push('fast');
    });
    await chain.whenIdle();
    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
  });
});

describe('runConnectorTick — gate inside the protected body', () => {
  it('a throwing gate yields outcome=failed and later enqueued ticks still run', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const chain = createTickChain(silent);
      const outcomes: string[] = [];
      const throwingGate = () => {
        throw new Error('SQLITE_BUSY: database is locked');
      };
      chain.enqueue('store-a', async () => {
        outcomes.push(
          await runConnectorTick(db, fakeConnector('shopify:store-a'), {
            logger: silent,
            gate: throwingGate as never,
          }),
        );
      });
      chain.enqueue('store-b', async () => {
        outcomes.push(
          await runConnectorTick(db, fakeConnector('shopify:store-b'), {
            logger: silent,
            gate: () => ({ run: true, reason: null }),
            runPipelineImpl: async () => ({ runId: 1, status: 'ok', stats: {} as never }),
          }),
        );
      });
      await chain.whenIdle();
      expect(outcomes).toEqual(['failed', 'ran']);
    } finally {
      cleanup();
    }
  });

  it('a gate-skipped tick reports skipped and never starts the pipeline', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const pipeline = vi.fn();
      const outcome = await runConnectorTick(db, fakeConnector(), {
        logger: silent,
        gate: () => ({ run: false, reason: 'disabled in sources table' }),
        runPipelineImpl: pipeline as never,
      });
      expect(outcome).toBe('skipped');
      expect(pipeline).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('a rejecting pipeline yields failed, not a rejected tick', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const outcome = await runConnectorTick(db, fakeConnector(), {
        logger: silent,
        gate: () => ({ run: true, reason: null }),
        runPipelineImpl: async () => {
          throw new Error('upsert failed');
        },
      });
      expect(outcome).toBe('failed');
    } finally {
      cleanup();
    }
  });
});

describe('runConnectorTick — watchdog (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function seed(db: ReturnType<typeof createTestDb>['db'], sourceId: string, startedAt: number) {
    db.insert(sources)
      .values({ id: sourceId, kind: 'shopify', displayName: sourceId, cadenceCron: '0 6 * * *' })
      .onConflictDoNothing()
      .run();
    return db
      .insert(ingestRuns)
      .values({ sourceId, startedAt, status: 'running' })
      .returning({ id: ingestRuns.id })
      .all()[0].id;
  }

  it('a never-resolving tick times out, marks the run row, and unblocks the chain', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const connector = fakeConnector('shopify:monster.store');
      let runId = 0;
      const hang = new Promise<never>(() => {});
      const chain = createTickChain(silent);
      const ran: string[] = [];

      chain.enqueue('monster', () =>
        runConnectorTick(db, connector, {
          logger: silent,
          timeoutMs: 2 * 3_600_000,
          gate: () => ({ run: true, reason: null }),
          runPipelineImpl: () => {
            // mimic runPipeline: records a 'running' row, then hangs forever
            runId = seed(db, connector.id, Date.now());
            return hang;
          },
        }),
      );
      chain.enqueue('next-tick', async () => {
        ran.push('next-tick');
      });

      // 1h59m: still hanging, chain blocked
      await vi.advanceTimersByTimeAsync(119 * 60_000);
      expect(ran).toEqual([]);

      // 2h: watchdog fires, chain proceeds
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await chain.whenIdle();
      expect(ran).toEqual(['next-tick']);

      const row = db.select().from(ingestRuns).where(eq(ingestRuns.id, runId)).get();
      expect(row?.status).toBe('error');
      expect(row?.error).toBe('watchdog timeout');
      expect(row?.finishedAt).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('a run that finishes before the watchdog is untouched', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const connector = fakeConnector('shopify:fast.store');
      const tick = runConnectorTick(db, connector, {
        logger: silent,
        timeoutMs: 2 * 3_600_000,
        gate: () => ({ run: true, reason: null }),
        runPipelineImpl: async () => ({ runId: 1, status: 'ok', stats: {} as never }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(tick).resolves.toBe('ran');
    } finally {
      cleanup();
    }
  });

  it('markAbandonedRuns only touches running rows of this source since the tick started', () => {
    const { db, cleanup } = createTestDb();
    try {
      const now = Date.now();
      const target = seed(db, 'shopify:a', now - 1_000);
      const otherSource = seed(db, 'shopify:b', now - 1_000);
      const older = seed(db, 'shopify:a', now - 10 * 3_600_000);
      db.update(ingestRuns)
        .set({ status: 'ok' })
        .where(eq(ingestRuns.id, older))
        .run(); // wrong status guard: flip target sibling to ok
      const okRow = seed(db, 'shopify:a', now - 500);
      db.update(ingestRuns).set({ status: 'ok' }).where(eq(ingestRuns.id, okRow)).run();

      const changed = markAbandonedRuns(db, 'shopify:a', now - 2_000, now);
      expect(changed).toBe(1);
      expect(db.select().from(ingestRuns).where(eq(ingestRuns.id, target)).get()?.error).toBe(
        'watchdog timeout',
      );
      expect(db.select().from(ingestRuns).where(eq(ingestRuns.id, otherSource)).get()?.status).toBe(
        'running',
      );
    } finally {
      cleanup();
    }
  });
});

describe('sweepZombieRuns', () => {
  it('closes running rows older than the cutoff, leaves fresh/finished rows alone', () => {
    const { db, cleanup } = createTestDb();
    try {
      const now = Date.now();
      db.insert(sources)
        .values({ id: 's1', kind: 'shopify', displayName: 's1', cadenceCron: '0 6 * * *' })
        .run();
      const mk = (startedAt: number, status: string) =>
        db
          .insert(ingestRuns)
          .values({ sourceId: 's1', startedAt, status })
          .returning({ id: ingestRuns.id })
          .all()[0].id;
      const zombie1 = mk(now - 8 * 3_600_000, 'running'); // the prod hand-swept shape
      const zombie2 = mk(now - 72 * 3_600_000, 'running');
      const fresh = mk(now - 3_600_000, 'running'); // live crawl in flight — untouched
      const done = mk(now - 9 * 3_600_000, 'ok');

      const swept = sweepZombieRuns(db, { now, logger: silent });
      expect(swept).toBe(2);
      const byId = (id: number) => db.select().from(ingestRuns).where(eq(ingestRuns.id, id)).get();
      expect(byId(zombie1)).toMatchObject({ status: 'error', error: 'zombie: swept at boot' });
      expect(byId(zombie2)).toMatchObject({ status: 'error', error: 'zombie: swept at boot' });
      expect(byId(fresh)?.status).toBe('running');
      expect(byId(done)).toMatchObject({ status: 'ok', error: null });
    } finally {
      cleanup();
    }
  });

  it('honors INGEST_ZOMBIE_MAX_AGE_HOURS', () => {
    expect(zombieMaxAgeHours({})).toBe(6);
    expect(zombieMaxAgeHours({ INGEST_ZOMBIE_MAX_AGE_HOURS: '12' })).toBe(12);
    expect(zombieMaxAgeHours({ INGEST_ZOMBIE_MAX_AGE_HOURS: 'nope' })).toBe(6);
  });
});

describe('tickTimeoutMs', () => {
  it('defaults to 2h and honors INGEST_TICK_TIMEOUT_MS', () => {
    expect(tickTimeoutMs({})).toBe(2 * 3_600_000);
    expect(tickTimeoutMs({ INGEST_TICK_TIMEOUT_MS: '600000' })).toBe(600_000);
    expect(tickTimeoutMs({ INGEST_TICK_TIMEOUT_MS: '-1' })).toBe(2 * 3_600_000);
  });
});

describe('scheduler heartbeat', () => {
  it('writes the file on beat/recordTick and logs a daily summary on rollover', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-hb-'));
    const file = path.join(dir, 'heartbeat.json');
    let clock = Date.UTC(2026, 6, 13, 23, 59, 0);
    const infos: string[] = [];
    const logger: Logger = { ...silent, info: (m) => void infos.push(m) };

    const hb = createSchedulerHeartbeat({ file, logger, now: () => clock });
    hb.recordTick('ebay');
    hb.recordTick('ebay');
    hb.recordTick('shopify:store-a');

    let written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.updatedAt).toBe(clock);
    expect(written.ticksToday).toEqual({ ebay: 2, 'shopify:store-a': 1 });
    expect(written.date).toBe('2026-07-13');

    // cross midnight UTC → summary line + counters reset
    clock = Date.UTC(2026, 6, 14, 0, 1, 0);
    hb.beat();
    expect(infos.some((m) => m.includes('daily summary 2026-07-13: 3 scheduled tick(s) executed'))).toBe(
      true,
    );
    written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.ticksToday).toEqual({});
    expect(written.date).toBe('2026-07-14');

    hb.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
