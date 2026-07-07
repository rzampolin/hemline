/**
 * Image resolver. Fixture images are placehold.co gray boxes; the mock derive
 * script rewrites them to a compact `mockimg:` scheme which this resolver turns
 * into inline-SVG editorial placeholders — colored by the dress's actual
 * extracted colors, skirt length matching its lengthClass. Offline, fast,
 * deterministic for e2e. Real http(s) product images pass straight through.
 */

const HEM_Y: Record<string, number> = {
  micro: 420,
  mini: 452,
  above_knee: 488,
  knee: 522,
  midi: 588,
  mid_calf: 636,
  maxi: 716,
  floor: 752,
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const CREAM: [number, number, number] = [250, 246, 239];
const INK: [number, number, number] = [34, 29, 24];

export function resolveImage(url: string): string {
  if (!url.startsWith('mockimg:')) return url;
  const p = new URLSearchParams(url.slice('mockimg:'.length));
  const i = Number(p.get('i') ?? 0);
  const c0 = hexToRgb(`#${p.get('c0') ?? 'a89b8c'}`);
  const c1 = hexToRgb(`#${p.get('c1') ?? p.get('c0') ?? 'a89b8c'}`);
  const len = p.get('len') ?? 'midi';
  const brand = (p.get('b') ?? '').slice(0, 26);

  const bg = mix(c0, CREAM, 0.82);
  const bg2 = mix(c1, CREAM, 0.68);
  const dress = mix(c0, INK, 0.08);
  const dressDeep = mix(c0, INK, 0.32);
  const panel = mix(c1, INK, 0.12);

  const hemY = HEM_Y[len] ?? 560;
  // Skirt flares wider the longer it falls.
  const w = Math.round(58 + (hemY - 330) * 0.26);
  // Gallery variants: alternate gradient direction + slight zoom.
  const grad = i % 2 === 0 ? 'x1="0" y1="0" x2="0" y2="1"' : 'x1="0" y1="0" x2="1" y2="1"';
  const zoom = i === 0 ? '' : ` transform="translate(${300 - 300 * 1.12 + (i % 3) * 14} ${400 - 400 * 1.12}) scale(1.12)"`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800">
<defs><linearGradient id="g" ${grad}><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
<rect width="600" height="800" fill="url(#g)"/>
<g${zoom}>
<line x1="300" y1="96" x2="262" y2="172" stroke="${dressDeep}" stroke-width="4" stroke-linecap="round"/>
<line x1="300" y1="96" x2="338" y2="172" stroke="${dressDeep}" stroke-width="4" stroke-linecap="round"/>
<circle cx="300" cy="88" r="9" fill="none" stroke="${dressDeep}" stroke-width="4"/>
<path d="M262 172 C276 196 324 196 338 172 L362 252 L348 336 L252 336 L238 252 Z" fill="${dress}"/>
<path d="M252 336 Q300 350 348 336 L${300 + w} ${hemY} Q300 ${hemY + 22} ${300 - w} ${hemY} Z" fill="${dress}"/>
<path d="M300 344 Q306 ${(hemY + 344) / 2} 300 ${hemY + 8} Q296 ${(hemY + 344) / 2} 300 344" fill="${panel}" opacity="0.55"/>
<path d="M${300 - Math.round(w * 0.55)} ${hemY - 6} Q300 ${hemY + 16} ${300 + Math.round(w * 0.55)} ${hemY - 6}" fill="none" stroke="${dressDeep}" stroke-width="2" opacity="0.5"/>
</g>
<text x="300" y="778" text-anchor="middle" font-family="Georgia,serif" font-size="21" letter-spacing="5" fill="${mix(INK, c0, 0.25)}">${brand.toUpperCase().replace(/&/g, '&amp;')}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
