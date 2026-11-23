// bench/verify/v3-app-draft.mjs — verify-app (0.2.0 stage 2c), JOB 1: the crash-recovery offer against a live
// in-preview session. A draft record newer than the document is planted in IndexedDB, the document is loaded
// (offer 「发现未保存的草稿，是否恢复？」), then a session types before 恢复 / 丢弃 is clicked.
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-draft.mjs [case-prefix]
import { openBrowser, step, assert, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const only = process.argv[2] ?? '';
const t = (name, fn) => (only && !name.startsWith(only) ? Promise.resolve() : step(name, fn));
const B = await openBrowser();
const { page } = B;
const DOC = ['# 标题', '', '甲段落文字。', '', '乙段落文字。', ''].join('\n');
const DRAFT = ['# 标题', '', '甲段落文字。草稿', '', '乙段落文字。', ''].join('\n');
const L = (doc, needle) => doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
const idb = (op, key, val) => page.evaluate(([op, key, val]) => new Promise((res) => {
  const r = indexedDB.open('keyval-store');
  r.onupgradeneeded = () => r.result.createObjectStore('keyval');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction('keyval', op === 'get' || op === 'all' ? 'readonly' : 'readwrite');
    const st = tx.objectStore('keyval');
    if (op === 'put') { st.put(val, key); tx.oncomplete = () => { db.close(); res(true); }; }
    else if (op === 'get') { const g = st.get(key); g.onsuccess = () => { db.close(); res(g.result ?? null); }; }
    else if (op === 'all') { const out = {}; const c = st.openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) { db.close(); res(out); return; } out[String(cur.key)] = cur.value?.text; cur.continue(); }; }
  };
  r.onerror = () => res(null);
}), [op, key, val]);
const toastBtn = (label) => page.evaluate((label) => { const b = [...document.querySelectorAll('.mdr-toast button, .mdr-toast__action')].find((x) => x.textContent.trim() === label); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, label);
const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const clickDialog = (label) => page.evaluate((label) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; }, label);
async function withOffer(name) {
  await B.loadDoc('', 'reset.md');
  await idb('put', `mdr.draft:text:${name}`, { docId: `text:${name}`, version: 5, text: DRAFT, at: Date.now() + 600_000 });
  await B.loadDoc(DOC, name);
  for (let i = 0; i < 30 && !(await toastBtn('恢复')); i++) await sleep(100);
  assert(await toastBtn('恢复'), 'no restore offer');
}
async function startIn(doc, needle) {
  await B.clickLine(L(doc, needle), 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
}

try {
  await B.boot('mode=split');
  await t('D1 offer up; type Q in a session; click 恢复 (mouse): question; 恢复 → draft text; ⌘Z → the Q text back', async () => {
    await withOffer('d1.md');
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    const p = await toastBtn('恢复');
    await page.mouse.click(p.x, p.y);
    await sleep(500);
    const q = await dialogs();
    assert(q.length && q[0].includes('恢复草稿'), `no question: ${JSON.stringify(q)} src ${JSON.stringify(await B.source())}`);
    await clickDialog('恢复');
    await B.settle(400);
    const s = await B.source();
    assert(s === DRAFT, `after restore ${JSON.stringify(s)}`);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Meta+z');
    await B.settle(400);
    const s2 = await B.source();
    assert(s2 === DOC.replace('乙段落文字。', '乙段落文字。Q'), `after ⌘Z ${JSON.stringify(s2)}`);
  });
  await t('D2 offer up; type Q in a session; click 恢复 then 取消: Q kept, the offer is back, session can continue', async () => {
    await withOffer('d2.md');
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    const p = await toastBtn('恢复');
    await page.mouse.click(p.x, p.y);
    await sleep(500);
    await clickDialog('取消');
    await sleep(400);
    const s = await B.source();
    assert(s === DOC.replace('乙段落文字。', '乙段落文字。Q'), `after 取消 ${JSON.stringify(s)}`);
    assert(await toastBtn('恢复'), 'offer gone');
    await startIn(s, '乙段落文字。Q');
    await page.keyboard.type('R');
    await B.settle(300);
    await B.esc();
    assert((await B.source()).includes('乙段落文字。QR'), `R ${JSON.stringify(await B.source())}`);
  });
  await t('D3 offer up; empty 乙 in a session; click 丢弃 on the offer: deletion kept, the planted record gone, later draft = current text', async () => {
    await withOffer('d3.md');
    await startIn(DOC, '乙段落文字。');
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace');
    const p = await toastBtn('丢弃');
    await page.mouse.click(p.x, p.y);
    await sleep(1800);
    const s = await B.source();
    const d = await idb('get', 'mdr.draft:text:d3.md');
    assert(s === '# 标题\n\n甲段落文字。\n', `source ${JSON.stringify(s)}`);
    assert(!d || d.text === s, `stored draft ${JSON.stringify(d && d.text)}`);
    return `stored ${JSON.stringify(d && d.text)}`;
  });
  await t('D4 offer up; type into a session and press Enter (resume window), click 恢复 at once: question; 取消 keeps everything', async () => {
    await withOffer('d4.md');
    await startIn(DOC, '乙段落文字。');
    await page.keyboard.type('Q');
    await page.keyboard.press('Enter');
    await page.keyboard.type('NEW');
    const p = await toastBtn('恢复');
    await page.mouse.click(p.x, p.y);
    await sleep(600);
    const q = await dialogs();
    await clickDialog('取消');
    await sleep(500);
    const s = await B.source();
    assert(q.length, `no question; source ${JSON.stringify(s)}`);
    assert(s === DOC.replace('乙段落文字。', '乙段落文字。Q\n\nNEW'), `source ${JSON.stringify(s)}`);
  });
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
