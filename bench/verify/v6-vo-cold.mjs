// bench/verify/v6-vo-cold.mjs — verify-off (0.2.0 stage 2f, round 5, N3 / RL-4): the cold start of a REAL USER (no
// ?perf=1, nothing stored, so 预览可编辑 off), candidate against 0.1.1, alternating runs in fresh contexts, cache off,
// optional network throttling (M Mbit/s down and up, 20 ms latency). Measures the time from navigation to .cm-content
// and to the first idle frame after it, the JS bytes received before the editor, and whether the editing chunk was asked
// for within 3 s after the editor. Timing-sensitive on a loaded machine: compare medians, not single runs.
//   node bench/verify/v6-vo-cold.mjs <candPort> <basePort> [runs=5] [--net M]
// Global timeout 115 s. Writes nothing.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const [pc, pb] = args;
const runs = Number(args[2] && /^\d+$/.test(args[2]) ? args[2] : 5);
const net = args.includes('--net') ? Number(args[args.indexOf('--net') + 1]) : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const browser = await chromium.launch({ headless: true });
const res = { cand: [], base: [] };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
try {
  for (let i = 0; i < runs; i++) {
    for (const b of i % 2 ? ['base', 'cand'] : ['cand', 'base']) {
      const port = b === 'cand' ? pc : pb;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (net) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (net * 1e6) / 8, uploadThroughput: (net * 1e6) / 8 });
      let js = 0, ready = false, chunk = 0;
      const sizes = new Set();
      cdp.on('Network.requestWillBeSent', (e) => { if (/inlineEdit-/.test(e.request.url)) chunk++; });
      cdp.on('Network.responseReceived', (e) => { if (/\.js(\?|$)/.test(e.response.url)) sizes.add(e.requestId); });
      cdp.on('Network.loadingFinished', (e) => { if (sizes.has(e.requestId) && !ready) js += e.encodedDataLength; });
      const t0 = Date.now();
      await page.goto(`http://localhost:${port}/`);
      await page.waitForSelector('.cm-content', { timeout: 30000 });
      const tEditor = Date.now() - t0;
      ready = true;
      await page.evaluate(() => new Promise((r) => requestIdleCallback(() => r(), { timeout: 3000 })));
      const tIdle = Date.now() - t0;
      await sleep(3000);
      res[b].push({ tEditor, tIdle, js, chunk });
      await ctx.close();
    }
  }
  for (const b of ['cand', 'base']) console.log(`${b}: tEditor median ${med(res[b].map((r) => r.tEditor))} [${res[b].map((r) => r.tEditor).join(',')}] tIdle median ${med(res[b].map((r) => r.tIdle))} js ${med(res[b].map((r) => r.js))} chunk requests ${res[b].map((r) => r.chunk).join(',')}`);
  console.log(`ratio tEditor ${(med(res.cand.map((r) => r.tEditor)) / med(res.base.map((r) => r.tEditor))).toFixed(2)} (net ${net || 'none'})`);
} finally {
  clearTimeout(KILL);
  await browser.close();
}
