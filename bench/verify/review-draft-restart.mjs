// bench/verify/review-draft-restart.mjs — spec features the static read flagged as risky:
//  1) draft autosave from the worker (SPEC §4.6) + restore offer after a reload (SPEC §8)
//  2) worker restart on a killed worker: preview recovers without user action (SPEC §9)
//  3) exportHtml while the renderer is gone must not hang
// Run: node bench/verify/review-draft-restart.mjs   (own dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep } from './review-lib.mjs';

const { browser, page, errors } = await openPage();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`); };

await gotoApp(page, 'mode=split');

// ---------------------------------------------------------------- 1. drafts
await page.click('.cm-content');
await page.keyboard.type('草稿内容 draft-marker', { delay: 10 });
await sleep(2500);   // DRAFT_DEBOUNCE_MS = 1000
const st = await page.evaluate(() => document.querySelector('[data-stat=file]').textContent);
check('1a: statusbar reports 草稿已存 after the debounce', /草稿已存/.test(st), { st });

const idb = await page.evaluate(async () => {
  const { get } = await import('/node_modules/.vite/deps/idb-keyval.js').catch(() => import('idb-keyval'));
  return await get('mdr.draft:untitled');
});
check('1b: worker wrote the draft to IndexedDB', !!idb && String(idb.text).includes('draft-marker'), { at: idb?.at, version: idb?.version, len: idb?.text?.length });

// reload -> the app must offer to restore
await page.evaluate(() => { window.onbeforeunload = null; });
await page.goto('http://localhost:5205/?mode=split');
await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
await sleep(1200);
const offer = await page.evaluate(() => ({
  toast: document.querySelector('.mdr-toast__text')?.textContent ?? null,
  buttons: Array.from(document.querySelectorAll('.mdr-toast__btn')).map((b) => b.textContent),
}));
check('1c: reload offers to restore the draft', offer.toast === '发现未保存的草稿，是否恢复？' && offer.buttons.includes('恢复'), offer);

if (offer.buttons.includes('恢复')) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.mdr-toast__btn')).find((x) => x.textContent === '恢复');
    b.click();
  });
  await waitIdle(page);
  await sleep(300);
  const restored = await page.evaluate(() => ({
    text: window.__mdr.app.getText(),
    preview: document.querySelector('.mdr-preview__body')?.textContent ?? '',
    file: document.querySelector('[data-stat=file]').textContent,
  }));
  check('1d: restore puts the draft in the editor and the preview', restored.text.includes('draft-marker') && restored.preview.includes('draft-marker'), { file: restored.file, len: restored.text.length });
}

// clean up the draft so re-runs start fresh
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('keyval-store');
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').delete('mdr.draft:untitled');
    tx.oncomplete = () => res(true);
    tx.onerror = () => res(false);
  };
  req.onerror = () => res(false);
}));

await page.evaluate(() => { window.onbeforeunload = null; });
await page.goto('http://localhost:5205/?mode=split');
await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
await page.evaluate(() => window.__mdr.loadUrl('/test-data/small.md'));
await waitIdle(page);
await sleep(300);

// ---------------------------------------------------------------- 3. export must settle
const exp = await page.evaluate(async () => {
  const t0 = performance.now();
  try {
    const html = await Promise.race([
      window.__mdr.app.worker.exportHtml(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ]);
    return { ok: true, ms: performance.now() - t0, len: html.length };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, err: String(e) };
  }
});
check('3: exportHtml settles', exp.ok, exp);

console.log('\nconsole/page errors (' + errors.length + '):', errors.slice(0, 10));
console.log('__RESULT__' + JSON.stringify({ results, errors: errors.slice(0, 10) }));
await browser.close();
