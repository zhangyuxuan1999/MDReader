// bench/verify/v5-offa-scroll.mjs — verify-off-app JOB 4: scrolling the preview and typing in the editor with the
// preview following, switch OFF, candidate production build vs 0.1.1, alternating runs (indicative, loaded machine).
//   MDR_PORT=5486 MDR_BASE_PORT=5496 node bench/verify/v5-offa-scroll.mjs [runs=3]
// Per run: large.md in split mode; 40 wheel steps of 300 px over the preview (25 ms apart): rAF frame gaps p95 / max
// and long-task total; then 60 keys typed in the middle of the editor (30 ms apart): the same. Medians printed.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { sleep } from './v5-offa-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const LARGE = fs.readFileSync(path.join(ROOT, 'test-data/large.md'), 'utf8');
const runs = Number(process.argv[2] || 3);
const P = { cand: process.env.MDR_PORT || '5486', base: process.env.MDR_BASE_PORT || '5496' };
const wd = setTimeout(() => { console.log('FAIL global timeout'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
const res = { cand: [], base: [] };
const START = () => { window.__gaps = []; window.__lt2 = 0; let last = performance.now(); window.__on = true; const f = (t) => { if (!window.__on) return; window.__gaps.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); };
const STOP = () => { window.__on = false; const g = window.__gaps.slice(1).sort((a, b) => a - b); return { p95: Math.round(g[Math.floor(g.length * 0.95)] || 0), max: Math.round(g[g.length - 1] || 0), lt: Math.round(window.__lt2) }; };
try {
  for (let i = 0; i < runs; i++) {
    for (const b of i % 2 ? ['base', 'cand'] : ['cand', 'base']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch {} window.__lt2 = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt2 += e.duration; }).observe({ type: 'longtask' }); } catch {} });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${P[b]}/?perf=1&mode=split`);
      await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app);
      await page.evaluate((t) => window.__mdr.app.loadText(t, 'large.md'), LARGE);
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(800);
      const r = await page.evaluate(() => { const e = document.querySelector('.mdr-preview').getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2 }; });
      await page.mouse.move(r.x, r.y);
      await page.evaluate(START);
      for (let k = 0; k < 40; k++) { await page.mouse.wheel(0, 300); await sleep(25); }
      await sleep(400);
      const sc = await page.evaluate(STOP);
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; const L = v.state.doc.line(Math.floor(v.state.doc.lines / 2)); v.focus(); v.dispatch({ selection: { anchor: L.to }, scrollIntoView: true }); });
      await sleep(800);
      await page.evaluate(START);
      for (let k = 0; k < 60; k++) { await page.keyboard.type(k % 7 === 6 ? ' ' : 'x'); await sleep(30); }
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(300);
      const ty = await page.evaluate(STOP);
      res[b].push({ scrollP95: sc.p95, scrollMax: sc.max, scrollLT: sc.lt, typeP95: ty.p95, typeMax: ty.max, typeLT: ty.lt });
      await ctx.close();
    }
  }
} finally { clearTimeout(wd); await browser.close(); }
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const k of Object.keys(res.cand[0])) {
  const c = med(res.cand.map((r) => r[k])), bb = med(res.base.map((r) => r[k]));
  console.log(`${k.padEnd(10)} cand ${String(c).padStart(6)}  base ${String(bb).padStart(6)}   cand[${res.cand.map((r) => r[k]).join(',')}] base[${res.base.map((r) => r[k]).join(',')}]`);
}
process.exit(0);
