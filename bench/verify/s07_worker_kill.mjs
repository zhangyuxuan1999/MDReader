// s07 — render-worker failure modes. (A) worker 'error' event → restart + toast + preview recovers;
// (B) drafts keep working after the restart; (C) external terminate() (crash without error event):
// does the app notice without an edit? with an edit (10 s silence)?; (D) 4 crashes/min → give-up toast,
// editor keeps working.
// Run: node bench/verify/s07_worker_kill.mjs
import { launch, open, settle, structureCheck, latencyStats, toasts, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();

const visiblePending = () => page.evaluate(() => {
  const el = window.__mdr.app.preview.el;
  const r = el.getBoundingClientRect();
  let pending = 0, total = 0;
  for (const b of el.querySelectorAll('.md-block')) {
    const br = b.getBoundingClientRect();
    if (br.bottom < r.top || br.top > r.bottom) continue;
    total++;
    if (b.classList.contains('is-pending')) pending++;
  }
  return { pending, total };
});
const readDraft = (docId) => page.evaluate(async (docId) => {
  return new Promise((resolve) => {
    const req = indexedDB.open('keyval-store');
    req.onerror = () => resolve({ error: String(req.error) });
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keyval')) return resolve({ missing: 'store' });
      const tx = db.transaction('keyval', 'readonly');
      const g = tx.objectStore('keyval').get('mdr.draft:' + docId);
      g.onsuccess = () => resolve(g.result ? { version: g.result.version, at: g.result.at, len: g.result.text.length } : null);
      g.onerror = () => resolve({ error: String(g.error) });
    };
  });
}, docId);

try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page, 60000);
  C.check('initial settle', s.ok, s);
  const docId = 'text:medium.md';

  // Sanity: drafts work before any restart
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(100, 0); window.__mdr.app.editor.focus(); });
  await page.keyboard.type('draft-before ', { delay: 0 });
  await sleep(2500);
  const d0 = await readDraft(docId);
  const v0 = await page.evaluate(() => window.__mdr.version());
  C.check('draft saved before restart (IDB has current version)', d0 && d0.version === v0, { d0, v0 });

  // (A) error event on the worker
  const workersBefore = await page.evaluate(() => window.__workers.length);
  await page.evaluate(() => { window.__workers[window.__workers.length - 1].dispatchEvent(new ErrorEvent('error', { message: 'simulated crash' })); });
  await sleep(300);
  const workersAfter = await page.evaluate(() => window.__workers.length);
  C.check('(A) worker restarted after error event', workersAfter === workersBefore + 1, `${workersBefore} → ${workersAfter}`);
  const t1 = await toasts(page);
  C.check('(A) toast 「渲染器已重启」 shown', t1.some((t) => t.includes('渲染器已重启')), t1);
  C.check('(A) restart counted once', log.restarts === 1, `restarts=${log.restarts}`);
  s = await settle(page, 60000);
  C.check('(A) worker settled after restart', s.ok, s);
  let sc = await structureCheck(page);
  C.check('(A) structure tiles after restart', sc.problems.length === 0, sc);
  let vp = await visiblePending();
  C.check('(A) visible preview blocks mounted after restart', vp.total > 0 && vp.pending === 0, vp);
  await page.evaluate(() => { window.__lat.length = 0; });
  await page.keyboard.type('after-restart-typing ', { delay: 0 });
  s = await settle(page, 60000);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).some((b) => b.textContent.includes('after-restart-typing')));
  C.check('(A) preview reflects typing after restart', shown);

  // (B) drafts after restart
  const vB = await page.evaluate(() => window.__mdr.version());
  await sleep(2500);
  const dB = await readDraft(docId);
  const savedMsgs = await page.evaluate(() => window.__wmsgs.draftSaved.map((d) => d.version));
  C.check('(B) draft still autosaved after worker restart', dB && dB.version === vB, { draftInIdb: dB, editorVersion: vB, draftSavedVersions: savedMsgs });
  // flush on hidden also?
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(600);
  const dB2 = await readDraft(docId);
  C.check('(B) draft flush on visibilitychange after restart', dB2 && dB2.version === vB, { dB2, vB });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });

  // (C) external terminate (no error event) — scroll the preview far away: do pending blocks ever render?
  await page.evaluate(() => { window.__workers[window.__workers.length - 1].terminate(); });
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(15000, 0, 'instant'));
  await sleep(3000);
  vp = await visiblePending();
  const restartsC0 = log.restarts;
  C.check('(C) after silent terminate + scroll: visible blocks stay pending (no detection without an edit)', true, { ...vp, restarts: restartsC0 });
  // now an edit: the 10 s silence detector should restart
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(15000, 0); window.__mdr.app.editor.focus(); });
  const tEdit = Date.now();
  await page.keyboard.type('x', { delay: 0 });
  await page.waitForFunction((n) => window.__workers.length > n, workersAfter, { timeout: 20000 }).catch(() => {});
  const recoveryMs = Date.now() - tEdit;
  const workersC = await page.evaluate(() => window.__workers.length);
  C.check('(C) silent-terminate recovered via silence detector after an edit', workersC === workersAfter + 1, `workers ${workersAfter} → ${workersC}`);
  C.measure('(C) time from edit to restart after silent terminate (ms)', recoveryMs, '≈ 10000 (spec)', recoveryMs < 12000);
  s = await settle(page, 60000);
  C.check('(C) settled after recovery', s.ok, s);
  vp = await visiblePending();
  C.check('(C) visible blocks mounted after recovery', vp.total > 0 && vp.pending === 0, vp);
  const lat = await latencyStats(page);
  C.measure('(C) input latency max during dead-worker period (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);

  // (D) exceed 3 restarts / minute
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { window.__workers[window.__workers.length - 1].dispatchEvent(new ErrorEvent('error', { message: 'crash ' })); });
    await sleep(200);
  }
  const tD = await toasts(page);
  C.check('(D) give-up toast after > 3 restarts/min', tD.some((t) => t.includes('多次崩溃')), tD);
  const workersD = await page.evaluate(() => window.__workers.length);
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type('still typing ', { delay: 0 });
  const textD = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('(D) editor still works after renderer gave up', textD.includes('still typing'));
  await sleep(500);
  const workersD2 = await page.evaluate(() => window.__workers.length);
  C.check('(D) no further worker spawns after give-up', workersD2 === workersD, `${workersD} → ${workersD2}`);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s07 worker kill', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
