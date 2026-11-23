// bench/verify/p5-marginal.mjs — separates the FIXED per-frame rendering cost from the MARGINAL
// per-keystroke cost. Traces typing at several inter-key delays on the same document/position and
// reports total renderer main-thread busy time during the burst divided by the number of keys.
// When keys are 100 ms apart each key gets its own frame, so the per-key figure carries a whole
// frame of style/layout/paint; at 15 ms several keys share a frame and the quotient converges to
// the true marginal cost.
// Usage: node bench/verify/p5-marginal.mjs [large|small] [chars]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt, pct, max, report } from './common.mjs';

const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 150);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : Math.floor(src.length / 2);
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;
const CATS = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'blink'];

const { browser, page, errors } = await launch();

function busyOf(buf) {
  const ev = JSON.parse(buf.toString()).traceEvents;
  const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && (e.name === 'vkey' || e.name === 'vstart'));
  if (!marks.length) throw new Error('no marks');
  const { pid, tid } = marks[0];
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  const raw = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  const spans = raw.map((e) => [e.ts, e.ts + e.dur]).sort((a, b) => a[0] - b[0]);
  const busy = [];
  for (const [a, b] of spans) {
    const last = busy[busy.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else busy.push([a, b]);
  }
  const seen = new Set();
  const tasks = raw.filter((e) => { const k = `${e.ts}:${e.dur}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const keys = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === 'vkey').map((e) => e.ts).sort((a, b) => a - b);
  return { busy, tasks, keys, main };
}
const sumBusy = (busy, from, to) => { let w = 0; for (const [a, b] of busy) { const s = Math.max(a, from), e = Math.min(b, to); if (e > s) w += e - s; } return w / 1000; };

try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1200);
  await page.evaluate(() => window.addEventListener('keydown', () => performance.mark('vkey'), true));

  // idle rate (ms busy per second, no input)
  await browser.startTracing(page, { path: new URL('./.trace-m-idle.json', import.meta.url).pathname, screenshots: false, categories: CATS });
  await sleep(200);
  await page.evaluate(() => performance.mark('vstart'));
  const iStart = Date.now();
  await sleep(5000);
  const idleBuf = await browser.stopTracing();
  const idle = busyOf(idleBuf);
  const iSpanFrom = Math.min(...idle.busy.map((b) => b[0])), iSpanTo = Math.max(...idle.busy.map((b) => b[1]));
  const idleRate = sumBusy(idle.busy, iSpanFrom, iSpanTo) / ((iSpanTo - iSpanFrom) / 1e6); // ms busy per second
  console.log(`[marginal] idle busy rate: ${fmt(idleRate)} ms/s (${fmt(idleRate / 10)} % of the main thread)`);

  const rows = [];
  for (const delay of [100, 50, 30, 15, 8]) {
    await sleep(1200);
    await browser.startTracing(page, { path: new URL(`./.trace-m-${delay}.json`, import.meta.url).pathname, screenshots: false, categories: CATS });
    await sleep(300);
    const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
    await page.keyboard.type(text, { delay });
    await sleep(300);
    const buf = await browser.stopTracing();
    const { busy, tasks, keys } = busyOf(buf);
    if (keys.length < CHARS * 0.9) { console.log(`[marginal ${delay}ms] only ${keys.length} key marks, skipping`); continue; }
    const from = keys[0], to = keys[keys.length - 1] + delay * 1000;
    const total = sumBusy(busy, from, to);
    const span = (to - from) / 1e6;
    const perKey = total / keys.length;
    const perKeyAdj = (total - idleRate * span) / keys.length;
    const inWin = tasks.filter((t) => t.ts >= from && t.ts < to).map((t) => t.dur / 1000);
    console.log(`[marginal ${String(delay).padStart(3)}ms] keys ${keys.length}, span ${fmt(span * 1000)} ms, main busy ${fmt(total)} ms (${fmt(100 * total / (span * 1000))} % of wall) → ${fmt(perKey)} ms/key (idle-adjusted ${fmt(perKeyAdj)}); longest task ${fmt(max(inWin))} ms, tasks>10ms ${inWin.filter((d) => d > 10).length}`);
    rows.push({ delay, perKey, perKeyAdj, longest: max(inWin) });
  }
  const fastest = rows[rows.length - 1];
  if (fastest) {
    report(`P5 marginal main-thread cost per keystroke (${fastest.delay} ms spacing, ${which}.md)`, `${fmt(fastest.perKeyAdj)} ms`, '< 5 ms', fastest.perKeyAdj < 5);
    report(`P5 longest single main-thread task while typing (${fastest.delay} ms spacing)`, `${fmt(fastest.longest)} ms`, '< 10 ms', fastest.longest < 10);
  }
} finally {
  dumpErrors(errors);
  await browser.close();
}
