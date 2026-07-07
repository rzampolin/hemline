import { describe, expect, it } from 'vitest';
import {
  BATCH_DISCOUNT,
  createAiClient,
  createCostMeter,
  estimateCostUsd,
  resolveAiMode,
} from './client';

describe('resolveAiMode / createAiClient', () => {
  it('keyless → mock; key → live', () => {
    expect(resolveAiMode({} as NodeJS.ProcessEnv)).toBe('mock');
    expect(resolveAiMode({ ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv)).toBe('live');
  });

  it('mock client has no SDK instance; live client does', () => {
    expect(createAiClient({} as NodeJS.ProcessEnv).anthropic).toBeNull();
    expect(
      createAiClient({ ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv).anthropic,
    ).not.toBeNull();
  });

  it('model ids default per the doc and are env-overridable', () => {
    const client = createAiClient({} as NodeJS.ProcessEnv);
    expect(client.models.extraction).toBe('claude-haiku-4-5-20251001');
    expect(client.models.rerank).toBe('claude-haiku-4-5-20251001');
    expect(client.models.color).toBe('claude-sonnet-4-6');
    const overridden = createAiClient({
      EXTRACTION_MODEL: 'claude-haiku-4-5-test',
    } as NodeJS.ProcessEnv);
    expect(overridden.models.extraction).toBe('claude-haiku-4-5-test');
  });
});

describe('cost meter & daily budget cap', () => {
  it('estimates Haiku pricing ($1/$5 per MTok) and the 50% batch discount', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(6, 6);
    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage, { batch: true })).toBeCloseTo(
      6 * BATCH_DISCOUNT,
      6,
    );
    expect(estimateCostUsd('claude-sonnet-4-6', usage)).toBeCloseTo(18, 6);
  });

  it('accumulates a daily ledger', () => {
    const meter = createCostMeter({ AI_DAILY_BUDGET_USD: '5' } as NodeJS.ProcessEnv);
    meter.record('claude-haiku-4-5-20251001', { input_tokens: 1200, output_tokens: 300 });
    meter.record('claude-haiku-4-5-20251001', { input_tokens: 1200, output_tokens: 300 });
    expect(meter.totalUsd()).toBeCloseTo(2 * (1200 / 1e6 + (300 * 5) / 1e6), 9);
    const ledger = meter.ledger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].calls).toBe(2);
    expect(meter.overBudget()).toBe(false);
  });

  it('hard cap: crossing AI_DAILY_BUDGET_USD flips effectiveMode to mock', () => {
    const client = createAiClient({
      ANTHROPIC_API_KEY: 'sk-ant-x',
      AI_DAILY_BUDGET_USD: '0.01',
    } as NodeJS.ProcessEnv);
    expect(client.effectiveMode()).toBe('live');
    client.meter.record('claude-haiku-4-5-20251001', {
      input_tokens: 5_000_000,
      output_tokens: 1_000_000,
    });
    expect(client.meter.overBudget()).toBe(true);
    expect(client.effectiveMode()).toBe('mock');
  });

  it('defaults the budget to $5 when unset or invalid', () => {
    expect(createCostMeter({} as NodeJS.ProcessEnv).dailyBudgetUsd).toBe(5);
    expect(
      createCostMeter({ AI_DAILY_BUDGET_USD: 'nope' } as NodeJS.ProcessEnv).dailyBudgetUsd,
    ).toBe(5);
  });

  it('counts cache reads/writes at their discounted/premium rates', () => {
    const cost = estimateCostUsd('claude-haiku-4-5-20251001', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.1 + 1.25, 6);
  });
});
