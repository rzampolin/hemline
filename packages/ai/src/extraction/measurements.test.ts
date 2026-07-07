import { describe, expect, it } from 'vitest';
import { measurementsAgree, parseMeasurements } from './measurements';

describe('parseMeasurements — free-text measurement pre-parser', () => {
  it('pit to pit is flat → bust doubles', () => {
    expect(parseMeasurements('pit to pit 18"').bust).toBe(36);
    expect(parseMeasurements('Pit To Pit: 21').bust).toBe(42);
    expect(parseMeasurements('armpit to armpit 19.5 in').bust).toBe(39);
  });

  it('length in inches, with several phrasings', () => {
    expect(parseMeasurements('length 39 inches').length).toBe(39);
    expect(parseMeasurements('Length: 48.6" from high point of shoulder (size 6)').length).toBe(48.6);
    expect(parseMeasurements('shoulder to hem: 44in').length).toBe(44);
    expect(parseMeasurements('measures 35" long').length).toBe(35);
  });

  it('detects waist-to-hem basis (doc §5 drop-waist edge case)', () => {
    const parsed = parseMeasurements('waist to hem 24in');
    expect(parsed.length).toBe(24);
    expect(parsed.lengthMeasuredFrom).toBe('waist');
    // and it must NOT be mistaken for a waist circumference
    expect(parsed.waist).toBeNull();
  });

  it('HPS lengths carry hps basis', () => {
    expect(parseMeasurements('length 39"').lengthMeasuredFrom).toBe('hps');
  });

  it('bust/waist/hip full circumferences pass through', () => {
    const parsed = parseMeasurements('bust 36, waist 28, hips 40');
    expect(parsed.bust).toBe(36);
    expect(parsed.waist).toBe(28);
    expect(parsed.hip).toBe(40);
  });

  it('"flat" suffix doubles a single field', () => {
    expect(parseMeasurements('waist 14.5" flat').waist).toBe(29);
    expect(parseMeasurements('hips 23" flat').hip).toBe(46);
  });

  it('a "Flat measurements:" sentence context makes bare numbers flat', () => {
    const parsed = parseMeasurements('Flat measurements: pit to pit 21", waist 16.');
    expect(parsed.bust).toBe(42);
    expect(parsed.waist).toBe(32);
  });

  it('…but an obviously full circumference in flat context is not doubled', () => {
    const parsed = parseMeasurements('Flat measurements: pit to pit 20. waist 32');
    expect(parsed.bust).toBe(40);
    expect(parsed.waist).toBe(32); // 32 ≥ full-circumference floor → left alone
  });

  it('cm converts to inches', () => {
    expect(parseMeasurements('length 100 cm').length).toBe(39.4);
    expect(parseMeasurements('bust 90cm').bust).toBe(35.4);
  });

  it('rejects implausible values instead of garbage-extracting', () => {
    expect(parseMeasurements('length 9"').length).toBeNull(); // < 20
    expect(parseMeasurements('waist 90').waist).toBeNull(); // > 65
  });

  it('returns all-null for measurement-free text', () => {
    const parsed = parseMeasurements('Gorgeous silk slip dress, worn once.');
    expect(parsed).toMatchObject({ bust: null, waist: null, hip: null, length: null });
    expect(parsed.matches).toEqual([]);
  });

  it('is deterministic', () => {
    const text = 'Flat measurements: pit to pit 21", waist 16" flat, length 58.';
    expect(parseMeasurements(text)).toEqual(parseMeasurements(text));
  });
});

describe('measurementsAgree', () => {
  it('within tolerance agrees; nulls never disagree', () => {
    expect(measurementsAgree(36, 37)).toBe(true);
    expect(measurementsAgree(36, 38)).toBe(false);
    expect(measurementsAgree(null, 38)).toBe(true);
    expect(measurementsAgree(36, null)).toBe(true);
  });
});
