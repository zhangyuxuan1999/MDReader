// bench/verify/p8-diagnose.mjs — diagnose the ~100 ms frames seen during preview wheel scrolling
// (P8). Part A: wheel 10 screens in mode=preview (editor hidden, sync off) vs mode=split, recording
// LoAF phase fields (renderStart / styleAndLayoutStart / duration / blocking / scripts). Part B: a
// Chromium trace during 5 screens of wheel in split mode, summing Layout / UpdateLayoutTree /
// PrePaint / Paint / FunctionCall / FireAnimationFrame per frame and printing the biggest frames.
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const { browser, page, errors } = await launch();
const LOAF_INIT = `window.__loaf = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ start: e.startTime, dur: e.duration, blocking: e.blockingDuration, renderStart: e.renderStart, styleStart: e.styleAndLayoutStart, firstUI: e.firstUIEventTimestamp, scripts: (e.scripts || []).map((s) => ({ n: s.invoker || s.name, d: s.duration, forced: s.forcedStyleAndLayoutDuration })) }); }).observe({ type: 'long-animation-frame' });`;

async function wheel(screens, ticksPerScreen = 5) {
  const pv = await page.locator('.mdr-preview').boundingBox();
  const H = await page.evaluate(() => window.__mdr.app.preview.el.clientHeight);
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.evaluate(() => { window.__loaf.length = 0; window.__probeFrames(true); });
  const t0 = await page.evaluate(() => performance.now());
  for (let s = 0; s < screens; s++) for (let k = 0; k < ticksPerScreen; k++) { await page.mouse.wheel(0, H / ticksPerScreen); await sleep(16); }
  await sleep(600);
  const t1 = await page.evaluate(() => performance.now());
  await page.evaluate(() => window.__probeFrames(false));
  const loaf = await page.evaluate(() => window.__loaf.slice());
  const frames = (await page.evaluate(() => window.__probe.frames)).filter((f) => f >= t0 && f <= t1);
  const gaps = []; for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  return { loaf, gaps, t0, t1 };
}

try {
  await warmUp(page);
  for (const mode of ['preview', 'split']) {
    await page.goto(`${BASE}/?doc=/test-data/large.md&mode=${mode}`);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    await waitFirstVisible(page, 90_000);
    await waitIdle(page);
    await page.evaluate(LOAF_INIT);
    await sleep(500);
    const { loaf, gaps } = await wheel(10);
    const slow = gaps.filter((g) => g > 20);
    console.log(`\n[A mode=${mode}] frames ${gaps.length}, >20 ms ${slow.length} (${(100 * slow.length / Math.max(1, gaps.length)).toFixed(1)} %), max gap ${fmt(max(gaps))}, p95 ${fmt(pct(gaps, 95))}; LoAF n=${loaf.length}`);
    for (const e of loaf.slice(0, 4)) console.log(`   LoAF dur ${e.dur.toFixed(0)} blocking ${e.blocking.toFixed(0)} | script phase ${(e.renderStart - e.start).toFixed(0)} ms, pre-layout (rAF etc.) ${(e.styleStart - e.renderStart).toFixed(0)} ms, style+layout+paint ${(e.start + e.dur - e.styleStart).toFixed(0)} ms | scripts ${e.scripts.map((s) => `${s.n}:${s.d.toFixed(0)}(forced ${s.forced.toFixed(0)})`).join(',') || '-'}`);
    const mounted = await page.evaluate(() => ({ mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, top: window.__mdr.app.preview.topVisible().line }));
    console.log(`   mounted ${mounted.mounted}, preview top line ${mounted.top}`);
  }

  // ---- B: trace in split mode
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate(LOAF_INIT);
  await page.evaluate(() => window.addEventListener('wheel', () => performance.mark('vwheel'), true));
  await sleep(500);
  const tracePath = new URL('./.trace-scroll.json', import.meta.url).pathname;
  await browser.startTracing(page, { path: tracePath, screenshots: false, categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'blink', 'disabled-by-default-blink.debug.layout'] });
  await sleep(300);
  await wheel(5);
  await sleep(300);
  const buf = await browser.stopTracing();
  const ev = JSON.parse(buf.toString()).traceEvents;
  const marks = ev.filter((e) => e.cat?.includes('blink.user_timing') && e.name === 'vwheel');
  if (!marks.length) throw new Error('no vwheel marks');
  const { pid, tid } = marks[0];
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X' && typeof e.dur === 'number');
  const NAMES = ['Layout', 'UpdateLayoutTree', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'FunctionCall', 'FireAnimationFrame', 'EventDispatch', 'HitTest', 'RunMicrotasks', 'ScrollLayer', 'UpdateLayer', 'CompositeLayers', 'IntersectionObserverController::computeIntersections', 'ResizeObserver', 'TimerFire'];
  const tasks = main.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').filter((t) => t.ts >= marks[0].ts).sort((a, b) => b.dur - a.dur);
  console.log(`\n[B trace] tasks since first wheel: ${tasks.length}; > 50 ms: ${tasks.filter((t) => t.dur > 50000).length}`);
  for (const t of tasks.slice(0, 6)) {
    const kids = main.filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && NAMES.includes(e.name));
    const agg = {}; for (const k of kids) agg[k.name] = (agg[k.name] ?? 0) + k.dur / 1000;
    const lay = kids.filter((k) => k.name === 'Layout').sort((a, b) => b.dur - a.dur)[0];
    console.log(`   task ${(t.dur / 1000).toFixed(1)} ms: ${Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}${lay ? ` | biggest Layout ${(lay.dur / 1000).toFixed(1)} ms args ${JSON.stringify(lay.args?.beginData ?? lay.args?.data ?? {}).slice(0, 200)}` : ''}`);
  }
  // which element kinds are laid out: count LayoutObjects if available (blink.debug.layout)
  const layoutBlocks = main.filter((e) => e.name === 'LayoutBlock' || e.name === 'LayoutObject::UpdateLayout' || e.name === 'LayoutNG' || e.name === 'LayoutBox::UpdateLayout');
  console.log(`[B trace] layout sub-events: ${layoutBlocks.length}`);
} finally {
  dumpErrors(errors);
  await browser.close();
}
