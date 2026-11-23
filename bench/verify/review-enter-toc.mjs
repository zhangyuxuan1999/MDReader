// bench/verify/review-enter-toc.mjs — suspected perf violation: any keystroke that changes the line count above the
// headings (Enter/Backspace/paste) shifts every outline entry's line → worker posts the whole outline → toc.setOutline
// rebuilds ALL anchors and refreshOffsets() reads offsetTop/offsetHeight of every item (forced layout) — on the
// keystroke path. Compares 'x' keystrokes (no line change) against Enter keystrokes at the top of large.md (6k headings).
// Run: node bench/verify/review-enter-toc.mjs   (DOC=medium.md for 1.2k headings)
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, sleep, pct, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const N = Number(process.env.N || 30);
const { browser, page, errors } = await openPage();

async function burst(key, line) {
  await page.evaluate((l) => { window.__mdr.app.editor.gotoLine(l, 0); window.__mdr.app.editor.focus(); }, line);
  await sleep(500);
  await page.evaluate(() => { window.__loaf = []; window.__loafObs?.disconnect(); window.__loafObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__loaf.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration, layout: e.styleAndLayoutDuration, forced: e.scripts.reduce((a, s) => a + s.forcedStyleAndLayoutDuration, 0), scripts: e.scripts.map((s) => `${s.sourceFunctionName || s.invoker}:${r1(s.duration)}`) }); function r1(n) { return Math.round(n * 10) / 10; } }); window.__loafObs.observe({ type: 'long-animation-frame', buffered: false }); });
  await resetMonitor(page);
  const t0 = await page.evaluate(() => performance.now());
  for (let i = 0; i < N; i++) {
    await page.keyboard.press(key);
    await sleep(150);
  }
  await sleep(600);
  const mon = await readMonitor(page);
  const loaf = await page.evaluate(() => window.__loaf);
  const gaps = mon.longtasks.filter((t) => t.start >= t0);
  return { mon, loaf: loaf.filter((l) => l.start >= t0), longtasks: gaps };
}

try {
  await gotoApp(page, 'mode=split');
  await installMonitor(page);
  await loadDoc(page, DOC);
  await waitIdle(page);
  await sleep(1000);
  const toc = await page.evaluate(() => document.querySelectorAll('.mdr-toc__item').length);
  console.log(`${DOC}: ${toc} TOC items`);

  const x = await burst('x', 3);
  const enter = await burst('Enter', 3);
  const summarise = (r) => {
    const durs = r.loaf.map((l) => l.dur);
    return { frames: r.mon.frames, over20: r.mon.over20, over50: r.mon.over50, maxGap: r1(r.mon.maxGap), p95Gap: r1(r.mon.p95), loafCount: r.loaf.length, loafP95: r1(pct(durs, 0.95)), loafMax: r1(Math.max(0, ...durs)), forcedLayoutMax: r1(Math.max(0, ...r.loaf.map((l) => l.forced))), longtasks: r.longtasks.length };
  };
  const sx = summarise(x), se = summarise(enter);
  console.log("'x' ×" + N + ':', sx);
  console.log('Enter ×' + N + ':', se);
  console.log('Enter LoAF samples:', JSON.stringify(enter.loaf.slice(0, 5), null, 0));
  report(`review-enter-toc ${DOC} (${toc} headings)`, [
    { name: `'x' ×${N}: frames > 20 ms`, value: `${sx.over20} / ${sx.frames} (max gap ${sx.maxGap} ms, long tasks ${sx.longtasks})`, target: '≈ 0', pass: sx.over50 === 0 },
    { name: `Enter ×${N}: frames > 20 ms`, value: `${se.over20} / ${se.frames} (max gap ${se.maxGap} ms, long tasks ${se.longtasks})`, target: '0 frames > 50 ms (P5 main p95 < 5 ms / max < 10 ms)', pass: se.over50 === 0 },
    { name: `Enter ×${N}: long animation frames`, value: `${se.loafCount} (p95 ${se.loafP95} ms, max ${se.loafMax} ms, forced layout max ${se.forcedLayoutMax} ms)`, target: 'p95 < 10 ms', pass: se.loafP95 < 10 },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
