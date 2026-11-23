// bench/verify/v4-app-r5.mjs — verify-app (0.2.0 stage 2d). R5 (H5) against preview sessions: with a recovery
// offer on screen and unanswered, edits made in a preview SESSION that bring the text back to the loaded text
// (typing + Backspace, emptying a block + ⌘Z, typing + Esc + ⌘Z, Enter + Backspace) must leave the offered crash
// draft in storage. Prints RESULT lines: `stored` is the draft record's text after the debounce.
//   MDR_PORT=5436 node bench/verify/v4-app-r5.mjs [filter]
// Needs the renderer already listening. Writes nothing into the tree (IndexedDB of a throw-away context).
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page, context } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const CRASH = 'crash version text\n';
const DOC = 'para one\n\npara two words\n';
const seed = (id) => page.evaluate(([id, t]) => new Promise((res, rej) => {
  const o = indexedDB.open('keyval-store');
  o.onupgradeneeded = () => { o.result.createObjectStore('keyval'); };
  o.onsuccess = () => {
    const db = o.result; const tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').put({ docId: id, version: 3, text: t, at: Date.now() + 3600_000 }, 'mdr.draft:' + id);
    tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => { db.close(); rej(tx.error); };
  };
  o.onerror = () => rej(o.error);
}), [id, CRASH]);
const stored = (id) => page.evaluate((id) => new Promise((res) => {
  const r = indexedDB.open('keyval-store');
  r.onsuccess = () => { const db = r.result; try { const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.draft:' + id); g.onsuccess = () => { res(g.result ? String(g.result.text) : null); db.close(); }; } catch { res(null); db.close(); } };
  r.onerror = () => res(null);
}), id);
const offerUp = () => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')));
const ACTS = {
  typeBackspace: async () => { await B.caretAt('two'); await page.keyboard.type('X'); await sleep(80); await page.keyboard.press('Backspace'); },
  typeWaitBackspace: async () => { await B.caretAt('two'); await page.keyboard.type('X'); await sleep(400); await page.keyboard.press('Backspace'); },
  emptyUndo: async () => {
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace'); await sleep(300); await page.keyboard.press('ControlOrMeta+z');
  },
  typeEscUndo: async () => { await B.caretAt('two'); await page.keyboard.type('XY'); await sleep(200); await page.keyboard.press('Escape'); await sleep(300); await page.keyboard.press('ControlOrMeta+z'); },
  enterBackspace: async () => { await B.caretAt('para two'); await page.keyboard.press('Enter'); await sleep(300); await page.keyboard.press('Backspace'); },
  sessionUndoRedoUndo: async () => { await B.caretAt('two'); await page.keyboard.type('X'); await sleep(300); await page.keyboard.press('ControlOrMeta+z'); await sleep(300); await page.keyboard.press('ControlOrMeta+Shift+z'); await sleep(300); await page.keyboard.press('ControlOrMeta+z'); },
};
try {
  await B.boot('mode=split');
  let n = 0;
  for (const [an, act] of Object.entries(ACTS)) {
    if (only && !an.startsWith(only)) continue;
    n++;
    try {
      const name = `r5-${n}.md`;
      const id = `text:${name}`;
      await page.keyboard.press('Escape');
      await seed(id);
      await page.evaluate(([t, nm]) => window.__mdr.app.loadText(t, nm), [DOC, name]);
      const end = Date.now() + 4000;
      while (Date.now() < end && !(await offerUp())) await sleep(80);
      const up = await offerUp();
      await sleep(700);
      await B.clickLine(3, 'first', 'para');
      await sleep(150);
      await act();
      await B.settle(300);
      const back = (await B.source()) === DOC;
      await sleep(2800);   // past the worker's draft debounce
      const st = await stored(id);
      out(an, { offer: up, backToLoaded: back, stored: st, crashKept: st === CRASH, title: await page.evaluate(() => document.title) });
    } catch (e) { out(an, `ERROR ${String(e.message).split('\n')[0]}`); }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
  void context;
}
