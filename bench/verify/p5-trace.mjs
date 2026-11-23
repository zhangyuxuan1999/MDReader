// bench/verify/p5-trace.mjs — second opinion on P5 via a Chromium trace: exact renderer main-thread
// RunTask durations per keystroke window, with a rough breakdown (script vs style/layout/paint).
// Usage: node bench/verify/p5-trace.mjs [large|huge|small] [chars] [delayMs] [line]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt, pct, max, report } from './common.mjs';

const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 60);
const DELAY = Number(process.argv[4] ?? 100);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = Number(process.argv[5] ?? (which === 'large' ? 50000 : Math.floor(src.length / 2)));
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
if (!process.argv[5]) while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1000);
  await page.evaluate(() => window.addEventListener('keydown', () => performance.mark('vkey'), true));
  const tracePath = new URL('../../bench/verify/.trace.json', import.meta.url).pathname;
  await browser.startTracing(page, { path: tracePath, screenshots: false, categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'disabled-by-default-v8.cpu_profiler'.replace('disabled-by-default-v8.cpu_profiler', 'blink')] });
  await sleep(500);
  const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  await page.keyboard.type(text, { delay: DELAY });
  await sleep(500);
  const buf = await browser.stopTracing();
  const ev = JSON.parse(buf.toString()).traceEvents;
  // renderer main thread = thread with the 'vkey' user timing marks
  const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === 'vkey');
  if (!marks.length) throw new Error('no vkey marks in trace');
  const { pid, tid } = marks[0];
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  // Chromium emits the SAME top-level task under both names ('RunTask' and 'ThreadControllerImpl::RunTask');
  // summing both double-counted every busy interval (3028 identical-ts pairs in a 60-key run, p95 36.7 →
  // 19.9 ms). Take the union of the intervals instead, and keep the per-task list de-duplicated.
  const rawTasks = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask');
  const spans = rawTasks.map((e) => [e.ts, e.ts + e.dur]).sort((a, b) => a[0] - b[0]);
  const busySpans = [];
  for (const [a, b] of spans) {
    const last = busySpans[busySpans.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else busySpans.push([a, b]);
  }
  const seen = new Set();
  const tasks = rawTasks.filter((e) => { const k = `${e.ts}:${e.dur}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const keyTs = marks.map((m) => m.ts).sort((a, b) => a - b);
  const NAMES = ['EventDispatch', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RunMicrotasks', 'HitTest', 'ScheduleStyleRecalculation', 'HandlePostMessage', 'v8.callFunction', 'v8.run'];
  const perKey = [], perKeyMaxTask = [], perKeyBreak = [];
  for (let i = 0; i < keyTs.length; i++) {
    const from = keyTs[i], to = i + 1 < keyTs.length ? keyTs[i + 1] : from + DELAY * 1000;
    let busy = 0, mt = 0;
    for (const [a, b] of busySpans) { const s = Math.max(a, from), e = Math.min(b, to); if (e > s) busy += e - s; }
    // Only tasks that START in this window belong to this keystroke (a task straddling the first mark was
    // caused by the settle before typing began).
    for (const t of tasks) if (t.ts >= from && t.ts < to) mt = Math.max(mt, t.dur);
    perKey.push(busy / 1000); perKeyMaxTask.push(mt / 1000);
    const br = {};
    for (const e of main) { if (e.ts >= from && e.ts < to && NAMES.includes(e.name)) br[e.name] = (br[e.name] ?? 0) + e.dur / 1000; }
    perKeyBreak.push(br);
  }
  const agg = {}; for (const br of perKeyBreak) for (const k in br) agg[k] = (agg[k] ?? 0) + br[k] / perKeyBreak.length;
  const tasksIn = tasks.filter((t) => t.ts >= keyTs[0] && t.ts < keyTs.at(-1) + DELAY * 1000).map((t) => t.dur / 1000);
  console.log(`[trace ${which} line ${target}] keys=${keyTs.length} tasks in window=${tasksIn.length}`);
  console.log(`[trace] main busy per key (RunTask sum): p50 ${fmt(pct(perKey, 50))} p95 ${fmt(pct(perKey, 95))} max ${fmt(max(perKey))} ms`);
  console.log(`[trace] longest task per key: p50 ${fmt(pct(perKeyMaxTask, 50))} p95 ${fmt(pct(perKeyMaxTask, 95))} max ${fmt(max(perKeyMaxTask))} ms`);
  console.log(`[trace] tasks > 5 ms: ${tasksIn.filter((d) => d > 5).length}, > 10 ms: ${tasksIn.filter((d) => d > 10).length}, > 16 ms: ${tasksIn.filter((d) => d > 16).length}, > 50 ms: ${tasksIn.filter((d) => d > 50).length}`);
  console.log(`[trace] mean per-key breakdown (ms, nested events overlap): ${Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
  // top-10 longest tasks with their dominant children
  const long = tasks.filter((t) => t.ts >= keyTs[0]).sort((a, b) => b.dur - a.dur).slice(0, 5);
  for (const t of long) {
    const kids = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && NAMES.includes(e.name)).sort((a, b) => b.dur - a.dur).slice(0, 6);
    console.log(`  task ${(t.dur / 1000).toFixed(1)} ms: ${kids.map((k) => `${k.name}${k.args?.data?.type ? '(' + k.args.data.type + ')' : ''} ${(k.dur / 1000).toFixed(1)}`).join(', ')}`);
  }
  report('P5(trace) main busy per keystroke p95', `${fmt(pct(perKey, 95))} ms`, '< 5 ms', pct(perKey, 95) < 5);
  report('P5(trace) main busy per keystroke max', `${fmt(max(perKey))} ms`, '< 10 ms', max(perKey) < 10);
} finally {
  dumpErrors(errors);
  await browser.close();
}
