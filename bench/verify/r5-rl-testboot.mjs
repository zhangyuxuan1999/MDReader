// bench/verify/r5-rl-testboot.mjs — review-lazy (0.2.0 stage 2f, rule L5): what the test-mode boot wait costs. Opens
// http://localhost:<port>/?perf=1 with NOTHING stored (test mode: the switch defaults on, so the prototype's boot
// awaits the editing chunk before it builds the app) on two production builds, alternating, cache off, and prints the
// medians of: ms to .cm-content, ms to window.__mdr, the mdr:* performance marks the app sets.
//   node bench/verify/r5-rl-testboot.mjs <portA> <portB> [runs=5] [--net <Mbit/s>]
// Starts no server, writes nothing. Global timeout 110 s.
import { chromium } from '@playwright/test';
const [pa, pb] = [process.argv[2], process.argv[3]];
const runs = Number(process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : 5);
const ni = process.argv.indexOf('--net'); const net = ni > 0 ? Number(process.argv[ni + 1]) : 0;
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const b = await chromium.launch({ headless: true });
const res = { [pa]: [], [pb]: [] };
try {
  for (let i = 0; i < runs; i++) {
    for (const port of i % 2 ? [pb, pa] : [pa, pb]) {
      const ctx = await b.newContext();
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (net) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: net * 1e6 / 8, uploadThroughput: net * 1e6 / 8 });
      const t0 = Date.now();
      await page.goto(`http://localhost:${port}/?perf=1`);
      await page.waitForSelector('.cm-content', { timeout: 30000 });
      const tEditor = Date.now() - t0;
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
      const tHooks = Date.now() - t0;
      const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('mdr:')).map((m) => [m.name, Math.round(m.startTime)])));
      res[port].push({ tEditor, tHooks, ...marks });
      await ctx.close();
    }
  }
  const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const keys = [...new Set(Object.values(res).flat().flatMap((r) => Object.keys(r)))];
  for (const k of keys) console.log(k.padEnd(18), `${pa}: ${med(res[pa].map((r) => r[k]))} [${res[pa].map((r) => r[k]).join(',')}]`, ` ${pb}: ${med(res[pb].map((r) => r[k]))} [${res[pb].map((r) => r[k]).join(',')}]`);
} finally { clearTimeout(KILL); await b.close(); }
