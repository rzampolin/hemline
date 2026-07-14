/**
 * Generates apps/web/public/og.png (1200×630) — the static branded OG image
 * referenced from app/layout.tsx metadata. Design mirrors the landing hero:
 * cream field, serif wordmark, the hem hook line, and a literal hemline in
 * bordeaux. Run from repo root: `node apps/web/scripts/generate-og.mjs`.
 * Text is rendered with system serif fallbacks (Georgia), so regenerate on a
 * machine with decent fonts and commit the PNG — it is a build artifact only
 * in the loosest sense; CI never runs this.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
const out = path.join(here, '..', 'public', 'og.png');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#faf6ef"/>
  <rect x="0" y="0" width="1200" height="10" fill="#8a3033"/>

  <text x="96" y="150" font-family="Georgia, 'Times New Roman', serif" font-size="44" fill="#8a3033" letter-spacing="2">Soline</text>

  <text x="96" y="296" font-family="Georgia, 'Times New Roman', serif" font-size="80" font-weight="500" fill="#221d18">Dresses that actually</text>
  <text x="96" y="396" font-family="Georgia, 'Times New Roman', serif" font-size="80" font-weight="500" fill="#221d18">fit <tspan fill="#8a3033" font-style="italic">you</tspan>.</text>

  <text x="96" y="490" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="40" fill="#6f6659">“That maxi? It’s a midi on you.”</text>

  <!-- the hemline -->
  <line x1="96" y1="546" x2="640" y2="546" stroke="#8a3033" stroke-width="4" stroke-linecap="round"/>

  <text x="96" y="588" font-family="Georgia, serif" font-size="26" fill="#a39987">12,800+ dresses · 35 boutiques &amp; brands · no account, no trackers</text>

  <!-- sleeveless shift silhouette, right side, with the hem marked -->
  <g transform="translate(950 150)" stroke="#221d18" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M64 0 C 64 34, 36 44, 32 78 L 12 260 Q 110 292, 208 260 L 188 78 C 184 44, 156 34, 156 0" fill="#f2ecdf"/>
    <path d="M64 0 Q 110 34 156 0"/>
    <path d="M4 228 h212" stroke="#8a3033" stroke-width="7"/>
    <text x="110" y="330" text-anchor="middle" font-family="Georgia, serif" font-size="26" fill="#8a3033" stroke="none">midi — on 5′2″</text>
  </g>
</svg>`;

await mkdir(path.dirname(out), { recursive: true });
const png = await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer();
await writeFile(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
