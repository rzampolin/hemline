import { describe, expect, it } from 'vitest';
import type { ExtractionInput } from '@hemline/contracts';
import { createAiClient } from '../client';
import {
  createExtractionService,
  finalizeModelOutput,
  InMemoryExtractionCache,
} from './index';
import { parseMeasurements } from './measurements';
import type { ExtractionModelOutput } from './prompt';

const MOCK_ENV = {} as NodeJS.ProcessEnv; // no ANTHROPIC_API_KEY → mock mode

function input(hash: string, title: string, description: string | null = null): ExtractionInput {
  return {
    contentHash: hash,
    title,
    description,
    brand: null,
    primaryImageUrl: null,
    attributeHints: null,
    sizeLabels: [],
  };
}

describe('createExtractionService (mock mode)', () => {
  it('reports mock mode without a key', () => {
    const service = createExtractionService({ client: createAiClient(MOCK_ENV), logger: () => {} });
    expect(service.mode).toBe('mock');
  });

  it('extracts a batch and logs the [MOCK] banner', async () => {
    const logs: string[] = [];
    const service = createExtractionService({
      client: createAiClient(MOCK_ENV),
      logger: (m) => logs.push(m),
    });
    const results = await service.extractBatch([
      input('h1', 'Emerald Silk Wrap Midi Dress', 'length 44", v-neck'),
      input('h2', 'Black Bodycon Mini Dress'),
    ]);
    expect(results.size).toBe(2);
    expect(results.get('h1')!.lengthClass).toBe('midi');
    expect(results.get('h2')!.lengthClass).toBe('mini');
    expect(logs.some((l) => l.includes('[MOCK]'))).toBe(true);
  });

  it('is idempotent by content hash: second run served from cache, no re-extract', async () => {
    const cache = new InMemoryExtractionCache();
    const logs: string[] = [];
    const service = createExtractionService({
      client: createAiClient(MOCK_ENV),
      cache,
      logger: (m) => logs.push(m),
    });
    const first = await service.extractBatch([input('h1', 'Sage Midi Dress')]);
    expect(cache.size).toBe(1);
    const logCountAfterFirst = logs.length;
    const second = await service.extractBatch([input('h1', 'Sage Midi Dress')]);
    expect(second.get('h1')).toEqual(first.get('h1'));
    expect(logs.length).toBe(logCountAfterFirst); // no second [MOCK] extraction pass
  });

  it('cached entries record model="mock" (extractions table semantics)', async () => {
    const cache = new InMemoryExtractionCache();
    const service = createExtractionService({
      client: createAiClient(MOCK_ENV),
      cache,
      logger: () => {},
    });
    await service.extractBatch([input('h1', 'Sage Midi Dress')]);
    const cached = await cache.get('h1');
    expect(cached!.model).toBe('mock');
  });

  it('dedupes identical content hashes within one batch', async () => {
    const service = createExtractionService({ client: createAiClient(MOCK_ENV), logger: () => {} });
    const results = await service.extractBatch([
      input('same', 'Navy Maxi Dress'),
      input('same', 'Navy Maxi Dress'),
    ]);
    expect(results.size).toBe(1);
  });
});

describe('finalizeModelOutput — deterministic pre-parse verification', () => {
  const baseOutput: ExtractionModelOutput = {
    lengthClass: 'midi',
    lengthInches: 44,
    measurements: { bust: 36, waist: null, hip: null, length: 44 },
    colors: [{ name: 'navy', family: 'blue', hex: '#000080' }],
    fabric: 'silk',
    neckline: 'v_neck',
    silhouette: 'slip',
    sleeve: 'sleeveless',
    pattern: 'solid',
    occasions: ['cocktail'],
    confidence: 0.9,
  };
  const anInput = input('h', 'Navy Slip Midi Dress');

  it('regex value overrides a disagreeing model measurement (regex wins)', () => {
    const parsed = parseMeasurements('pit to pit 21"'); // bust 42
    const finalized = finalizeModelOutput(
      { ...baseOutput, measurements: { ...baseOutput.measurements, bust: 36 } },
      parsed,
      anInput,
    );
    expect(finalized.measurements.bust).toBe(42);
  });

  it('agreement within tolerance keeps the model value', () => {
    const parsed = parseMeasurements('pit to pit 18"'); // bust 36
    const finalized = finalizeModelOutput(
      { ...baseOutput, measurements: { ...baseOutput.measurements, bust: 36.5 } },
      parsed,
      anInput,
    );
    expect(finalized.measurements.bust).toBe(36.5);
  });

  it('regex fills measurements the model missed', () => {
    const parsed = parseMeasurements('waist 28"');
    const finalized = finalizeModelOutput(baseOutput, parsed, anInput);
    expect(finalized.measurements.waist).toBe(28);
  });

  it('regex HPS length overrides a disagreeing model length', () => {
    const parsed = parseMeasurements('length 39"');
    const finalized = finalizeModelOutput({ ...baseOutput, lengthInches: 50 }, parsed, anInput);
    expect(finalized.lengthInches).toBe(39);
  });

  it('waist-to-hem lengths never land in lengthInches', () => {
    const parsed = parseMeasurements('waist to hem 24"');
    const finalized = finalizeModelOutput({ ...baseOutput, lengthInches: null }, parsed, anInput);
    expect(finalized.lengthInches).toBeNull();
  });

  it('derives the attribute vector and flags vintage from the title', () => {
    const parsed = parseMeasurements('');
    const finalized = finalizeModelOutput(
      baseOutput,
      parsed,
      input('h', 'VTG 1970s Navy Slip Midi Dress'),
    );
    expect(finalized.attributeVector['silhouette:slip']).toBe(1);
    expect(finalized.attributeVector['era:vintage']).toBe(0.6);
    expect(finalized.attributeVector['color:blue']).toBe(0.8);
  });

  it('clamps model confidence into 0..1', () => {
    const parsed = parseMeasurements('');
    expect(
      finalizeModelOutput({ ...baseOutput, confidence: 1.7 }, parsed, anInput).confidence,
    ).toBe(1);
  });
});
