// bench/verify/review-export-silence.mjs — exportHtml renders the WHOLE document synchronously inside the worker
// (md.renderDocument), so the worker cannot answer any message meanwhile. workerClient restarts the worker when an
// `edit` gets no `structure` within 10 s. Measures export duration on huge.md and whether one keystroke typed right
// after triggering the export causes a restart (export rejected + document resent).
// Run: node bench/verify/review-export-silence.mjs   (DOC=large.md)
import { openPage, gotoApp, loadDoc, waitIdle, sleep, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'huge.md';
const { browser, page, errors } = await openPage();
try {
  await page.addInitScript(() => {
    const Orig = window.Worker;
    window.__workers = [];
    window.Worker = class extends Orig { constructor(...a) { super(...a); window.__workers.push(this); } };
  });
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(50, 0); window.__mdr.app.editor.focus(); });
  await sleep(300);
  const t0 = await page.evaluate(() => { window.__exp = { t0: performance.now(), done: null, err: null }; window.__mdr.app.worker.exportHtml().then((h) => { window.__exp.done = performance.now(); window.__exp.len = h.length; }, (e) => { window.__exp.done = performance.now(); window.__exp.err = String(e); }); return window.__exp.t0; });
  await sleep(50);
  await page.keyboard.type('z');
  const tEdit = await page.evaluate(() => performance.now());
  // wait up to 60 s for the export to settle
  await page.waitForFunction(() => window.__exp.done !== null, null, { timeout: 90000 }).catch(() => {});
  await sleep(500);
  const r = await page.evaluate(() => ({ ...window.__exp, workers: window.__workers.length, toasts: Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent) }));
  const dur = r.done === null ? Infinity : r.done - r.t0;
  console.log('export:', { durationMs: r1(dur), len: r.len, err: r.err, workers: r.workers, toasts: r.toasts, editAt: r1(tEdit - r.t0) });
  report(`review-export-silence ${DOC}`, [
    { name: 'exportHtml duration (worker blocked for the whole time)', value: `${r1(dur)} ms`, target: 'informational (< 10 s keeps the silence watchdog quiet)', pass: dur < 10000 },
    { name: 'export resolved (not rejected by a restart)', value: r.err ?? `ok, ${r.len} chars`, target: 'resolved', pass: !r.err },
    { name: 'no worker restart triggered by typing during the export', value: `workers=${r.workers} toasts=${JSON.stringify(r.toasts)}`, target: 'workers=1, no 渲染器已重启', pass: r.workers === 1 },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
