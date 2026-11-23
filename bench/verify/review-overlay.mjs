// bench/verify/review-overlay.mjs — cost of the ?perf=1 overlay on huge.md: perfOverlay.refresh() runs
// querySelectorAll('.md-block:not(.is-pending)') over every wrapper every 500 ms. Compares idle frame
// gaps / long tasks with and without ?perf=1. Run: node bench/verify/review-overlay.mjs
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, sleep, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'huge.md';
async function run(query) {
  const { browser, page, errors } = await openPage();
  try {
    await gotoApp(page, query);
    await loadDoc(page, DOC);
    await waitIdle(page);
    await installMonitor(page);
    await sleep(500);
    await resetMonitor(page);
    // measure the overlay's refresh directly too
    const direct = await page.evaluate(() => {
      const el = window.__mdr.app.preview.el;
      const t0 = performance.now();
      const n = el.querySelectorAll('.md-block:not(.is-pending)').length;
      return { ms: performance.now() - t0, n, total: el.querySelectorAll('.md-block').length };
    });
    await sleep(6000);
    const mon = await readMonitor(page);
    return { mon, direct, errors };
  } finally {
    await browser.close();
  }
}
const withPerf = await run('mode=split&perf=1');
const without = await run('mode=split');
report(`review-overlay ${DOC}`, [
  { name: 'querySelectorAll(".md-block:not(.is-pending)") once', value: `${r1(withPerf.direct.ms)} ms over ${withPerf.direct.total} wrappers`, target: '< 5 ms', pass: withPerf.direct.ms < 5 },
  { name: 'idle 6 s with ?perf=1: frames > 20 ms / long tasks', value: `${withPerf.mon.over20} / ${withPerf.mon.frames} frames, max gap ${r1(withPerf.mon.maxGap)} ms, longtasks ${withPerf.mon.longtasks.length}`, target: '0', pass: withPerf.mon.over20 === 0 },
  { name: 'idle 6 s without ?perf=1: frames > 20 ms / long tasks', value: `${without.mon.over20} / ${without.mon.frames} frames, max gap ${r1(without.mon.maxGap)} ms, longtasks ${without.mon.longtasks.length}`, target: '0', pass: without.mon.over20 === 0 },
]);
console.log('errors with perf:', withPerf.errors.length ? withPerf.errors : 'none');
console.log('errors without:', without.errors.length ? without.errors : 'none');
