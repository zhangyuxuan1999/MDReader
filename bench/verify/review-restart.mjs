// bench/verify/review-restart.mjs — force a render-worker restart (malformed edit → uncaught error in the
// worker → onerror → restart) while the preview is scrolled to the middle, then check the preview recovers:
// no wrapper left .is-stale / .is-pending in the visible window after a few seconds.
// Run: node bench/verify/review-restart.mjs
import { openPage, gotoApp, loadDoc, waitIdle, sleep, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'medium.md';
const { browser, page, errors } = await openPage();
try {
  // capture the Worker instance before the app creates it
  await page.addInitScript(() => {
    const Orig = window.Worker;
    window.__workers = [];
    window.Worker = class extends Orig {
      constructor(...a) { super(...a); window.__workers.push(this); }
    };
  });
  await gotoApp(page, 'mode=preview');
  await loadDoc(page, DOC);
  await waitIdle(page);
  // scroll the preview to the middle and let it settle
  await page.evaluate(() => { const p = window.__mdr.app.preview; p.scrollToLine(Math.floor(window.__mdr.app.editor.lineCount() / 2)); });
  await sleep(1500);
  await waitIdle(page);
  const before = await page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const H = p.el.clientHeight, st = p.el.scrollTop;
    const vis = [];
    for (const w of p.el.querySelectorAll('.md-block')) {
      const top = w.offsetTop; // verification-only layout read
      if (top + w.offsetHeight >= st && top <= st + H) vis.push({ id: w.dataset.id, cls: w.className });
    }
    return { scrollTop: st, visible: vis };
  });
  const countBefore = before.visible.length;
  const staleBefore = before.visible.filter((v) => /is-stale|is-pending/.test(v.cls)).length;

  // trigger the restart: a malformed edit makes the worker throw inside onmessage
  await page.evaluate(() => { window.__workers[0].postMessage({ type: 'edit', version: 999999, changes: null }); });
  await sleep(4000);
  await waitIdle(page).catch(() => {});
  await sleep(1500);
  const after = await page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const H = p.el.clientHeight, st = p.el.scrollTop;
    const vis = [];
    for (const w of p.el.querySelectorAll('.md-block')) {
      const top = w.offsetTop;
      if (top + w.offsetHeight >= st && top <= st + H) vis.push({ id: w.dataset.id, cls: w.className, kids: w.childElementCount });
    }
    const toasts = Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent);
    return { scrollTop: st, visible: vis, toasts, workers: window.__workers.length };
  });
  const stale = after.visible.filter((v) => v.cls.includes('is-stale')).length;
  const pending = after.visible.filter((v) => v.cls.includes('is-pending')).length;
  report(`review-restart ${DOC}`, [
    { name: 'worker restarted (second Worker created, toast shown)', value: `workers=${after.workers} toasts=${JSON.stringify(after.toasts)}`, target: 'workers=2, 渲染器已重启', pass: after.workers === 2 },
    { name: 'visible wrappers before restart stale/pending', value: `${staleBefore} / ${countBefore}`, target: '0', pass: staleBefore === 0 },
    { name: 'visible wrappers still .is-stale 5.5 s after restart', value: `${stale} / ${after.visible.length}`, target: '0', pass: stale === 0 },
    { name: 'visible wrappers .is-pending (empty) 5.5 s after restart', value: `${pending} / ${after.visible.length}`, target: '0', pass: pending === 0 },
    { name: 'preview scrollTop unchanged', value: `${before.scrollTop} → ${after.scrollTop}`, target: 'same', pass: Math.abs(before.scrollTop - after.scrollTop) < 2 },
  ]);
  console.log('sample visible after:', JSON.stringify(after.visible.slice(0, 6)));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
