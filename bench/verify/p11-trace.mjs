// bench/verify/p11-trace.mjs — P11 measured from a Chromium trace (no MessageChannel monitor, which
// inflates the number): undo ×50 then redo ×50 on large.md after typing 50 chars at line ≈ 50000.
// Reports, per step: total renderer main-thread busy time and the longest single task, plus an
// idle baseline measured the same way. Also P12 (mode ×20, theme ×20) longest task from the trace.
// Usage: node bench/verify/p11-trace.mjs
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const src = readFileSync(new URL('../../test-data/large.md', import.meta.url), 'utf8').split('\n');
let target = 50000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();

function analyse(buf, label, stepMarks, windowUs) {
  const ev = JSON.parse(buf.toString()).traceEvents;
  const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === stepMarks);
  if (!marks.length) throw new Error(`no ${stepMarks} marks`);
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
  // A shortcut press emits several keydowns (Meta, Shift, z) microseconds apart; collapse marks that
  // are closer together than 50 ms so one window == one user-visible step.
  const ts = [];
  for (const t of marks.map((m) => m.ts).sort((a, b) => a - b)) if (!ts.length || t - ts[ts.length - 1] > 50000) ts.push(t);
  const per = [], perMax = [];
  for (let i = 0; i < ts.length; i++) {
    const from = ts[i], to = i + 1 < ts.length ? Math.min(ts[i + 1], from + windowUs) : from + windowUs;
    let w = 0, mt = 0;
    for (const [a, b] of busy) { const s = Math.max(a, from), e = Math.min(b, to); if (e > s) w += e - s; }
    for (const t of tasks) if (t.ts >= from && t.ts < to) mt = Math.max(mt, t.dur);
    per.push(w / 1000); perMax.push(mt / 1000);
  }
  console.log(`[${label}] steps=${per.length}  busy/step: p50 ${fmt(pct(per, 50))} p95 ${fmt(pct(per, 95))} max ${fmt(max(per))} ms; longest single task/step: p50 ${fmt(pct(perMax, 50))} p95 ${fmt(pct(perMax, 95))} max ${fmt(max(perMax))} ms`);
  return { per, perMax };
}

const CATS = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'v8.execute', 'blink'];

try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(800);
  await page.keyboard.type('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwx', { delay: 60 });
  await sleep(1500);
  await waitIdle(page).catch(() => {});
  await sleep(500);

  // ---- idle baseline with the same trace-based metric
  await browser.startTracing(page, { path: new URL('./.trace-p11-idle.json', import.meta.url).pathname, screenshots: false, categories: CATS });
  await sleep(300);
  for (let i = 0; i < 50; i++) { await page.evaluate(() => performance.mark('vstep')); await sleep(100); }
  const base = analyse(await browser.stopTracing(), 'P11 idle baseline (no input, 100 ms windows)', 'vstep', 100000);

  // ---- undo x50
  await page.evaluate(() => window.addEventListener('keydown', () => performance.mark('vstep'), true));
  await browser.startTracing(page, { path: new URL('./.trace-p11-undo.json', import.meta.url).pathname, screenshots: false, categories: CATS });
  await sleep(300);
  for (let i = 0; i < 50; i++) { await page.keyboard.press('Meta+z'); await sleep(100); }
  await sleep(400);
  const undo = analyse(await browser.stopTracing(), 'P11 undo x50', 'vstep', 100000);

  await sleep(800);
  await browser.startTracing(page, { path: new URL('./.trace-p11-redo.json', import.meta.url).pathname, screenshots: false, categories: CATS });
  await sleep(300);
  for (let i = 0; i < 50; i++) { await page.keyboard.press('Meta+Shift+z'); await sleep(100); }
  await sleep(400);
  const redo = analyse(await browser.stopTracing(), 'P11 redo x50', 'vstep', 100000);

  const all = [...undo.per, ...redo.per];
  const allMax = [...undo.perMax, ...redo.perMax];
  report('P11 baseline-only busy per 100 ms window p95 (control)', `${fmt(pct(base.per, 95))} ms`, '(context)', true);
  report('P11 main busy per undo/redo step p95 (trace)', `${fmt(pct(all, 95))} ms`, '< 5 ms', pct(all, 95) < 5);
  report('P11 longest single task per undo/redo step p95 (trace)', `${fmt(pct(allMax, 95))} ms (max ${fmt(max(allMax))})`, '< 5 ms', pct(allMax, 95) < 5);

  // ---- P12 mode x20 / theme x20 from a trace
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await sleep(300);
  await browser.startTracing(page, { path: new URL('./.trace-p12.json', import.meta.url).pathname, screenshots: false, categories: CATS });
  await sleep(300);
  for (let i = 0; i < 20; i++) { await page.evaluate(() => performance.mark('vstep')); await page.keyboard.press('Meta+/'); await sleep(200); }
  await sleep(400);
  const mode = analyse(await browser.stopTracing(), 'P12 mode switch x20', 'vstep', 200000);
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(500);
  await browser.startTracing(page, { path: new URL('./.trace-p12t.json', import.meta.url).pathname, screenshots: false, categories: CATS });
  await sleep(300);
  for (let i = 0; i < 20; i++) { await page.evaluate(() => performance.mark('vstep')); await page.keyboard.press('Meta+Shift+l'); await sleep(200); }
  await sleep(400);
  const theme = analyse(await browser.stopTracing(), 'P12 theme toggle x20', 'vstep', 200000);
  report('P12 mode switch x20 longest task (trace)', `${fmt(max(mode.perMax))} ms`, '< 50 ms', max(mode.perMax) < 50);
  report('P12 theme toggle x20 longest task (trace)', `${fmt(max(theme.perMax))} ms`, '< 50 ms', max(theme.perMax) < 50);
} finally {
  dumpErrors(errors);
  await browser.close();
}
