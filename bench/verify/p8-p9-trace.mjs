// bench/verify/p8-p9-trace.mjs — P8 (preview wheel 20 screens) and P9 (editor PageDown ×100) on
// large.md under a Chromium trace: forced synchronous layouts (Layout events nested inside script
// events, not in the rendering pipeline) > 2 ms, longest main-thread tasks with attribution, and
// rAF frame gaps > 20 ms (rAF loop in the page). Complements p8-p9-scroll.mjs (follow checks).
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';
import { startTrace, stopTrace, tasksBetween, describeTask } from './trace.mjs';
import { readFileSync } from 'node:fs';

const { browser, page, errors } = await launch();
const SCRIPT_PARENTS = new Set(['FunctionCall', 'EventDispatch', 'FireAnimationFrame', 'RunMicrotasks', 'HandlePostMessage', 'TimerFire', 'v8.callFunction', 'ResizeObserver']);

/** Forced layouts: Layout / UpdateLayoutTree events that are inside a script event. */
function forcedLayouts(tracePath, from, to, pid, tid) {
  const ev = JSON.parse(readFileSync(tracePath, 'utf8')).traceEvents.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  const scripts = ev.filter((e) => SCRIPT_PARENTS.has(e.name)).sort((a, b) => a.ts - b.ts);
  const layouts = ev.filter((e) => (e.name === 'Layout' || e.name === 'UpdateLayoutTree') && e.ts / 1000 >= from && e.ts / 1000 < to);
  const forced = [];
  for (const l of layouts) {
    const host = scripts.find((s) => s.ts <= l.ts && s.ts + s.dur >= l.ts + l.dur);
    if (host) forced.push({ name: l.name, ms: l.dur / 1000, host: `${host.name}${host.args?.data?.type ? '(' + host.args.data.type + ')' : ''}${host.args?.data?.functionName ? '(' + host.args.data.functionName + ')' : ''}`, stack: l.args?.beginData?.stackTrace?.[0]?.functionName ?? '' });
  }
  return forced;
}

try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await sleep(500);
  const pv = await page.locator('.mdr-preview').boundingBox();
  const ed = await page.locator('.cm-scroller').boundingBox();
  const H = await page.evaluate(() => window.__mdr.app.preview.el.clientHeight);
  const tracePath = new URL('./.trace-p8.json', import.meta.url).pathname;

  // ---- P8 preview wheel 20 screens (5 ticks per screen)
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.evaluate(() => window.__probeFrames(true));
  await resetProbe(page);
  await startTrace(browser, page, tracePath);
  await page.evaluate(() => performance.mark('vt:p8-start'));
  for (let s = 0; s < 20; s++) for (let k = 0; k < 5; k++) { await page.mouse.wheel(0, H / 5); await sleep(16); }
  await sleep(700);
  await page.evaluate(() => performance.mark('vt:p8-end'));
  const tr8 = await stopTrace(browser);
  await page.evaluate(() => window.__probeFrames(false));
  const p8 = await readProbe(page);
  const [a8, b8] = [tr8.marks['vt:p8-start'][0], tr8.marks['vt:p8-end'][0]];
  const t8 = tasksBetween(tr8.tasks, a8, b8);
  const f8 = forcedLayouts(tracePath, a8, b8, tr8.pid, tr8.tid);
  const frames8 = p8.frames; const g8 = []; for (let i = 1; i < frames8.length; i++) g8.push(frames8[i] - frames8[i - 1]);
  const slow8 = g8.filter((g) => g > 20);
  console.log(`[P8 trace] tasks ${t8.length}; top: ${[...t8].sort((x, y) => y.dur - x.dur).slice(0, 5).map(describeTask).join(' | ')}`);
  console.log(`[P8 trace] forced layouts inside script: ${f8.length} (>2 ms: ${f8.filter((f) => f.ms > 2).length}) ${f8.filter((f) => f.ms > 0.5).slice(0, 8).map((f) => `${f.name} ${f.ms.toFixed(1)} in ${f.host} ${f.stack}`).join('; ')}`);
  console.log(`[P8 trace] rAF frames ${g8.length}, >20 ms ${slow8.length} (max ${fmt(max(g8))}), long tasks ${p8.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
  report('P8 forced synchronous layouts > 2 ms during preview wheel', `${f8.filter((f) => f.ms > 2).length}`, '0', f8.filter((f) => f.ms > 2).length === 0);
  report('P8 frames > 20 ms (rAF gaps, traced run)', `${(100 * slow8.length / Math.max(1, g8.length)).toFixed(1)} % (${slow8.length}/${g8.length}, max ${fmt(max(g8))} ms)`, '< 3 %', slow8.length / Math.max(1, g8.length) < 0.03);
  report('P8 longest main-thread task during wheel', `${fmt(max(t8.map((t) => t.dur)))} ms`, '(info; frame budget 20 ms)', max(t8.map((t) => t.dur)) < 50);

  // ---- P9 editor PageDown x100
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__mdr.app.editor.focus(); });
  await sleep(800);
  await page.mouse.move(ed.x + ed.width / 2, ed.y + ed.height / 2);
  const tracePath9 = new URL('./.trace-p9.json', import.meta.url).pathname;
  await page.evaluate(() => window.__probeFrames(true));
  await resetProbe(page);
  await startTrace(browser, page, tracePath9);
  await page.evaluate(() => performance.mark('vt:p9-start'));
  for (let i = 0; i < 100; i++) { await page.keyboard.press('PageDown'); await sleep(30); }
  await sleep(700);
  await page.evaluate(() => performance.mark('vt:p9-end'));
  const tr9 = await stopTrace(browser);
  await page.evaluate(() => window.__probeFrames(false));
  const p9 = await readProbe(page);
  const [a9, b9] = [tr9.marks['vt:p9-start'][0], tr9.marks['vt:p9-end'][0]];
  const t9 = tasksBetween(tr9.tasks, a9, b9);
  const f9 = forcedLayouts(tracePath9, a9, b9, tr9.pid, tr9.tid);
  const frames9 = p9.frames; const g9 = []; for (let i = 1; i < frames9.length; i++) g9.push(frames9[i] - frames9[i - 1]);
  const slow9 = g9.filter((g) => g > 20);
  const st9 = await page.evaluate(() => ({ e: window.__mdr.app.editor.topVisible().line, p: window.__mdr.app.preview.topVisible().line }));
  console.log(`\n[P9 trace] tasks ${t9.length}; top: ${[...t9].sort((x, y) => y.dur - x.dur).slice(0, 5).map(describeTask).join(' | ')}`);
  console.log(`[P9 trace] forced layouts inside script: ${f9.length} (>2 ms: ${f9.filter((f) => f.ms > 2).length}) ${f9.filter((f) => f.ms > 0.5).slice(0, 8).map((f) => `${f.name} ${f.ms.toFixed(1)} in ${f.host} ${f.stack}`).join('; ')}`);
  console.log(`[P9 trace] rAF frames ${g9.length}, >20 ms ${slow9.length} (max ${fmt(max(g9))}), long tasks ${p9.longTasks.map((x) => x.dur.toFixed(0)).join(',') || 'none'}; end editor top ${st9.e} preview top ${st9.p}`);
  report('P9 forced synchronous layouts > 2 ms during PageDown x100', `${f9.filter((f) => f.ms > 2).length}`, '0', f9.filter((f) => f.ms > 2).length === 0);
  report('P9 frames > 20 ms (rAF gaps, traced run)', `${(100 * slow9.length / Math.max(1, g9.length)).toFixed(1)} % (${slow9.length}/${g9.length}, max ${fmt(max(g9))} ms)`, '< 3 %', slow9.length / Math.max(1, g9.length) < 0.03);
  report('P9 longest main-thread task during PageDown', `${fmt(max(t9.map((t) => t.dur)))} ms`, '(info; frame budget 20 ms)', max(t9.map((t) => t.dur)) < 50);
} finally {
  dumpErrors(errors);
  await browser.close();
}
