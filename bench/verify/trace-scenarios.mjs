// bench/verify/trace-scenarios.mjs — exact renderer-main-thread accounting (Chromium trace, RunTask
// durations) per keystroke/step for the typing-shaped scenarios:
//   large      P5  type N chars mid large.md (line ≈ 50000, plain paragraph)
//   huge       P5' same on huge.md
//   fence300   P6  type inside a 300-line ts fence (doc built via __mdr.loadText)
//   fence5000  P6  type inside a 5000-line ts fence
//   undo       P11 50 separate edits, then undo ×50 / redo ×50 (per-step accounting)
//   giantclose P7  large.md with "~~~~" fence opened at line 1 (untraced), then traced: type
//                  " xyz" inside + close it with "~~~~\n" at line 2 → input→paint latency per key
// Per key window (keydown → next keydown): sum of RunTask time, longest task, breakdown by trace
// event, and keydown → end of first Paint/Commit after it ("input→paint").
// Usage: node bench/verify/trace-scenarios.mjs <scenario> [chars] [delayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt, pct, max, report } from './common.mjs';

const scenario = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 100);
const DELAY = Number(process.argv[4] ?? 100);
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
const pickLine = (which) => {
  const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
  let t = which === 'large' ? 50000 : Math.floor(src.length / 2);
  while (t < src.length && !(isProse(src[t - 1]) && src[t - 2] === '' && src[t] === '')) t++;
  return t;
};
const makeFenceDoc = (fenceLines) => {
  const paras = (n, p) => Array.from({ length: n }, (_, i) => `段落 ${p}-${i} 这是一些中文文本 with some English words, line ${i}.\n`).join('\n');
  const fence = '```ts\n' + Array.from({ length: fenceLines }, (_, i) => `export function fn${i}(a: number, b: string): string { return b + a * ${i}; } // line ${i}`).join('\n') + '\n```\n';
  return `# Fence test ${fenceLines}\n\n${paras(200, 'a')}\n${fence}\n${paras(200, 'b')}`;
};
const typedText = (n) => Array.from({ length: n }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');

const { browser, page, errors } = await launch();
const tracePath = new URL(`./.trace-${scenario}.json`, import.meta.url).pathname;
const CATS = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'blink'];
const NAMES = ['EventDispatch', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'RunMicrotasks', 'HitTest', 'HandlePostMessage'];

async function loadDoc() {
  if (scenario === 'large' || scenario === 'huge' || scenario === 'undo' || scenario === 'giantclose') {
    const which = scenario === 'huge' ? 'huge' : 'large';
    await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    await waitFirstVisible(page, 120_000);
    await waitIdle(page);
    return pickLine(which);
  }
  const n = scenario === 'fence300' ? 300 : 5000;
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await page.evaluate((t) => window.__mdr.loadText(t, `fence${t.length}.md`), makeFenceDoc(n));
  await waitFirstVisible(page, 60_000);
  await waitIdle(page);
  return 2 + 200 * 2 + 1 + Math.floor(n / 2);
}

function analyse(ev, delayMs, label) {
  const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === 'vkey');
  if (!marks.length) throw new Error('no vkey marks in trace');
  const { pid, tid } = marks[0];
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  // Chromium emits the same top-level task as both 'ThreadControllerImpl::RunTask' and a nested
  // 'RunTask' — keep exactly one of the two names so busy time is not double-counted.
  let tasks = main.filter((e) => e.name === 'ThreadControllerImpl::RunTask');
  if (!tasks.length) tasks = main.filter((e) => e.name === 'RunTask');
  const paints = main.filter((e) => e.name === 'Paint' || e.name === 'Commit');
  const keyTs = marks.map((m) => m.ts).sort((a, b) => a - b);
  const perKey = [], perKeyMaxTask = [], inputToPaint = [], perKeyBreak = [];
  for (let i = 0; i < keyTs.length; i++) {
    const from = keyTs[i], to = i + 1 < keyTs.length ? keyTs[i + 1] : from + delayMs * 1000;
    let busy = 0, mt = 0;
    for (const t of tasks) { const s = Math.max(t.ts, from), e = Math.min(t.ts + t.dur, to); if (e > s) { busy += e - s; mt = Math.max(mt, t.dur); } }
    perKey.push(busy / 1000); perKeyMaxTask.push(mt / 1000);
    const p = paints.find((x) => x.ts >= from);
    if (p) inputToPaint.push((p.ts + p.dur - from) / 1000);
    const br = {}; for (const e of main) if (e.ts >= from && e.ts < to && NAMES.includes(e.name)) br[e.name] = (br[e.name] ?? 0) + e.dur / 1000;
    perKeyBreak.push(br);
  }
  const agg = {}; for (const br of perKeyBreak) for (const k in br) agg[k] = (agg[k] ?? 0) + br[k] / perKeyBreak.length;
  const tasksIn = tasks.filter((t) => t.ts >= keyTs[0] && t.ts < keyTs.at(-1) + delayMs * 1000).map((t) => t.dur / 1000);
  console.log(`\n[${label}] keys=${keyTs.length} tasks in window=${tasksIn.length}`);
  console.log(`[${label}] main busy per key (RunTask sum): p50 ${fmt(pct(perKey, 50))} p95 ${fmt(pct(perKey, 95))} max ${fmt(max(perKey))} ms`);
  console.log(`[${label}] longest task per key: p50 ${fmt(pct(perKeyMaxTask, 50))} p95 ${fmt(pct(perKeyMaxTask, 95))} max ${fmt(max(perKeyMaxTask))} ms`);
  console.log(`[${label}] keydown → end of next paint/commit: p50 ${fmt(pct(inputToPaint, 50))} p95 ${fmt(pct(inputToPaint, 95))} max ${fmt(max(inputToPaint))} ms (n=${inputToPaint.length})`);
  console.log(`[${label}] tasks > 5 ms: ${tasksIn.filter((d) => d > 5).length}, > 10 ms: ${tasksIn.filter((d) => d > 10).length}, > 16 ms: ${tasksIn.filter((d) => d > 16).length}, > 50 ms: ${tasksIn.filter((d) => d > 50).length}, > 100 ms: ${tasksIn.filter((d) => d > 100).length}`);
  console.log(`[${label}] mean per-key breakdown (ms, nested events overlap): ${Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
  const long = tasks.filter((t) => t.ts >= keyTs[0]).sort((a, b) => b.dur - a.dur).slice(0, 4);
  for (const t of long) {
    const kids = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && NAMES.includes(e.name)).sort((a, b) => b.dur - a.dur).slice(0, 6);
    console.log(`   task ${(t.dur / 1000).toFixed(1)} ms: ${kids.map((k) => `${k.name}${k.args?.data?.type ? '(' + k.args.data.type + ')' : ''} ${(k.dur / 1000).toFixed(1)}`).join(', ')}`);
  }
  return { perKey, perKeyMaxTask, inputToPaint, tasksIn };
}

try {
  await warmUp(page);
  const line = await loadDoc();
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), line);
  await sleep(1000);
  // mark only "real" keys (a-z, space, Enter, ~) so Meta/Shift/Arrow presses do not split windows
  await page.evaluate(() => window.addEventListener('keydown', (e) => { if (e.key.length === 1 || e.key === 'Enter') performance.mark('vkey'); }, true));
  const results = [];
  if (scenario === 'undo') {
    for (let i = 0; i < 50; i++) { await page.keyboard.type(String.fromCharCode(97 + (i % 26))); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await sleep(40); }
    await sleep(1000);
    const v0 = await page.evaluate(() => window.__mdr.version());
    for (const [label, key] of [['P11 undo x50', 'Meta+z'], ['P11 redo x50', 'Meta+Shift+z']]) {
      await browser.startTracing(page, { path: tracePath, screenshots: false, categories: CATS });
      await sleep(300);
      for (let i = 0; i < 50; i++) { await page.keyboard.press(key); await sleep(DELAY); }
      await sleep(500);
      const buf = await browser.stopTracing();
      const r = analyse(JSON.parse(buf.toString()).traceEvents, DELAY, label);
      results.push(...r.perKey);
      const v = await page.evaluate(() => window.__mdr.version());
      console.log(`[${label}] version ${v0} → ${v}`);
    }
    report('P11(trace) main busy per undo/redo step p95', `${fmt(pct(results, 95))} ms (max ${fmt(max(results))})`, '< 5 ms', pct(results, 95) < 5);
  } else if (scenario === 'giantclose') {
    await page.evaluate(() => window.__mdr.app.editor.gotoLine(1, 0));
    await sleep(300);
    await page.keyboard.type('~~~~\n', { delay: 150 });
    await sleep(2500);
    const st = await page.evaluate(() => ({ blocks: window.__mdr.app.preview.blockCount(), pre: document.querySelector('.md-block pre')?.className }));
    console.log(`[giantclose] after opening ~~~~: ${JSON.stringify(st)}`);
    await browser.startTracing(page, { path: tracePath, screenshots: false, categories: CATS });
    await sleep(300);
    await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 100000));
    await sleep(300);
    await page.keyboard.type(' xyz', { delay: 300 });
    await sleep(1500);
    await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0));
    await sleep(300);
    await page.keyboard.type('~~~~\n', { delay: 300 });
    await sleep(2500);
    const buf = await browser.stopTracing();
    const r = analyse(JSON.parse(buf.toString()).traceEvents, 300, 'P7 type inside giant + close');
    const st2 = await page.evaluate(() => ({ blocks: window.__mdr.app.preview.blockCount() }));
    console.log(`[giantclose] after closing: ${JSON.stringify(st2)}`);
    report('P7(trace) keydown → paint p95', `${fmt(pct(r.inputToPaint, 95))} ms (max ${fmt(max(r.inputToPaint))})`, '< 16 ms', pct(r.inputToPaint, 95) < 16);
    report('P7(trace) tasks > 100 ms', `${r.tasksIn.filter((d) => d > 100).length}`, '≤ 1', r.tasksIn.filter((d) => d > 100).length <= 1);
  } else {
    await browser.startTracing(page, { path: tracePath, screenshots: false, categories: CATS });
    await sleep(500);
    await page.keyboard.type(typedText(CHARS), { delay: DELAY });
    await sleep(500);
    const buf = await browser.stopTracing();
    const r = analyse(JSON.parse(buf.toString()).traceEvents, DELAY, `${scenario} line ${line}`);
    const target = scenario === 'fence300' ? 8 : scenario === 'fence5000' ? 16 : 5;
    const name = scenario.startsWith('fence') ? `P6 ${scenario}` : `P5 ${scenario}`;
    report(`${name}(trace) main busy per keystroke p95`, `${fmt(pct(r.perKey, 95))} ms`, `< ${target} ms`, pct(r.perKey, 95) < target);
    if (!scenario.startsWith('fence')) report(`${name}(trace) main busy per keystroke max`, `${fmt(max(r.perKey))} ms`, '< 10 ms', max(r.perKey) < 10);
  }
} finally {
  dumpErrors(errors);
  await browser.close();
}
