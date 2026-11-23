// bench/verify/v2-app-replace.mjs — verify-app (0.2.0 stage 2a), JOB 1: a session holding a change that is not in
// the source yet (typed 0 ms before, or an emptied block whose deletion waits for the session end) against
// ⌘S (web legacy download), a dropped file, the 预览可编辑 toggle and a mode switch.
// Needs the candidate renderer: npx vite --port 5283 --strictPort.  Run: MDR_PORT=5283 node bench/verify/v2-app-replace.mjs [filter]
import { readFileSync } from 'node:fs';
import { openBrowser, step, assert, eq, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const only = process.argv[2] ?? '';
const t = (name, fn) => (only && !name.includes(only) ? Promise.resolve() : step(name, fn));
const B = await openBrowser();
await B.context.addInitScript(() => { try { delete window.showSaveFilePicker; delete window.showOpenFilePicker; delete Window.prototype.showSaveFilePicker; delete Window.prototype.showOpenFilePicker; } catch { /* */ } });
const { page } = B;
const DOC = '# 标题\n\n甲段落文字。\n\n乙段落文字。\n';
const dialogs = () => page.evaluate(() => document.querySelectorAll('.mdr-dialog').length);
const clickBtn = (l) => page.evaluate((l) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l); if (b) b.click(); return !!b; }, l);
const drop = (name, text) => page.evaluate(([n, t]) => {
  const dt = new DataTransfer(); dt.items.add(new File([t], n, { type: 'text/markdown' }));
  document.querySelector('.mdr-preview .is-editing, .mdr-app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [name, text]);
async function session(needle) {
  await B.loadDoc(DOC, 'r.md');
  const L = DOC.split('\n').findIndex((l) => l.includes(needle)) + 1;
  await B.clickLine(L, 'first', needle.slice(0, 2));
  await B.caretAt(needle);
  assert(await B.editing(), 'no session');
}
async function emptyIt() {
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p') ?? el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.press('Backspace'); await sleep(150);
}
const title = () => page.evaluate(() => document.title);

try {
  await B.boot('mode=split');

  await t('C1 emptied paragraph (deletion pending), ⌘S → the downloaded file matches the screen (no 甲)', async () => {
    await session('甲段落文字。');
    await emptyIt();
    const shown = await page.evaluate(() => document.querySelector('.mdr-preview').innerText.includes('甲段落'));
    const dl = page.waitForEvent('download', { timeout: 8000 });
    await page.keyboard.press('ControlOrMeta+s');
    const txt = readFileSync(await (await dl).path(), 'utf8');
    await B.settle(200);
    const ttl = await title();
    const srcAfterSave = await B.source();
    await B.esc();
    const srcAfterEsc = await B.source();
    const ttl2 = await title();
    assert(!txt.includes('甲段落'), `screen shows 甲: ${shown}; saved file ${JSON.stringify(txt)}; title after save ${JSON.stringify(ttl)}; source after save ${JSON.stringify(srcAfterSave)}; after Esc ${JSON.stringify(srcAfterEsc)} title ${JSON.stringify(ttl2)}`);
  });

  await t('C2 typed 0 ms before a file drop onto the editing block → question asked; 取消 keeps text; 丢弃 → dropped doc exact', async () => {
    await session('乙段落文字。');
    await page.keyboard.type('新字');
    await drop('d1.md', '# 落下\n\n正文\n');
    await sleep(400);
    eq(await dialogs(), 1, 'question');
    await clickBtn('取消'); await sleep(300);
    assert((await B.source()).includes('乙段落文字。新字'), 'typed text after 取消');
    await drop('d2.md', '# 落下二\n\n正文\n');
    await sleep(400);
    eq(await dialogs(), 1, 'question 2');
    await clickBtn('丢弃'); await B.settle(400);
    eq(await B.source(), '# 落下二\n\n正文\n', 'new document');
  });

  await t('C3 emptied paragraph, then a file drop → question asked (deletion counts); 丢弃 → dropped doc exact', async () => {
    await session('甲段落文字。');
    await emptyIt();
    await drop('d3.md', '# 三\n\n正文\n');
    await sleep(400);
    eq(await dialogs(), 1, 'question');
    await clickBtn('丢弃'); await B.settle(400);
    eq(await B.source(), '# 三\n\n正文\n', 'new document');
  });

  await t('C4 emptied paragraph, ⇧⌘E (toggle off) → deletion written, no session, no contenteditable', async () => {
    await session('甲段落文字。');
    await emptyIt();
    await page.keyboard.press('ControlOrMeta+Shift+e'); await B.settle(300);
    const s = await B.source();
    const ce = await page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
    await page.keyboard.press('ControlOrMeta+Shift+e'); await sleep(200);
    assert(!s.includes('甲段落') && ce === 0, `source ${JSON.stringify(s)} ce ${ce}`);
  });

  await t('C5 emptied paragraph, ⌘/ (mode switch) → deletion written', async () => {
    await session('甲段落文字。');
    await emptyIt();
    await page.keyboard.press('ControlOrMeta+/'); await B.settle(300);
    const s = await B.source();
    await page.evaluate(() => window.__mdr.mode('split')); await sleep(200);
    assert(!s.includes('甲段落'), JSON.stringify(s));
  });
} finally {
  finish();
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
}
