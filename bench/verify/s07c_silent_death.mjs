// s07c — silent worker death (terminate() with no error event, like an OOM kill) while the user only
// scrolls/reads: does the app ever notice (restart + toast) or do blocks stay blank forever?
// Then: does one keystroke recover it (silence detector)? Run: node bench/verify/s07c_silent_death.mjs
import { launch, open, settle, toasts, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const visiblePending = () => page.evaluate(() => {
  const el = window.__mdr.app.preview.el; const r = el.getBoundingClientRect();
  let pending = 0, total = 0;
  for (const b of el.querySelectorAll('.md-block')) { const br = b.getBoundingClientRect(); if (br.bottom < r.top || br.top > r.bottom) continue; total++; if (b.classList.contains('is-pending')) pending++; }
  return { pending, total };
});
try {
  await open(page, '?doc=/test-data/medium.md&mode=preview');
  let s = await settle(page, 60000);
  C.check('initial settle (preview mode)', s.ok, s);
  await page.evaluate(() => { window.__workers[window.__workers.length - 1].terminate(); });
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(15000, 0, 'instant'));
  const t0 = Date.now();
  let vp = await visiblePending();
  const first = vp;
  // keep scrolling a bit like a reader would, for 20 s
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 300); await sleep(1000); }
  vp = await visiblePending();
  const workers = await page.evaluate(() => window.__workers.length);
  const t = await toasts(page);
  C.check('silent death + 20 s of scrolling: app detected the dead worker (restart)', workers > 1 || log.restarts > 0, { workers, restarts: log.restarts, toasts: t, elapsedMs: Date.now() - t0 });
  C.check('silent death + 20 s of scrolling: visible blocks rendered', vp.total > 0 && vp.pending === 0, { first, now: vp });
  const stat = await page.evaluate(() => document.querySelector('[data-stat=progress]')?.textContent);
  C.measure('status bar progress text while stuck', JSON.stringify(stat), 'informational', true);
  // recovery with one keystroke in split mode
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(300);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(15000, 0); ed.focus(); });
  await page.keyboard.type('x', { delay: 0 });
  await page.waitForFunction(() => window.__workers.length > 1, null, { timeout: 20000 }).catch(() => {});
  const w2 = await page.evaluate(() => window.__workers.length);
  C.check('one keystroke → silence detector restarts the worker (≈10 s)', w2 > 1, { workers: w2, restarts: log.restarts });
  s = await settle(page, 60000);
  vp = await visiblePending();
  C.check('after recovery: visible blocks rendered', vp.total > 0 && vp.pending === 0, vp);
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s07c silent death', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
