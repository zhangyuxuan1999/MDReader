// bench/verify/v3-ses-r1.mjs — verify-session stage 2c: VARIATIONS of the r1 repros (docs/FINDINGS-0.2.0-r1.md) for
// G5, G6, G7, G11, G12, G13, G16 in real Chromium. Case names start with the group (g5-…, g16-…).
// A "slow worker" hook (as in v2-rev-browser.mjs race) delays structure deltas and HTML batches by DELAY ms to widen
// the resume / click-wait windows.
// Run: MDR_PORT=5382 node bench/verify/v3-ses-r1.mjs <name-filter>        (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, view, shownText, clickText, pointOf, undoTo, redoTo } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 118_000), B.close);
const { page } = B;
const settle = async (ms = 350) => { await sleep(ms); await B.settle(200); };
async function waitSession(ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
async function start(doc, needle, k = null) {
  await page.evaluate(() => { window.__delay = false; });
  await B.loadDoc(doc);
  await sleep(650);
  await clickText(page, needle, k ?? needle.length - 1, { side: 'right' });
  const v = await waitSession();
  if (!v.editing) throw new Error('no session ' + J(v).slice(0, 200));
}
async function slowWorker(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); window.__origFull = pv.applyStructure.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = true;
  }, ms);
}
const fast = () => page.evaluate(() => { window.__delay = false; });
const press = (k) => page.keyboard.press(k);
const type = (t) => page.keyboard.type(t);
const N = 'NEW DOC first para\n\nNEW DOC second para\n\n- [ ] new task\n';
const cases = [];
const def = (name, fn) => cases.push({ name, fn });

// ---------------------------------------------------------------- G16: pending things across a document replacement
def('g16-click-wait-then-replace', async () => {
  await start('alpha one\n\nbeta two\n\ngamma three\n', 'one');
  await B.caretAt('one'); await type('X');
  await slowWorker(400);
  await clickText(page, 'two', 1, { side: 'right' });      // the write of X is on its way: the click waits (U7)
  await type('QQ');
  await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
  await settle(1200);
  const v = await view(page);
  return { ok: v.src === N && !v.editing, detail: `src=${J(v.src)} editing=${J(v.editing && v.editing.text)} active=${v.active}` };
});
def('g16-toggle-wait-then-replace', async () => {
  await start('alpha one\n\n- [ ] task a\n- [ ] task b\n', 'one');
  await B.caretAt('one'); await type('X');
  await slowWorker(400);
  const box = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[0]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(box.x, box.y);
  await sleep(30);
  await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
  await settle(1000);
  const v = await view(page);
  return { ok: v.src === N, detail: `src=${J(v.src)}` };
});
def('g16-ghost-then-replace', async () => {
  await start('alpha one\n\nbeta two\n\ngamma three\n', 'two');
  await slowWorker(300);
  await press('Meta+a'); await press('Backspace');
  await sleep(60);
  await type('QQ');
  await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
  await settle(1000);
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === N && !v.ghost && !v.editing && J(sh) === J(['NEW DOC first para', 'NEW DOC second para', 'new task']), detail: `src=${J(v.src)} ghost=${v.ghost} editing=${J(v.editing)} shown=${J(sh)}` };
});
def('g16-undo-far-extension-then-replace', async () => {
  const doc = Array.from({ length: 400 }, (_, i) => `para ${i} text`).join('\n\n') + '\n';
  await start(doc, 'para 0 text');
  await B.caretAt('para 0 text'); await type('A'); await sleep(700);
  await B.esc();
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(799, 0, 'instant'));
  await sleep(700);
  await clickText(page, 'para 399 text', 3, { side: 'right' });
  await waitSession();
  await type('B'); await sleep(700);
  await slowWorker(500);
  await press('Meta+z'); await press('Meta+z');         // the second step lands at line 1, far away
  await sleep(50);
  await type('QQ');
  await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
  await settle(1500);
  const v = await view(page);
  return { ok: v.src === N && !v.editing, detail: `src=${J(v.src.slice(0, 80))} editing=${J(v.editing && v.editing.text)} cap=${v.capFocused}` };
});
def('g16-click-wait-dialog', async () => {
  await start('alpha one\n\nbeta two\n\ngamma three\n', 'one');
  await B.caretAt('one'); await type('X');
  await slowWorker(400);
  await clickText(page, 'two', 1, { side: 'right' });
  await sleep(20);
  await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
  await sleep(80);
  await fast();
  await sleep(900);
  const f = await page.evaluate(() => ({ dialog: !!document.querySelector('.mdr-dialog'), active: document.activeElement?.className ?? '' }));
  await page.keyboard.press('Escape');
  await sleep(200);
  const f2 = await page.evaluate(() => ({ dialog: !!document.querySelector('.mdr-dialog') }));
  await page.evaluate(() => { const b = document.querySelector('.mdr-dialog__btn'); if (b) b.click(); });
  return { ok: (!f.dialog || /mdr-dialog/.test(f.active)) && !f2.dialog, detail: `focus=${J(f)} afterEsc=${J(f2)}` };
});
// ---------------------------------------------------------------- G12: a history step far away
async function farDoc() {
  const doc = Array.from({ length: 600 }, (_, i) => `para ${i} text`).join('\n\n') + '\n';
  await start(doc, 'para 1 text');
  return doc;
}
def('g12-undo-far-unmounted-type', async () => {
  const doc = await farDoc();
  await B.caretAt('para 1 text'); await type('A'); await sleep(700);
  await B.esc();
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1199, 0, 'instant'));
  await sleep(800);
  await clickText(page, 'para 599 text', 3, { side: 'right' });
  await waitSession();
  await type('B'); await sleep(700);
  await press('Meta+z'); await press('Meta+z');
  await type('QQ');
  await settle(2500);
  const v = await view(page);
  const vis = await page.evaluate(() => { const e = document.querySelector('.mdr-preview .is-editing'); if (!e) return null; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  const line3 = v.src.split('\n')[2];
  return { ok: line3 === 'QQpara 1 text' || line3 === 'para 1 textQQ', detail: `line3=${J(line3)} B-undone=${!v.src.includes('textB')} editing=${J(v.editing && v.editing.text)} visible=${vis} cap=${v.capFocused}` };
});
def('g12-redo-far-type', async () => {
  const doc = await farDoc();
  await B.caretAt('para 1 text'); await type('A'); await sleep(700);
  await B.esc();
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1199, 0, 'instant'));
  await sleep(800);
  await clickText(page, 'para 599 text', 3, { side: 'right' });
  await waitSession();
  await type('B'); await sleep(700);
  await press('Meta+z'); await press('Meta+z');
  await settle(2500);
  // now at the top; scroll to the bottom by hand and redo twice: the second redo lands at the bottom
  const v0 = await view(page);
  await press('Meta+Shift+z'); await sleep(400);
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0, 'instant'));
  await press('Meta+Shift+z');
  await type('QQ');
  await settle(2500);
  const v = await view(page);
  const last = v.src.split('\n').filter(Boolean).pop();
  return { ok: /para 599 textB?QQ|QQpara 599/.test(last) && v.src.includes('para 1 textA'), detail: `top=${J(v0.editing && v0.editing.text)} last=${J(last)} line3=${J(v.src.split('\n')[2])} editing=${J(v.editing && v.editing.text)}` };
});
def('g12-undo-far-deleted-block', async () => {
  const doc = await farDoc();
  await press('Meta+a'); await press('Backspace'); await settle();
  await B.esc();
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1199, 0, 'instant'));
  await sleep(800);
  await clickText(page, 'para 599 text', 3, { side: 'right' });
  await waitSession();
  await type('B'); await sleep(700);
  await press('Meta+z'); await press('Meta+z');
  await type('QQ');
  await settle(2500);
  const v = await view(page);
  return { ok: v.src.includes('\n\nQQpara 1 text\n\n') || v.src.includes('\n\npara 1 textQQ\n\n'), detail: `head=${J(v.src.slice(0, 50))} editing=${J(v.editing && v.editing.text)} cap=${v.capFocused}` };
});
// ---------------------------------------------------------------- G13: lists, Tab / Shift-Tab
const LISTS = [
  ['g13-enter-tab-type-ol', '1. one\n2. two\n\nz\n', 'one', ['Enter', 'Tab', 'child'], '1. one\n   1. child\n2. two\n\nz\n'],
  ['g13-enter-tab-type-task', '- [ ] one\n- [ ] two\n\nz\n', 'one', ['Enter', 'Tab', 'child'], '- [ ] one\n  - [ ] child\n- [ ] two\n\nz\n'],
  ['g13-three-levels', '- a\n  - b\n    - c\n\nz\n', 'c', ['Enter', 'Tab', 'd'], '- a\n  - b\n    - c\n      - d\n\nz\n'],
  ['g13-three-levels-stab', '- a\n  - b\n    - c\n\nz\n', 'c', ['Enter', 'Shift+Tab', 'd'], '- a\n  - b\n    - c\n  - d\n\nz\n'],
  ['g13-stab-twice', '- a\n  - b\n    - c\n\nz\n', 'c', ['Enter', 'Shift+Tab', 'Shift+Tab', 'd'], '- a\n  - b\n    - c\n- d\n\nz\n'],
  ['g13-first-item-tab', '- a\n- b\n\nz\n', 'a', ['Tab', 'X'], '- aX\n- b\n\nz\n'],
  ['g13-top-stab', '- a\n- b\n\nz\n', 'b', ['Shift+Tab', 'X'], null],
  ['g13-empty-nested-enter', '- a\n  - b\n\nz\n', 'b', ['Enter', 'Enter', 'X'], '- a\n  - b\n- X\n\nz\n'],
  ['g13-empty-top-enter', '- a\n- b\n\nz\n', 'b', ['Enter', 'Enter', 'X'], '- a\n- b\n\nX\n\nz\n'],
  ['g13-tab-mid-text', '- a\n- bcd\n\nz\n', 'bc', ['Tab', 'X'], '- a\n  - bcXd\n\nz\n'],
  ['g13-enter-tab-tab-type', '- a\n  - b\n\nz\n', 'b', ['Enter', 'Tab', 'Tab', 'X'], null],
  ['g13-enter-mid-tab', '- one two\n- three\n\nz\n', 'one', ['Enter', 'Tab', 'X'], '- one\n  - Xtwo\n- three\n\nz\n'],
];
for (const [name, doc, needle, keys, exp] of LISTS) {
  def(name, async () => {
    await start(doc, needle);
    await B.caretAt(needle);
    for (const k of keys) { if (/^(Enter|Tab|Shift\+Tab|Backspace)$/.test(k)) await press(k); else await type(k); }
    await settle();
    const v = await view(page);
    const sh = await shownText(page);
    await B.esc(); await settle();
    const sh2 = await shownText(page);
    const ok = (exp === null ? true : v.src === exp) && J(sh) === J(sh2);
    return { ok, detail: `src=${J(v.src)} exp=${J(exp)} shown=${J(sh)} afterEsc=${J(sh2)}` };
  });
}
def('g13-sel-across-items-tab', async () => {
  await start('- a1\n- b2\n- c3\n\nz\n', 'b2');
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const lis = el.querySelectorAll('li');
    const r = document.createRange(); r.setStart(lis[1].firstChild, 1); r.setEnd(lis[2].firstChild, 1);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await press('Tab');
  await type('X');
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await B.esc(); await settle();
  const sh2 = await shownText(page);
  return { ok: J(sh) === J(sh2) && !v.src.includes('<'), detail: `src=${J(v.src)} shown=${J(sh)} afterEsc=${J(sh2)}` };
});
// ---------------------------------------------------------------- G11: two paragraph boundaries in one frame (same task)
async function sameFrame(steps) {
  await page.evaluate((steps) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    for (const s of steps) {
      if (s === 'Enter') el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      else document.execCommand('insertText', false, s);
    }
  }, steps);
}
for (const [name, doc, needle, steps, exp] of [
  ['g11-quote', '> abc\n\nnext\n', 'abc', ['Enter', 'def', 'Enter'], '> abc\n>\n> def\n>\n> ghi\n\nnext\n'],
  ['g11-list', '- abc\n\nnext\n', 'abc', ['Enter', 'def', 'Enter'], '- abc\n- def\n- ghi\n\nnext\n'],
  ['g11-heading', '# abc\n\nnext\n', 'abc', ['Enter', 'def', 'Enter'], '# abc\n\ndef\n\nghi\n\nnext\n'],
  ['g11-para-three', 'abc\n\nnext\n', 'abc', ['Enter', 'def', 'Enter', 'ghi', 'Enter'], 'abc\n\ndef\n\nghi\n\njkl\n\nnext\n'],
  ['g11-para-mid', 'abc xyz\n\nnext\n', 'abc', ['Enter', 'def', 'Enter'], 'abc\n\ndef\n\nghixyz\n\nnext\n'],
]) {
  def(name, async () => {
    await start(doc, needle);
    await B.caretAt(needle);
    await sameFrame(steps);
    await type(name === 'g11-para-three' ? 'jkl' : 'ghi');
    await settle(600);
    const v = await view(page);
    return { ok: v.src === exp, detail: `src=${J(v.src)} exp=${J(exp)}` };
  });
}
// ---------------------------------------------------------------- G5: Shift+Enter / paste at formatting edges
for (const [name, doc, needle, where, act, bad] of [
  ['g5-em-end-shift', 'abc *emph* def\n', 'emph', 'after', 'shift', /<em|<\/em|<br/],
  ['g5-em-start-shift', 'abc *emph* def\n', 'emph', 'before', 'shift', /<em|<\/em|<br/],
  ['g5-del-end-shift', 'abc ~~gone~~ def\n', 'gone', 'after', 'shift', /<del|<s>|<br/],
  ['g5-link-start-shift', 'abc [link](http://e.com/) def\n', 'link', 'before', 'shift', /<a |<br/],
  ['g5-code-end-shift', 'abc `code` def\n', 'code', 'after', 'shift', /<code|<br/],
  ['g5-code-mid-shift', 'abc `code` def\n', 'co', 'after', 'shift', /<code|<br/],
  ['g5-bolditalic-end-shift', 'abc ***both*** def\n', 'both', 'after', 'shift', /<strong|<em|<br/],
  ['g5-bold-start-para-shift', '**Bold** rest *em* `c`\n', 'Bold', 'before', 'shift', /<strong|<br/],
  ['g5-bold-end-paste', 'abc **bold** def\n', 'bold', 'after', 'paste', /<strong|<br/],
  ['g5-em-start-paste', '*emph* def\n', 'emph', 'before', 'paste', /<em|<br/],
  ['g5-code-mid-paste', 'abc `code` def\n', 'co', 'after', 'paste', /<code|<br/],
  ['g5-link-end-paste', 'abc [link](http://e.com/) def\n', 'link', 'after', 'paste', /<a |<br/],
  ['g5-heading-bold-shift', '# abc **bold** def\n', 'bold', 'after', 'shift', /<strong/],
]) {
  def(name, async () => {
    await start(doc, needle.length > 2 ? needle : 'abc');
    await B.caretAt(needle, where);
    if (act === 'shift') await press('Shift+Enter');
    else { await page.evaluate(() => navigator.clipboard.writeText('X\nY')); await press('Meta+v'); }
    await type('Q');
    await settle();
    const v = await view(page);
    const sh = await shownText(page);
    await B.esc(); await settle();
    const sh2 = await shownText(page);
    const ok = !bad.test(v.src) && J(sh) === J(sh2);
    return { ok, detail: `src=${J(v.src)} shown=${J(sh)} afterEsc=${J(sh2)}` };
  });
}
// ---------------------------------------------------------------- G6: large paste into other block kinds
for (const [name, doc, needle] of [['g6-list-item', '- abc def\n- two\n', 'abc'], ['g6-quote', '> abc def\n\nz\n', 'abc'], ['g6-cell', '| h |\n|---|\n| abc def |\n', 'abc'], ['g6-heading', '# abc def\n\nz\n', 'abc']]) {
  def(name, async () => {
    await start(doc, needle);
    await B.caretAt(needle);
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i} of the pasted text here`).join('\n').slice(0, 50000);
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    const t0 = Date.now();
    await press('Meta+v');
    const tPaste = Date.now() - t0;
    const t1 = Date.now();
    await type('Q');
    const tKey = Date.now() - t1;
    await settle(1500);
    const v = await view(page);
    const t2 = Date.now();
    await B.esc();
    const tEsc = Date.now() - t2;
    return { ok: tPaste < 3000 && tKey < 1500 && v.src.length > 40000 || /太长/.test(v.toast), detail: `paste=${tPaste}ms key=${tKey}ms esc=${tEsc}ms len=${v.src.length} toast=${J(v.toast)} live=${!!v.editing}` };
  });
}
// ---------------------------------------------------------------- G7: the deletion is in the source when flushEditSession returns
for (const [name, doc, needle] of [['g7-flush-sync-para', 'a\n\nmid\n\nz\n', 'mid'], ['g7-flush-sync-first-lead', '\nmid\n\nz\n', 'mid'], ['g7-flush-sync-last', 'a\n\nmid', 'mid']]) {
  def(name, async () => {
    await start(doc, needle);
    await press('Meta+a');
    const r = await page.evaluate(() => {
      document.execCommand('delete');
      window.__mdr.app.preview.flushEditSession();
      return window.__mdr.app.getText();
    });
    await settle();
    const v = await view(page);
    return { ok: !r.includes('mid') && r === v.src, detail: `atFlush=${J(r)} later=${J(v.src)}` };
  });
}

let bad = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      const r = await c.fn();
      if (!check(c.name, r.ok, r.detail)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await fast(); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
