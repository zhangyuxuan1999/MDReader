// bench/verify/r7-fn-same.mjs — fix-san (round 7): loads each document (JSON array file, argv[2]) into the candidate
// (MDR_PORT, dev server) and a baseline (MDR_BASE_PORT, a vite preview of a released dist), switch off, and compares the
// mounted preview block by block (innerHTML and data-mdr-x). Prints one line per document and "RESULT same=<n> of <m>".
//   MDR_PORT=5462 MDR_BASE_PORT=5472 node bench/verify/r7-fn-same.mjs docs.json
// Global timeout 100 s. Writes nothing.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const docs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ports = [process.env.MDR_PORT || '5462', process.env.MDR_BASE_PORT || '5472'];
const browser = await chromium.launch({ headless: true });
let same = 0;
try {
  const pages = [];
  for (const port of ports) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e.message)));
    await page.goto(`http://localhost:${port}/?mode=split&perf=1`); await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
    pages.push({ page, errs });
  }
  for (const [k, doc] of docs.entries()) {
    const snaps = [];
    for (const { page, errs } of pages) {
      const e0 = errs.length;
      await page.evaluate((t) => window.__mdr.loadText(t, 'same.md'), doc);
      await page.evaluate(() => window.__mdr.waitIdle());
      await page.evaluate(() => window.__mdr.app.preview.mountAll());
      await new Promise((r) => setTimeout(r, 300));
      snaps.push({ blocks: await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview .md-block'), (b) => (b.hasAttribute('data-mdr-x') ? 'X' : '-') + b.innerHTML)), errs: errs.length - e0 });
    }
    const [c, b] = snaps;
    const diff = c.blocks.length !== b.blocks.length ? [`count ${c.blocks.length} vs ${b.blocks.length}`] : c.blocks.flatMap((x, i) => (x === b.blocks[i] ? [] : [`block ${i}: ${JSON.stringify(x.slice(0, 160))} vs ${JSON.stringify(b.blocks[i].slice(0, 160))}`]));
    if (!diff.length) same++;
    console.log(`${diff.length ? 'DIFF' : 'same'} doc ${k}: ${c.blocks.length} blocks, page errors ${c.errs}/${b.errs}${diff.length ? ' | ' + diff.slice(0, 3).join(' | ') : ''}`);
  }
} finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
console.log(`RESULT same=${same} of ${docs.length}`);
process.exitCode = same === docs.length ? 0 : 1;
