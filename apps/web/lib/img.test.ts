import { describe, expect, it } from 'vitest';
import { editorialPlaceholder, isPlaceholderImage, resolveImage } from './img';

describe('isPlaceholderImage — known gray-box hosts (2026-07-10 gray-card fix)', () => {
  it('flags placehold.co URLs (the fixture-listing gray boxes in the live catalog)', () => {
    expect(isPlaceholderImage('https://placehold.co/600x800?text=STAUD+Margaux')).toBe(true);
    expect(isPlaceholderImage('http://placehold.co/600x800')).toBe(true);
  });

  it('passes real CDN and data URLs through', () => {
    expect(isPlaceholderImage('https://cdn.shopify.com/s/files/1/x.jpg')).toBe(false);
    expect(isPlaceholderImage('https://media.thereformation.com/image/upload/x')).toBe(false);
    expect(isPlaceholderImage('mockimg:i=0&c0=800020')).toBe(false);
    expect(isPlaceholderImage('')).toBe(false);
  });
});

describe('editorialPlaceholder — on-brand SVG from real listing attributes', () => {
  const listing = {
    brand: 'STAUD',
    colors: [
      { hex: '#800020' },
      { hex: '#8E4585' },
    ],
    lengthClass: 'mini',
  };

  it('renders an inline SVG data URI (cannot fail to load)', () => {
    const url = editorialPlaceholder(listing);
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    const svg = decodeURIComponent(url.split(',')[1]);
    expect(svg).toContain('STAUD');
  });

  it('is deterministic and varies by gallery index', () => {
    expect(editorialPlaceholder(listing, 0)).toBe(editorialPlaceholder(listing, 0));
    expect(editorialPlaceholder(listing, 1)).not.toBe(editorialPlaceholder(listing, 0));
  });

  it('survives missing colors / brand / length (never throws, never gray)', () => {
    const url = editorialPlaceholder({ brand: null, colors: [], lengthClass: null });
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1])).toContain('ONE OF A KIND');
  });

  it('resolveImage still passes real URLs straight through', () => {
    expect(resolveImage('https://cdn.shopify.com/x.jpg')).toBe('https://cdn.shopify.com/x.jpg');
  });
});
