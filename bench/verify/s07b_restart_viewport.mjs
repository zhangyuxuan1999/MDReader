// s07b — isolate the s07 (A) failure: after a worker restart, does the new worker ever receive a
// `viewport` message? Do mounted-but-stale blocks refresh? Is typing in a mounted block reflected in
// the preview? Does scrolling (which changes the window) recover it?
// Captures every main→worker postMessage per Worker instance.
// Run: node bench/verify/s07b_restart_viewport.mjs
import { launch, open, settle, structureCheck, toasts, makeChecker, report, sleep } from './_lib.mjs';

const INIT = `
(() => {
  const P = Worker.prototype.postMessage;
  window.__posted = [];
  Worker.prototype.postMessage = function (m, ...rest) {
    const i = (window.__workers || []).indexOf(this);
    window.__posted.push({ w: i, type: m && m.type, t: Math.round(performance.now()), extra: m && m.type === 'viewport' ? [m.firstLine, m.lastLine] : (m && m.type === 'need' ? m.ids.length : undefined) });
    return P.call(this, m, ...rest);
  };
})();`;

const { browser, page, log } = await launch({ initScript: INIT });
const C = makeChecker();

const staleInfo = () => page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('.md-block'));
  const mountedStale = all.filter((b) => b.classList.contains('is-stale') && !b.classList.contains('is-pending'));
  const el = window.__mdr.app.preview.el;
  const r = el.getBoundingClientRect();
  const visibleStale = mountedStale.filter((b) => { const br = b.getBoundingClientRect(); return br.bottom > r.top && br.top < r.bottom; });
  return { stale: all.filter((b) => b.classList.contains('is-stale')).length, mountedStale: mountedStale.length, visibleStale: visibleStale.length, visibleStaleIds: visibleStale.slice(0, 5).map((b) => b.dataset.id) };
});
const posted = (w) => page.evaluate((w) => window.__posted.filter((p) => p.w === w).map((p) => p.type + (p.extra !== undefined ? '(' + p.extra + ')' : '')), w);
const shows = (needle) => page.evaluate((needle) => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).some((b) => b.textContent.includes(needle)), needle);

try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page, 60000);
  C.check('initial settle', s.ok, s);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(3000, 0); ed.focus(); });
  await sleep(600);
  await page.keyboard.type('BEFORE-RESTART ', { delay: 0 });
  s = await settle(page, 60000);
  await sleep(300);
  C.check('before restart: typed text shows in preview', await shows('BEFORE-RESTART'));
  const msgs0 = await posted(0);
  C.check('worker #0 received viewport messages', msgs0.filter((m) => m.startsWith('viewport')).length > 0, msgs0.filter((m) => m.startsWith('viewport')).slice(-3));

  // restart via error event
  await page.evaluate(() => { window.__workers[window.__workers.length - 1].dispatchEvent(new ErrorEvent('error', { message: 'simulated crash' })); });
  await sleep(200);
  C.check('restart happened', log.restarts === 1 && (await page.evaluate(() => window.__workers.length)) === 2);
  s = await settle(page, 60000);
  C.check('settled after restart', s.ok, s);
  await sleep(1000);
  const msgs1 = await posted(1);
  console.log('messages to worker #1:', JSON.stringify(msgs1));
  C.check('DEFECT PROBE: new worker received a viewport message after restart', msgs1.some((m) => m.startsWith('viewport')), msgs1.filter((m) => !m.startsWith('need')));
  let st = await staleInfo();
  C.check('after restart + idle + 1 s: no mounted block is still .is-stale', st.mountedStale === 0, st);
  C.check('after restart + idle + 1 s: no VISIBLE block is still .is-stale', st.visibleStale === 0, st);

  // type in the mounted block at the cursor
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.focus(); });
  await page.keyboard.type('AFTER-RESTART ', { delay: 0 });
  s = await settle(page, 60000);
  await sleep(1000);
  const posted1 = await page.evaluate(() => window.__posted.filter((p) => p.w === 1).map((p) => p.type));
  const htmlCount = await page.evaluate(() => window.__wmsgs.html);
  C.check('after restart: typed text shows in preview (idle + 1 s)', await shows('AFTER-RESTART'), { posted1: posted1.slice(-6), htmlMsgs: htmlCount });
  st = await staleInfo();
  C.check('after restart + typing: edited block not left stale', st.mountedStale === 0, st);

  // keep typing for a while (10 s) — does it ever appear?
  for (let i = 0; i < 5; i++) { await page.keyboard.type('more ', { delay: 0 }); await sleep(400); }
  await settle(page, 60000);
  await sleep(2000);
  C.check('after restart + 5 more edits + 2 s: typed text shows', await shows('AFTER-RESTART'));

  // Recovery paths: (1) scroll the preview a bit (changes the window → new viewport message)
  await page.evaluate(() => { const el = window.__mdr.app.preview.el; el.scrollTop += 3000; });
  await sleep(300);
  await page.evaluate(() => { window.__mdr.app.preview.scrollToLine(3000, 0, 'instant'); });
  await settle(page, 60000);
  await sleep(800);
  const msgs1b = await posted(1);
  C.check('after a scroll: viewport message finally sent to the new worker', msgs1b.some((m) => m.startsWith('viewport')), msgs1b.filter((m) => m.startsWith('viewport')).slice(-3));
  C.check('after a scroll: typed text shows (recovery by scrolling)', await shows('AFTER-RESTART'));

  // (2) same via mode switch instead of scroll? Fresh restart, then mode → preview → split
  await page.evaluate(() => { window.__workers[window.__workers.length - 1].dispatchEvent(new ErrorEvent('error', { message: 'simulated crash 2' })); });
  await settle(page, 60000);
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type('SECOND ', { delay: 0 });
  await settle(page, 60000);
  await sleep(800);
  C.check('second restart: typed text shows without scrolling', await shows('SECOND'));
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(300);
  await page.evaluate(() => window.__mdr.mode('split'));
  await settle(page, 60000);
  await sleep(800);
  C.check('second restart: typed text shows after a mode round-trip', await shows('SECOND'));

  const t = await toasts(page);
  console.log('toasts:', t);
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s07b restart viewport', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
