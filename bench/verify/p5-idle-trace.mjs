// bench/verify/p5-idle-trace.mjs — control for p5-trace.mjs: the SAME trace-based "main busy per
// 100 ms window" measurement on the same document with the cursor in the same place, but with NO
// typing. Whatever this reports is tracing/compositor/blinking-caret overhead, not keystroke cost.
// Usage: node bench/verify/p5-idle-trace.mjs [large|huge] [seconds]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const which = process.argv[2] ?? 'large';
const SECONDS = Number(process.argv[3] ?? 8);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : Math.floor(src.length / 2);
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1500);
  await page.evaluate(() => performance.mark('vstart'));
  const tracePath = new URL('./.trace-idle.json', import.meta.url).pathname;
  await browser.startTracing(page, { path: tracePath, screenshots: false, categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'blink'] });
  await sleep(500);
  await page.evaluate(() => performance.mark('vkey'));
  await sleep(SECONDS * 1000);
  const buf = await browser.stopTracing();
  const ev = JSON.parse(buf.toString()).traceEvents;
  const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === 'vkey');
  if (!marks.length) throw new Error('no vkey mark in trace');
  const { pid, tid } = marks[0];
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  const rawTasks = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  const spans = rawTasks.map((e) => [e.ts, e.ts + e.dur]).sort((a, b) => a[0] - b[0]);
  const busy = [];
  for (const [a, b] of spans) {
    const last = busy[busy.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else busy.push([a, b]);
  }
  const t0 = marks[0].ts, t1 = t0 + SECONDS * 1e6;
  const win = [];
  for (let s = t0; s + 100000 <= t1; s += 100000) {
    let w = 0;
    for (const [a, b] of busy) { const x = Math.max(a, s), y = Math.min(b, s + 100000); if (y > x) w += y - x; }
    win.push(w / 1000);
  }
  const durs = rawTasks.filter((t) => t.ts >= t0 && t.ts < t1).map((t) => t.dur / 1000);
  console.log(`[idle-trace ${which}] windows=${win.length} busy per 100 ms: p50 ${fmt(pct(win, 50))} p95 ${fmt(pct(win, 95))} max ${fmt(max(win))} ms`);
  console.log(`[idle-trace ${which}] tasks in window: ${durs.length}, longest ${fmt(max(durs))} ms, >5 ms ${durs.filter((d) => d > 5).length}`);
} finally {
  dumpErrors(errors);
  await browser.close();
}
