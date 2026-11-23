// bench/verify/v5-offa-cold.mjs — verify-off-app JOB 4: cold start and opening as a user feels it, switch OFF,
// candidate production build vs 0.1.1, alternating runs in fresh contexts (no cache).
//   MDR_PORT=5486 MDR_BASE_PORT=5496 node bench/verify/v5-offa-cold.mjs [runs=4] [--cpu 4] [--net 10] [--warm]
// --cpu N: CDP CPU throttling rate; --net M: network throttled to M Mbit/s down, 20 ms latency (the deployed page).
// Measures: JS bytes received before the editor exists; time from navigation to .cm-content, to the first
// rendered .md-block of the empty start (none) / of small.md and large.md opened through loadText; main-thread
// long-task total during start. Prints medians per build. Global timeout 115 s.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { sleep } from './v5-offa-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SMALL = fs.readFileSync(path.join(ROOT, 'test-data/small.md'), 'utf8');
const LARGE = fs.readFileSync(path.join(ROOT, 'test-data/large.md'), 'utf8');
const args = process.argv.slice(2);
const runs = Number(args.find((a) => /^\d+$/.test(a)) || 4);
const cpu = args.includes('--cpu') ? Number(args[args.indexOf('--cpu') + 1]) : 1;
const net = args.includes('--net') ? Number(args[args.indexOf('--net') + 1]) : 0;
const warm = args.includes('--warm'); // a first visit fills the HTTP cache; the second visit is measured
const P = { cand: process.env.MDR_PORT || '5486', base: process.env.MDR_BASE_PORT || '5496' };
const wd = setTimeout(() => { console.log('FAIL global timeout'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
const res = { cand: [], base: [] };
try {
  for (let i = 0; i < runs; i++) {
    for (const b of i % 2 ? ['base', 'cand'] : ['cand', 'base']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(() => {
        try { localStorage.setItem('mdr.previewEdit', '0'); } catch {}
        window.__lt = 0;
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch {}
      });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: !warm });
      if (warm) { await page.goto(`http://localhost:${P[b]}/?perf=1`); await page.waitForSelector('.cm-content', { timeout: 30000 }); await sleep(500); }
      if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      if (net) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (net * 1e6) / 8, uploadThroughput: (net * 1e6) / 8 });
      let js = 0, ready = false;
      const sizes = new Map();
      cdp.on('Network.responseReceived', (e) => { if (/javascript/.test(e.response.mimeType) || /\.js(\?|$)/.test(e.response.url)) sizes.set(e.requestId, 0); });
      cdp.on('Network.loadingFinished', (e) => { if (sizes.has(e.requestId) && !ready) js += e.encodedDataLength; });
      const t0 = Date.now();
      await page.goto(`http://localhost:${P[b]}/?perf=1`);
      await page.waitForSelector('.cm-content', { timeout: 30000 });
      const tEditor = Date.now() - t0;
      ready = true;
      await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 30000 });
      await page.evaluate(() => window.__mdr.waitIdle && window.__mdr.waitIdle());
      const tIdle = Date.now() - t0;
      const ltStart = await page.evaluate(() => Math.round(window.__lt));
      const openT = async (text, name) => page.evaluate(async ([t, n]) => {
        const s = performance.now();
        window.__mdr.app.loadText(t, n);
        await new Promise((r) => { const f = () => (document.querySelector('.mdr-preview .md-block > *') ? r() : requestAnimationFrame(f)); f(); });
        const first = performance.now() - s;
        await window.__mdr.waitIdle();
        return [Math.round(first), Math.round(performance.now() - s)];
      }, [text, name]);
      const small = await openT(SMALL, 'small.md');
      await sleep(300);
      const large = await openT(LARGE, 'large.md');
      res[b].push({ js, tEditor, tIdle, ltStart, smallFirst: small[0], smallIdle: small[1], largeFirst: large[0], largeIdle: large[1] });
      await ctx.close();
    }
  }
} finally {
  clearTimeout(wd);
  await browser.close();
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(`runs=${runs} cpu=${cpu} net=${net || 'none'}`);
for (const k of Object.keys(res.cand[0])) {
  const c = med(res.cand.map((r) => r[k])), b = med(res.base.map((r) => r[k]));
  console.log(`${k.padEnd(10)} cand ${String(c).padStart(8)}  base ${String(b).padStart(8)}  ratio ${(c / (b || 1)).toFixed(2)}   cand[${res.cand.map((r) => r[k]).join(',')}] base[${res.base.map((r) => r[k]).join(',')}]`);
}
process.exit(0);
