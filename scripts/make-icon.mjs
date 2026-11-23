// scripts/make-icon.mjs — renders build/icon.png (1024², transparent outside the squircle) with the
// Playwright Chromium that is already installed for the benchmarks. electron-builder derives the
// .icns from it. Colours follow the app tokens (--mdr-accent #c2500f / warm #bf5700).
//   node scripts/make-icon.mjs
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'icon.png');

const SIZE = 1024;
const PAD = 100;                       // ~10% padding, macOS convention
const BOX = SIZE - PAD * 2;            // 824
const RADIUS = Math.round(BOX * 0.2237); // Big Sur continuous-corner approximation

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e07a2c"/>
      <stop offset="0.45" stop-color="#c85c10"/>
      <stop offset="1" stop-color="#bf5700"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#5a2600" flood-opacity="0.28"/>
    </filter>
  </defs>

  <g filter="url(#drop)">
    <rect x="${PAD}" y="${PAD}" width="${BOX}" height="${BOX}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#bg)"/>
    <rect x="${PAD}" y="${PAD}" width="${BOX}" height="${BOX}" rx="${RADIUS}" ry="${RADIUS}" fill="url(#gloss)"/>
    <rect x="${PAD + 4}" y="${PAD + 4}" width="${BOX - 8}" height="${BOX - 8}" rx="${RADIUS - 4}" ry="${RADIUS - 4}"
          fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="8"/>
  </g>

  <!-- bold "M" -->
  <path d="M 322 552 L 322 288 L 512 470 L 702 288 L 702 552"
        fill="none" stroke="#ffffff" stroke-width="76" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- small download / "open here" arrow -->
  <g stroke="#ffffff" stroke-width="58" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M 512 618 L 512 742"/>
    <path d="M 442 678 L 512 748 L 582 678"/>
  </g>
</svg>`.trim();

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;padding:0;background:transparent">${svg}</body></html>`,
    { waitUntil: 'load' },
  );
  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, png);
  console.log(`icon → ${OUT} (${SIZE}×${SIZE}, ${png.length} bytes)`);
} finally {
  await browser.close();
}
