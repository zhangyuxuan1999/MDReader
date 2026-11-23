// bench/verify/v5-offa-huge.mjs — verify-off-app JOB 3/4: test-data/huge.md opened in split mode, switch OFF,
// candidate production build vs 0.1.1, alternating (indicative): time to the first block and to idle, JS heap
// after idle, blocks in the DOM, then End in the editor and the preview's scroll position after the follow.
//   MDR_PORT=5486 MDR_BASE_PORT=5496 node bench/verify/v5-offa-huge.mjs [runs=2]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { sleep } from './v5-offa-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const HUGE = fs.readFileSync(path.join(ROOT, 'test-data/huge.md'), 'utf8');
const runs = Number(process.argv[2] || 2);
const P = { cand: process.env.MDR_PORT || '5486', base: process.env.MDR_BASE_PORT || '5496' };
const wd = setTimeout(() => { console.log('FAIL global timeout'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
try {
  for (let i = 0; i < runs; i++) {
    for (const b of i % 2 ? ['base', 'cand'] : ['cand', 'base']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch {} });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${P[b]}/?perf=1&mode=split`);
      await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
      await sleep(300);
      const r = await page.evaluate(async (t) => {
        const s = performance.now();
        window.__mdr.app.loadText(t, 'huge.md');
        await new Promise((res) => { const f = () => (document.querySelector('.mdr-preview .md-block > *') ? res() : requestAnimationFrame(f)); f(); });
        const first = performance.now() - s;
        await window.__mdr.waitIdle();
        return { first: Math.round(first), idle: Math.round(performance.now() - s), heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6), blocks: document.querySelectorAll('.mdr-preview .md-block').length };
      }, HUGE);
      await page.evaluate(() => window.__mdr.app.editor.focus());
      await page.keyboard.press('Meta+End');
      await sleep(1500);
      r.end = await page.evaluate(() => ({ ed: Math.round(document.querySelector('.cm-scroller').scrollTop), pv: Math.round(document.querySelector('.mdr-preview').scrollTop), pvMax: Math.round(document.querySelector('.mdr-preview').scrollHeight - document.querySelector('.mdr-preview').clientHeight) }));
      console.log(b, JSON.stringify(r));
      await ctx.close();
    }
  }
} finally { clearTimeout(wd); await browser.close(); }
process.exit(0);
