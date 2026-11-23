// bench/verify/v9-ro-selall.mjs — regress-off (round 7): the case key-editor-Meta+a of v5-offa-daily.mjs, sampled over
// time. medium.md loaded, a word on line 5 selected in the editor, 'Q' typed, the word selected again, ⌘A pressed; then
// the preview's scrollTop every 50 ms for 2 s (the daily case looks once, at 500 ms). Switch stored '0' on every port.
//   node bench/verify/v9-ro-selall.mjs <runs> <port> [<port> ...]      (production builds get ?perf=1)
// Prints per port and run the first time (ms after ⌘A) the preview's top moved past 1000 px, and the samples at 250 /
// 500 / 1000 / 2000 ms. Global timeout 110 s. Writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const MED = fs.readFileSync(path.join(ROOT, 'test-data/medium.md'), 'utf8');
const [runs, ...ports] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const browser = await chromium.launch({ headless: true });
try {
  for (let r = 0; r < Number(runs); r++) {
    for (const port of ports) {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
      const page = await ctx.newPage();
      // "<port>f": the tree's dev server with the page's entry rewritten to the frozen 0.2.0 copy (as r7-fp-probe.mjs)
      const p = String(port).replace(/f$/, '');
      if (String(port).endsWith('f')) await page.route(`http://localhost:${p}/?*`, async (route) => { const res = await route.fetch(); await route.fulfill({ response: res, body: (await res.text()).replace('/src/main.ts', '/test/fixtures/src-0.2.0/main.ts') }); });
      await page.goto(`http://localhost:${p}/?mode=split&perf=1`);
      await page.waitForFunction(() => !!window.__mdr?.app?.editor);
      await page.addStyleTag({ content: '.mdr-perf { display: none !important; }' });
      await page.evaluate((t) => window.__mdr.app.loadText(t, 'daily.md'), MED); await sleep(900);
      const sel = () => page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); const L = v.state.doc.line(5); v.dispatch({ selection: { anchor: L.from + 2, head: Math.min(L.to, L.from + 6) } }); });
      await sel(); await page.keyboard.type('Q'); await sel();
      await page.evaluate(() => { window.__s = []; const t0 = performance.now(); const pv = document.querySelector('.mdr-preview'); const id = setInterval(() => { window.__s.push([Math.round(performance.now() - t0), Math.round(pv.scrollTop)]); if (performance.now() - t0 > 2000) clearInterval(id); }, 50); });
      await page.keyboard.press('Meta+a');
      await sleep(2200);
      const s = await page.evaluate(() => window.__s);
      const at = (ms) => (s.find(([t]) => t >= ms) || [])[1];
      const moved = s.find(([, v]) => v > 1000);
      console.log(`port ${port} run ${r}: moved>1000 at ${moved ? moved[0] : 'never'} ms; 250:${at(250)} 500:${at(500)} 1000:${at(1000)} 2000:${at(2000)}`);
      await ctx.close();
    }
  }
} finally { clearTimeout(kill); await browser.close(); }
