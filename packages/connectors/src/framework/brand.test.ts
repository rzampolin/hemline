import { describe, expect, it } from 'vitest';
import { canonicalBrandName, looksLikeVendorCode, resolveBrand } from './brand';

// Real junk observed in the production facet, 2026-07-09 (~8.3k listings).
const PROD_JUNK = [
  // christydawn.com internal season codes
  'SP23',
  'SP25',
  'SP26B',
  'PS23A',
  'PS26A',
  'F24A',
  'F25',
  'PF22',
  'PF25',
  'H25',
  'W25',
  'U24B',
  'U25A',
  'U26B',
  'BF24B',
  'BF25',
  'Summer 24',
  'OSHADI COLLECTIVE (OPC) PRIVATE LIMITED',
  // staud.clothing collection labels
  'STAUD FALL 2023',
  'STAUD HOLIDAY SALE 2024',
  'STAUD HOLIDAY 2024 SALE',
  'STAUD SPRING 20 CORE',
  'STAUD PRE FALL 2025 SALE',
  'STAUD RESORT 2026 LATE ADDS',
  'STAUD SPRING 2023 BRIDAL',
  // petalandpup.com drop codes (incl. the lowercase variant seen live)
  'PUP3',
  'PUP129',
  'PUP130',
  'pup129',
];

// Genuine vendors that a multi-brand store must preserve.
const LEGIT_VENDORS = [
  'Free People',
  'Betsey Johnson',
  'ASTR the Label',
  'Diane von Furstenberg',
  'Norma Kamali',
  'Gunne Sax',
  '4th & Reckless',
  'Winter Kate', // season word WITHOUT a year stays a brand
  'Bo+Tee',
  'STAUD',
  'Christy Dawn',
  'Petal & Pup',
];

describe('looksLikeVendorCode', () => {
  it('flags every junk pattern found in production', () => {
    for (const junk of PROD_JUNK) {
      expect(looksLikeVendorCode(junk), `expected junk: ${junk}`).toBe(true);
    }
  });

  it('keeps genuine brands', () => {
    for (const brand of LEGIT_VENDORS) {
      expect(looksLikeVendorCode(brand), `expected legit: ${brand}`).toBe(false);
    }
  });

  it('treats empty/blank vendors as junk', () => {
    expect(looksLikeVendorCode('')).toBe(true);
    expect(looksLikeVendorCode('   ')).toBe(true);
  });
});

describe('resolveBrand', () => {
  const single = { displayName: 'Christy Dawn', brandName: 'Christy Dawn', brandMode: 'single' as const };
  const multi = { displayName: 'Lulus', brandName: 'Lulus', brandMode: 'multi' as const };

  it("single-brand stores ALWAYS get the store's canonical brand", () => {
    expect(resolveBrand('SP26B', single)).toBe('Christy Dawn');
    expect(resolveBrand('OSHADI COLLECTIVE (OPC) PRIVATE LIMITED', single)).toBe('Christy Dawn');
    // even a plausible-looking vendor is demoted on a single-brand store
    expect(resolveBrand('Veda', single)).toBe('Christy Dawn');
    expect(resolveBrand('', single)).toBe('Christy Dawn');
    expect(resolveBrand(null, single)).toBe('Christy Dawn');
  });

  it('multi-brand stores keep genuine vendors and fall back on codes', () => {
    expect(resolveBrand('Free People', multi)).toBe('Free People');
    expect(resolveBrand('ASTR the Label', multi)).toBe('ASTR the Label');
    expect(resolveBrand('LU123', multi)).toBe('Lulus');
    expect(resolveBrand('SPRING 2024 SALE', multi)).toBe('Lulus');
    expect(resolveBrand(undefined, multi)).toBe('Lulus');
  });

  it('defaults to multi mode (ad-hoc --store domains keep vendor-wins behavior)', () => {
    const adhoc = { displayName: 'example.com' };
    expect(resolveBrand('Some Brand', adhoc)).toBe('Some Brand');
    expect(resolveBrand('SP26B', adhoc)).toBe('example.com');
    expect(canonicalBrandName(adhoc)).toBe('example.com');
  });

  it('knownBrands carve distinct labels out of collection vendors (Sister Jane / Ghospell)', () => {
    const sisterjane = {
      displayName: 'Sister Jane',
      brandName: 'Sister Jane',
      brandMode: 'single' as const,
      knownBrands: ['Ghospell'],
    };
    // verified live 2026-07-09: vendor is always a collection label
    expect(resolveBrand('Playback by Ghospell', sisterjane)).toBe('Ghospell');
    expect(resolveBrand('The Curve by Ghospell', sisterjane)).toBe('Ghospell');
    expect(resolveBrand('DREAM Voyage Voyage', sisterjane)).toBe('Sister Jane');
    expect(resolveBrand('Voyage Voyage', sisterjane)).toBe('Sister Jane');
    expect(resolveBrand('Secrets The Water Keeps', sisterjane)).toBe('Sister Jane');
    expect(resolveBrand('POPPY x Sister Jane', sisterjane)).toBe('Sister Jane');
    expect(resolveBrand('Sister Jane Exclusives', sisterjane)).toBe('Sister Jane');
  });

  it('knownBrands match on word boundaries with regex metacharacters escaped', () => {
    const ohpolly = {
      displayName: 'Oh Polly',
      brandName: 'Oh Polly',
      brandMode: 'single' as const,
      knownBrands: ['Bo+Tee'],
    };
    expect(resolveBrand('Bo+Tee', ohpolly)).toBe('Bo+Tee');
    expect(resolveBrand('Oh Polly Swim', ohpolly)).toBe('Oh Polly');
    // no false substring hit
    expect(resolveBrand('BoaTee', ohpolly)).toBe('Oh Polly');
  });

  it('collapses decorated single-brand vendor variants (RIXO ⋆ / mojibake)', () => {
    const rixo = { displayName: 'RIXO', brandName: 'RIXO', brandMode: 'single' as const };
    expect(resolveBrand('RIXO ⋆', rixo)).toBe('RIXO');
    expect(resolveBrand('RIXO â‹†', rixo)).toBe('RIXO');
    expect(resolveBrand('Rixo', rixo)).toBe('RIXO');
  });
});
