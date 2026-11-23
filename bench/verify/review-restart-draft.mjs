// bench/verify/review-restart-draft.mjs — suspected bug: workerClient.restart() spawns a new worker, posts init +
// setDoc, but never re-sends `draft enable` (App only sends it in openFile). The new worker's DraftSaver starts with
// enabled=false → autosave silently stops after a restart. Also checks that the preview recovers.
// Run: node bench/verify/review-restart-draft.mjs
import { openPage, gotoApp, loadDoc, waitIdle, sleep, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'small.md';
const { browser, page, errors } = await openPage();
const readDraft = (docId) => page.evaluate((docId) => new Promise((resolve) => {
  const req = indexedDB.open('keyval-store');
  req.onerror = () => resolve({ error: String(req.error) });
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('keyval')) return resolve(null);
    const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.draft:' + docId);
    g.onsuccess = () => resolve(g.result ? { version: g.result.version, at: g.result.at, len: g.result.text.length } : null);
    g.onerror = () => resolve({ error: String(g.error) });
  };
}), docId);
const statusFile = () => page.evaluate(() => document.querySelector('.mdr-statusbar__item[data-stat="file"]').textContent);
try {
  await page.addInitScript(() => {
    const Orig = window.Worker;
    window.__workers = [];
    window.Worker = class extends Orig { constructor(...a) { super(...a); window.__workers.push(this); } };
  });
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  const docId = `text:${DOC}`;
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(10, 0); window.__mdr.app.editor.focus(); });
  await page.keyboard.type('before-restart ');
  await sleep(2000);
  const v0 = await page.evaluate(() => window.__mdr.version());
  const d0 = await readDraft(docId);
  const st0 = await statusFile();
  console.log('before restart: version', v0, 'draft', d0, 'status', st0);

  const workersBefore = await page.evaluate(() => window.__workers.length);
  await page.evaluate(() => { window.__workers.at(-1).dispatchEvent(new ErrorEvent('error', { message: 'simulated crash' })); });
  await sleep(500);
  const workersAfter = await page.evaluate(() => window.__workers.length);
  await waitIdle(page).catch(() => {});

  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type('after-restart ');
  await sleep(2500);
  const v1 = await page.evaluate(() => window.__mdr.version());
  const d1 = await readDraft(docId);
  const st1 = await statusFile();
  console.log('after restart: version', v1, 'draft', d1, 'status', st1);

  // flush (visibilitychange → hidden) should also write
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(800);
  const d2 = await readDraft(docId);
  console.log('after flush:', d2);

  const toasts = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent));
  report(`review-restart-draft ${DOC}`, [
    { name: 'draft written before the restart', value: `draft version ${d0?.version} vs editor ${v0}; status "${st0}"`, target: 'equal, 草稿已存', pass: !!d0 && d0.version === v0 },
    { name: 'worker restarted (error event → new Worker)', value: `${workersBefore} → ${workersAfter}; toasts ${JSON.stringify(toasts)}`, target: '+1', pass: workersAfter === workersBefore + 1 },
    { name: 'draft written after the restart (edit + 2.5 s)', value: `draft version ${d1?.version} vs editor ${v1}; status "${st1}"`, target: 'equal, 草稿已存', pass: !!d1 && d1.version === v1 },
    { name: 'draft flushed on visibilitychange after the restart', value: `draft version ${d2?.version} vs editor ${v1}`, target: 'equal', pass: !!d2 && d2.version === v1 },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
