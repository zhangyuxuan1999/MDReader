// bench/verify/v6-vr-blank.mjs — verify-review (stage 2f, after fix round 5): rule "J19 extended" lets a code point stand
// raw in a URL only if it is L / N / P / S and not on the blank list (U+115F, U+1160, U+3164, U+FFA0, U+2800). Which of
// the code points it lets through draw NO ink in Chromium, in the fonts the app uses (the editor's and the preview's
// computed font-family, read off the running app), on this machine? Each code point is drawn at 28 px on a canvas and
// its cell is scanned for a non-transparent pixel.
// Run: MDR_PORT=<any build of the app> node bench/verify/v6-vr-blank.mjs   (prints the blank ones per font). Writes nothing.
// Global timeout 110 s.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110000);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const fonts = await page.evaluate(() => {
    const ed = getComputedStyle(document.querySelector('.cm-content')).fontFamily;
    const pv = document.querySelector('.md-block p, .md-block, [class*=preview]');
    return { editor: ed, preview: pv ? getComputedStyle(pv).fontFamily : 'sans-serif' };
  });
  console.log('fonts', JSON.stringify(fonts));
  for (const [which, family] of Object.entries(fonts)) {
    const res = await page.evaluate(async (fam) => {
      const BLANK = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]);
      const VIS = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
      const cps = [];
      for (let cp = 0x21; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const c = String.fromCodePoint(cp);
        if (VIS.test(c) && !BLANK.has(cp)) cps.push(cp);
      }
      await document.fonts.ready;
      const N = 32, S = 36;                      // 32 x 32 cells of 36 px
      const cv = document.createElement('canvas');
      cv.width = N * S; cv.height = N * S;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.font = `28px ${fam}`;
      g.textBaseline = 'middle';
      g.textAlign = 'center';
      const blank = [];
      for (let i = 0; i < cps.length; i += N * N) {
        const batch = cps.slice(i, i + N * N);
        g.clearRect(0, 0, cv.width, cv.height);
        batch.forEach((cp, k) => g.fillText(String.fromCodePoint(cp), (k % N) * S + S / 2, Math.floor(k / N) * S + S / 2));
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        batch.forEach((cp, k) => {
          const x0 = (k % N) * S, y0 = Math.floor(k / N) * S;
          for (let y = y0; y < y0 + S; y++) for (let x = x0; x < x0 + S; x++) if (d[(y * cv.width + x) * 4 + 3] !== 0) return;
          blank.push(cp);
        });
      }
      return { total: cps.length, blank };
    }, family);
    const gc = (cp) => { for (const g of ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Nd', 'Nl', 'No', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'Sm', 'Sc', 'Sk', 'So']) if (new RegExp(`^\\p{${g}}$`, 'u').test(String.fromCodePoint(cp))) return g; return '?'; };
    const hex = (cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    console.log(`BLANK ${which} font=${JSON.stringify(family)} allowed=${res.total} drawnBlank=${res.blank.length}: ${res.blank.slice(0, 120).map((cp) => `${hex(cp)} ${gc(cp)}`).join(', ')}${res.blank.length > 120 ? ' …' : ''}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
