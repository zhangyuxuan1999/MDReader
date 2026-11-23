// bench/verify/v3-ses-probe.mjs — verify-session stage 2c: assorted session probes in real Chromium (emptied block
// follow-ups, tight neighbours, P1's class of history resumes, U13 Enter before whitespace, resume-window keys).
// Each case prints PASS / FAIL with the exact sources. Run one group with a name filter:
//   MDR_PORT=5382 node bench/verify/v3-ses-probe.mjs <name-filter>        (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, results, view, shownText, clickText, undoTo, redoTo, NBSP, IDSP } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
async function waitSession(ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
async function start(doc, needle, k = null, side = 'right') {
  await B.loadDoc(doc);
  const o = await B.source();
  if (o !== doc) throw new Error('loaded ' + J(o));
  await sleep(650);
  await clickText(page, needle, k ?? needle.length - 1, { side });
  const v = await waitSession();
  if (!v.editing) throw new Error('no session ' + J(v));
  return o;
}
/** Caret right after (or before) `needle` inside the session block. */
const at = (needle, where = 'after') => B.caretAt(needle, where);
const press = (k) => page.keyboard.press(k);
const type = (t) => page.keyboard.type(t);

const cases = [];
const def = (name, fn) => cases.push({ name, fn });

// ---------------------------------------------------------------- U9 follow-ups
def('empty-then-bs-next-kept', async () => {
  const doc = 'a\n\nsame\n\nnext\n\nz\n';
  const orig = await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  const s1 = await B.source();
  await press('Backspace'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  const ok = s1 === 'a\n\nnext\n\nz\n' && v.src.includes('next') && v.src.includes('z');
  const u = await undoTo(B, orig, 10);
  return { ok: ok && u.ok, detail: `afterEmpty=${J(s1)} afterBs=${J(v.src)} shown=${J(sh)} editing=${J(v.editing && v.editing.text)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}` };
});
def('empty-then-bs-next-kept-list', async () => {
  const doc = 'a\n\n- one\n- two\n\nnext\n\nz\n';
  const orig = await start(doc, 'one');
  await press('Meta+a'); await press('Backspace'); await settle();
  const s1 = await B.source();
  await press('Backspace'); await settle();
  const v = await view(page);
  const ok = v.src.includes('next') && v.src.includes('z');
  const u = await undoTo(B, orig, 10);
  return { ok: ok && u.ok, detail: `afterEmpty=${J(s1)} afterBs=${J(v.src)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}` };
});
def('empty-then-bs-twice', async () => {
  const doc = 'a\n\nsame\n\nnext\n\nz\n';
  const orig = await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await press('Backspace'); await settle();
  const s2 = await B.source();
  await press('Backspace'); await settle();
  const v = await view(page);
  const ok = v.src.includes('next') && v.src.includes('z');
  const u = await undoTo(B, orig, 10);
  return { ok: ok && u.ok, detail: `after2=${J(s2)} after3=${J(v.src)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}` };
});
def('empty-then-delete-fwd', async () => {
  const doc = 'a\n\nsame\n\nnext\n\nz\n';
  const orig = await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await press('Delete'); await settle();
  const v = await view(page);
  const ok = v.src.includes('next') && v.src.includes('z') && v.src.includes('a');
  const u = await undoTo(B, orig, 10);
  return { ok: ok && u.ok, detail: `afterDel=${J(v.src)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}` };
});
def('empty-then-enter-type', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  const orig = await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await press('Enter'); await settle();
  const s1 = await B.source();
  await type('N'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await B.esc(); await settle();
  const sh2 = await shownText(page);
  const ok = s1 === 'a\n\nz\n' && J(sh) === J(sh2) && v.src.includes('N');
  return { ok, detail: `afterEnter=${J(s1)} final=${J(v.src)} shown=${J(sh)} afterEsc=${J(sh2)}` };
});
def('empty-then-esc-click-type', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await press('Escape'); await settle();
  const s1 = await B.source();
  const sh1 = await shownText(page);
  await clickText(page, 'z', 0, { side: 'right' });
  await waitSession();
  await type('Q'); await settle();
  const v = await view(page);
  return { ok: s1 === 'a\n\nz\n' && v.src === 'a\n\nzQ\n' && J(sh1) === J(['a', 'z']), detail: `afterEsc=${J(s1)} shown=${J(sh1)} final=${J(v.src)}` };
});
def('empty-then-click-other-fast', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace');
  await sleep(5);
  await clickText(page, 'z', 0, { side: 'right' });
  await type('Q'); await settle(500);
  const v = await view(page);
  return { ok: v.src === 'a\n\nzQ\n', detail: `final=${J(v.src)} editing=${J(v.editing && v.editing.text)}` };
});
def('empty-two-blocks-fast', async () => {
  const doc = 'a\n\nb1\n\nb2\n\nz\n';
  await start(doc, 'b1');
  await press('Meta+a'); await press('Backspace');
  await sleep(30);
  await clickText(page, 'b2', 1, { side: 'right' });
  await waitSession(800);
  await press('Meta+a'); await press('Backspace'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await type('N'); await settle();
  const v2 = await view(page);
  const sh2 = await shownText(page);
  return { ok: v.src === 'a\n\nz\n' && v2.src === 'a\n\nN\n\nz\n' && J(sh2) === J(['a', 'N', 'z']), detail: `afterEmpty=${J(v.src)} shown=${J(sh)} typed=${J(v2.src)} shown2=${J(sh2)}` };
});
def('empty-then-mode-switch', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace');
  await page.evaluate(() => window.__mdr.mode('source'));
  await settle();
  const s1 = await B.source();
  await page.evaluate(() => window.__mdr.mode('split'));
  await settle();
  const sh = await shownText(page);
  const v = await view(page);
  return { ok: s1 === 'a\n\nz\n' && J(sh) === J(['a', 'z']) && !v.editing, detail: `src=${J(s1)} shown=${J(sh)} editing=${J(v.editing)}` };
});
def('empty-then-replace-doc', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace');
  await sleep(5);
  await page.evaluate(() => window.__mdr.loadText('NEW one\n\nNEW two\n', 'n.md'));
  await type('Q');
  await settle(500);
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === 'NEW one\n\nNEW two\n' && J(sh) === J(['NEW one', 'NEW two']) && !v.editing, detail: `src=${J(v.src)} shown=${J(sh)} editing=${J(v.editing)}` };
});
def('empty-then-editor-edit-above', async () => {
  // split mode: while the emptied element lives, the editor pane inserts lines above it
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'top1\n\ntop2\n\n' } }); });
  await settle();
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
  const v0 = await view(page);
  await type('N'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === 'top1\n\ntop2\n\na\n\nN\n\nz\n' && J(sh) === J(['top1', 'top2', 'a', 'N', 'z']), detail: `editingBefore=${!!v0.editing} src=${J(v.src)} shown=${J(sh)}` };
});
def('empty-then-editor-edit-below', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const d = v.state.doc; v.dispatch({ changes: { from: d.length, insert: 'tail\n' } }); });
  await settle();
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
  await type('N'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === 'a\n\nN\n\nz\ntail\n' && J(sh) === J(['a', 'N', 'z tail']), detail: `src=${J(v.src)} shown=${J(sh)}` };
});
def('empty-then-edit-prev-in-editor', async () => {
  // the block before the emptied element changes its line count in the editor (split mode)
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await press('Meta+a'); await press('Backspace'); await settle();
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 1, insert: '\na2\n\na3' } }); });
  await settle();
  await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); if (el) el.focus(); });
  const v0 = await view(page);
  await type('N'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src === 'a\na2\n\na3\n\nN\n\nz\n' && J(sh) === J(['a a2', 'a3', 'N', 'z']), detail: `editing=${!!v0.editing} src=${J(v.src)} shown=${J(sh)}` };
});
// Backspace in the emptied element (U9 ghost) once its deletion is written: what the next block becomes
for (const [nm, nextSrc] of [['para', 'next words'], ['heading', '## Next heading'], ['fence', '```\ncode line\n```'], ['list', '- li one\n- li two'], ['quote', '> quoted next'], ['table', '| h |\n|---|\n| c |']]) {
  def(`ghost-bs-next-${nm}`, async () => {
    const doc = `before words\n\nmiddle\n\n${nextSrc}\n\nend\n`;
    const orig = await start(doc, 'middle');
    await press('Meta+a'); await press('Backspace'); await settle();
    const s1 = await B.source();
    const sh1 = await shownText(page);
    await press('Backspace'); await settle();
    const v = await view(page);
    const sh = await shownText(page);
    const ok = v.src.includes(`before words\n\n${nextSrc}\n`) || v.src === s1;
    const u = await undoTo(B, orig, 10);
    return { ok: ok && u.ok, detail: `afterEmpty=${J(s1)} shownEmpty=${J(sh1)} afterBs=${J(v.src)} shown=${J(sh)} editing=${J(v.editing && v.editing.text.slice(0, 40))} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}` };
  });
}
def('control-replace-doc-no-empty', async () => {
  const doc = 'a\n\nsame\n\nz\n';
  await start(doc, 'same');
  await type('x');
  await sleep(5);
  await page.evaluate(() => window.__mdr.loadText('NEW one\n\nNEW two\n', 'n.md'));
  await type('Q');
  await settle(500);
  const v = await view(page);
  return { ok: v.src === 'NEW one\n\nNEW two\n', detail: `src=${J(v.src)} active=${v.active} editing=${J(v.editing)}` };
});
// ---------------------------------------------------------------- tight neighbours (no blank line between blocks)
def('tight-list-del-merges', async () => {
  const doc = 'Intro text:\n- item one\n- item two\n\nNext paragraph.\n';
  const orig = await start(doc, 'item one');
  await press('Meta+a'); await press('Backspace'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await type('N'); await settle();
  const v2 = await view(page);
  const sh2 = await shownText(page);
  const u = await undoTo(B, orig, 8);
  return { ok: J(sh) === J(['Intro text:', 'Next paragraph.']) && J(sh2) === J(['Intro text:', 'N', 'Next paragraph.']), detail: `afterEmpty=${J(v.src)} shown=${J(sh)} typed=${J(v2.src)} shown2=${J(sh2)} undo=${u.ok ? u.n : 'FAIL'}` };
});
def('tight-heading-del-merges', async () => {
  const doc = 'First para.\n## Section\n\nSecond para.\n';
  const orig = await start(doc, 'Section');
  await press('Meta+a'); await press('Backspace'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await type('N'); await settle();
  const v2 = await view(page);
  const sh2 = await shownText(page);
  const u = await undoTo(B, orig, 8);
  return { ok: J(sh) === J(['First para.', 'Second para.']) && J(sh2) === J(['First para.', 'N', 'Second para.']), detail: `afterEmpty=${J(v.src)} shown=${J(sh)} typed=${J(v2.src)} shown2=${J(sh2)} undo=${u.ok ? u.n : 'FAIL'}` };
});
def('tight-heading-bs-merges', async () => {
  const doc = 'First para.\n## Sec\n\nSecond para.\n';
  await start(doc, 'Sec');
  for (let i = 0; i < 3; i++) await press('Backspace');
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: J(sh) === J(['First para.', 'Second para.']), detail: `afterEmpty=${J(v.src)} shown=${J(sh)} editing=${J(v.editing && v.editing.text)}` };
});
def('tight-heading-only-para', async () => {
  // heading tight after a paragraph and followed by one: the screen shows three blocks
  const doc = 'para one\n# Head\npara two\n';
  await start(doc, 'Head');
  const before = await shownText(page);
  for (let i = 0; i < 4; i++) await press('Backspace');
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: !/para one\s*para two|para one para two/.test(sh.join('|')) && v.src.includes('para two'), detail: `before=${J(before)} afterEmpty=${J(v.src)} shown=${J(sh)} editing=${J(v.editing && v.editing.text)}` };
});
def('tight-heading-only-para-type', async () => {
  const doc = 'para one\n# Head\npara two\n';
  await start(doc, 'Head');
  for (let i = 0; i < 4; i++) await press('Backspace');
  await settle();
  const v0 = await view(page);
  await type('Q'); await settle(3200);
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: v.src.includes('Q') && J(sh).includes('Q'), detail: `after3s active=${v.active} afterBs=${J(v0.src)} editing0=${J(v0.editing && v0.editing.text)} active0=${v0.active} afterQ=${J(v.src)} shown=${J(sh)} editing=${J(v.editing && v.editing.text)}` };
});
def('tight-quote-del', async () => {
  const doc = 'para one\n> quoted\n\npara two\n';
  await start(doc, 'quoted');
  await press('Meta+a'); await press('Backspace'); await settle();
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: J(sh) === J(['para one', 'para two']), detail: `afterEmpty=${J(v.src)} shown=${J(sh)}` };
});
def('tight-code-del', async () => {
  const doc = 'para one\n```\ncode\n```\n\npara two\n';
  await start(doc, 'code');
  await press('Meta+a'); await press('Backspace'); await settle();
  const before = await B.source();
  return { ok: true, detail: `note: src=${J(before)} shown=${J(await shownText(page))}` };
});
def('tight-last-block-final-newline', async () => {
  const doc = 'para one\n# Head\n';
  await start(doc, 'Head');
  await press('Meta+a'); await press('Backspace'); await settle();
  const v = await view(page);
  return { ok: v.src === 'para one\n', detail: `afterEmpty=${J(v.src)}` };
});
// ---------------------------------------------------------------- P1's class: a history resume whose block does not exist
async function historyProbe(doc, needle, edit, presses, expectSrc) {
  const orig = await start(doc, needle);
  await edit();
  await settle();
  const fin = await B.source();
  const out = [];
  for (const k of presses) {
    await press(k);
    await sleep(120);
    out.push(await B.source());
  }
  // keys typed right after: they must land somewhere visible, not vanish
  await type('QW');
  await settle(600);
  const v = await view(page);
  const t0 = Date.now();
  let v2 = v;
  while (Date.now() - t0 < 3500 && v2.capFocused) { await sleep(200); v2 = await view(page); }
  const waited = Date.now() - t0;
  return { orig, fin, out, after: v.src, v, v2, waited };
}
def('p1-undo-removes-last-block', async () => {
  const r = await historyProbe('abc\n', 'abc', async () => { await at('abc'); await press('Enter'); await type('def'); }, ['Meta+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused;
  return { ok, detail: `fin=${J(r.fin)} afterUndo=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused} waited=${r.waited}` };
});
def('p1-undo-removes-first-block', async () => {
  const r = await historyProbe('abc\n', 'abc', async () => { await at('abc', 'before'); await press('Enter'); await press('ArrowUp'); await type('new'); }, ['Meta+z', 'Meta+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused;
  return { ok, detail: `fin=${J(r.fin)} afterUndos=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused}` };
});
def('p1-undo-paste-paras-at-end', async () => {
  const r = await historyProbe('abc\n', 'abc', async () => {
    await at('abc');
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '\n\np1\n\np2\n\np3'); document.querySelector('.mdr-preview .is-editing').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  }, ['Meta+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused && r.out[0] === 'abc\n';
  return { ok, detail: `fin=${J(r.fin)} afterUndo=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused}` };
});
def('p1-redo-reinserted-after-undo-delete', async () => {
  // empty a middle block, ⌘Z brings it back, ⇧⌘Z deletes it again: where does the session go
  const r = await historyProbe('a\n\nmid\n\nz\n', 'mid', async () => { await press('Meta+a'); await press('Backspace'); await settle(); await press('Meta+z'); await settle(); }, ['Meta+Shift+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused;
  return { ok, detail: `fin=${J(r.fin)} afterRedo=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused} waited=${r.waited}` };
});
def('p1-redo-delete-last-block', async () => {
  const r = await historyProbe('a\n\nlast\n', 'last', async () => { await press('Meta+a'); await press('Backspace'); await settle(); await press('Meta+z'); await settle(); }, ['Meta+Shift+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused;
  return { ok, detail: `fin=${J(r.fin)} afterRedo=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused} waited=${r.waited}` };
});
def('p1-undo-only-list-item', async () => {
  const r = await historyProbe('- one\n', 'one', async () => { await at('one'); await press('Enter'); await type('two'); await settle(); }, ['Meta+z', 'Meta+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused;
  return { ok, detail: `fin=${J(r.fin)} afterUndos=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused}` };
});
def('p1-undo-merge', async () => {
  const r = await historyProbe('aaa\n\nbbb\n', 'bbb', async () => { await at('bbb', 'before'); await press('Backspace'); await settle(); await type('X'); }, ['Meta+z', 'Meta+z'], null);
  const ok = r.after.includes('QW') && !r.v2.capFocused;
  return { ok, detail: `fin=${J(r.fin)} afterUndos=${J(r.out)} afterTyping=${J(r.after)} cap=${r.v.capFocused} editing=${J(r.v.editing && r.v.editing.text)} capStill=${r.v2.capFocused}` };
});
def('p1-undo-after-editor-replace-all', async () => {
  const doc = 'one\n\ntwo\n\nthree\n';
  await start(doc, 'two');
  await at('two'); await type('X'); await settle();
  await B.esc(); await settle();
  // replace-all in the editor: every block changes
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const t = v.state.doc.toString(); v.dispatch({ changes: { from: 0, to: t.length, insert: t.replace(/o/g, '0') } }); });
  await settle();
  await clickText(page, 'thr', 2, { side: 'right' });
  await waitSession();
  await at('thr'); await type('Y'); await settle();
  const fin = await B.source();
  const out = [];
  for (let i = 0; i < 3; i++) { await press('Meta+z'); await sleep(150); await B.settle(100); out.push(await B.source()); }
  await type('Q'); await settle(500);
  const v = await view(page);
  return { ok: v.src.includes('Q') && !v.capFocused, detail: `fin=${J(fin)} undos=${J(out)} after=${J(v.src)} cap=${v.capFocused} editing=${J(v.editing && v.editing.text)}` };
});

// ---------------------------------------------------------------- misc: toggling editing while the emptied element lives, drag and drop, U14 kinds
def('ghost-toggle-editable', async () => {
  await start('a\n\nmid\n\nz\n', 'mid');
  await press('Meta+a'); await press('Backspace'); await settle();
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable(false));
  await settle();
  const v = await view(page);
  const sh = await shownText(page);
  await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable(true));
  await type('Q'); await settle();
  const v2 = await view(page);
  return { ok: v.src === 'a\n\nz\n' && !v.ghost && !v.editing && J(sh) === J(['a', 'z']) && v2.src === 'a\n\nz\n', detail: `src=${J(v.src)} ghost=${v.ghost} editing=${!!v.editing} shown=${J(sh)} afterQ=${J(v2.src)}` };
});
def('drag-selection-to-editor', async () => {
  await start('abc def ghi\n\nzzz\n', 'def');
  await B.selectText('def');
  const a = await page.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const b = await page.evaluate(() => { const l = document.querySelectorAll('.cm-line')[2]; const r = l.getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; });
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10); await sleep(20); }
  await page.mouse.up();
  await settle(600);
  const v = await view(page);
  const n = (v.src.match(/def/g) || []).length;
  return { ok: n === 1, detail: `src=${J(v.src)} copiesOfDef=${n} editing=${!!v.editing}` };
});
def('drag-selection-inside-session', async () => {
  await start('abc def ghi\n\nzzz\n', 'def');
  await B.selectText('def');
  const a = await page.evaluate(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const { pointOf } = await import('./v3-ses-lib.mjs');
  const b = await pointOf(page, 'ghi', 3, 'right');
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10); await sleep(20); }
  await page.mouse.up();
  await settle(500);
  const v = await view(page);
  const n = (v.src.match(/def/g) || []).length;
  return { ok: n === 1, detail: `src=${J(v.src)} copiesOfDef=${n} editing=${!!v.editing}` };
});
for (const [nm, doc, needle, keys, exp] of [
  ['u14-list-lead', '\n- a1\n- b2\n\nz\n', 'b2', ['Enter', 'c3'], '\n- a1\n- b2\n- c3\n\nz\n'],
  ['u14-heading-lead-ws', '  \n# Head\n\nz\n', 'Head', ['X'], '  \n# HeadX\n\nz\n'],
  ['u14-code-lead', '\n```\ncode\n```\n\nz\n', 'code', ['Enter', 'more'], '\n```\ncode\nmore\n```\n\nz\n'],
  ['u14-quote-lead-split', '\t\n> qq rr\n\nz\n', 'qq', ['Enter', 'S'], '\t\n> qq\n>\n> Srr\n\nz\n'],
  ['u14-para-lead-enter-start', '\nabc\n\nz\n', 'abc', ['Home', 'Enter', 'S'], null],
  ['u14-table-lead', '\n| h |\n|---|\n| c |\n\nz\n', 'c', ['X'], '\n| h |\n|---|\n| cX |\n\nz\n'],
]) {
  def(nm, async () => {
    const orig = await start(doc, needle);
    await at(needle);
    for (const k of keys) { if (/^(Enter|Home|Backspace)$/.test(k)) await press(k === 'Home' ? 'Meta+ArrowLeft' : k); else await type(k); }
    await settle();
    const v = await view(page);
    const u = await undoTo(B, orig, 8);
    const r = await redoTo(B, v.src, 8);
    const ok = (exp === null ? v.src.startsWith('\n') : v.src === exp) && u.ok && r.ok;
    return { ok, detail: `src=${J(v.src)} exp=${J(exp)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)} redo=${r.ok ? r.n : 'FAIL'}` };
  });
}
def('ime-open-then-click-other', async () => {
  await start('alpha one\n\nbeta two\n', 'one');
  await at('one');
  await B.ime(['z', 'zh', 'zho'], undefined);        // composition left open
  await sleep(80);
  await clickText(page, 'two', 2, { side: 'right' });
  await sleep(300);
  await type('Q'); await settle(600);
  const v = await view(page);
  return { ok: v.src.includes('twoQ') && (v.src.startsWith('alpha onezho\n') || v.src.startsWith('alpha one\n')), detail: `src=${J(v.src)} editing=${J(v.editing && v.editing.text)}` };
});
def('ime-open-then-esc', async () => {
  await start('alpha one\n\nbeta two\n', 'one');
  await at('one');
  await B.ime(['n', 'ni'], undefined);
  await sleep(80);
  await press('Escape');
  await settle(500);
  const v = await view(page);
  const sh = await shownText(page);
  return { ok: J(sh) === J(v.src.split('\n\n').map((x) => x.trim()).filter(Boolean)), detail: `src=${J(v.src)} shown=${J(sh)} editing=${!!v.editing}` };
});
def('ime-commit-then-enter-fast', async () => {
  await start('alpha one\n\nbeta two\n', 'one');
  await at('one');
  await B.ime(['z', 'zh'], '中');
  await press('Enter');
  await B.ime(['w'], '文');
  await settle(600);
  const v = await view(page);
  return { ok: v.src === 'alpha one中\n\n文\n\nbeta two\n', detail: `src=${J(v.src)}` };
});
// fuzz seed 11 (timing): a paste that makes paragraphs at the start of a paragraph, then Backspace at once
for (const d of [0, 5, 10, 20, 35, 60, 120]) {
  def(`paste-split-then-bs-${d}ms`, async () => {
    await start('before\n\nabcdef\n\nafter\n', 'abc');
    await at('abc', 'before');
    await page.evaluate(() => navigator.clipboard.writeText('vao\n\nz'));
    await press('Meta+v');
    if (d) await sleep(d);
    await press('Backspace');
    await settle(700);
    const v = await view(page);
    const sel = v.caret;
    return { ok: v.src === 'before\n\nvao\n\nabcdef\n\nafter\n' && v.editing && v.editing.text.replace(/\n+$/, '') === 'abcdef' && sel === 0, detail: `src=${J(v.src)} editing=${J(v.editing && v.editing.text)} caret=${sel}` };
  });
}
for (const d of [0, 0, 0, 2]) {
  def(`paste-split-then-bs-type-${d}ms`, async () => {
    await start('before\n\nabcdef\n\nafter\n', 'abc');
    await at('abc', 'before');
    await page.evaluate(() => navigator.clipboard.writeText('vao\n\nz'));
    await press('Meta+v');
    if (d) await sleep(d);
    await press('Backspace');
    await settle(700);
    const v0 = await view(page);
    const html0 = v0.editing && v0.editing.html;
    await type('Q');
    await settle(700);
    const v = await view(page);
    const sh = await shownText(page);
    await B.esc(); await settle();
    const sh2 = await shownText(page);
    return { ok: v.src === 'before\n\nvao\n\nQabcdef\n\nafter\n' && J(sh) === J(sh2), detail: `src0=${J(v0.src)} html0=${J(html0)} afterQ=${J(v.src)} shown=${J(sh)} afterEsc=${J(sh2)}` };
  });
}
// the same without a fast key: a pasted last paragraph that serializes to nothing (a space, a tab) leaves the rest of
// the caret's paragraph identical to the old block
for (const [nm, clip] of [['space', 'vao\n\n '], ['tab', 'vao\n\n\t'], ['spaces', 'vao\n\n   '], ['two-paras-space', 'vao\n\nwuu\n\n ']]) {
  def(`paste-split-identical-tail-${nm}`, async () => {
    await start('before\n\nabcdef\n\nafter\n', 'abc');
    await at('abc', 'before');
    await page.evaluate((t) => navigator.clipboard.writeText(t), clip);
    await press('Meta+v');
    await settle(800);
    const v0 = await view(page);
    await type('Q');
    await settle(700);
    const v = await view(page);
    const sh = await shownText(page);
    await B.esc(); await settle();
    const sh2 = await shownText(page);
    const dup = (v.src.match(/ao/g) || []).length;          // "vao" once (typing Q may land inside it)
    return { ok: dup === 1 && J(sh) === J(sh2), detail: `src0=${J(v0.src)} html0=${J(v0.editing && v0.editing.html)} afterQ=${J(v.src)} shown=${J(sh)} afterEsc=${J(sh2)}` };
  });
}
// fuzz seed 110 (human speed, deterministic): a block typed into an emptied element, then a click at its start and a paste
for (const [nm, emoji, esc, how] of [['ime-esc-paste', true, true, 'paste'], ['kb-esc-paste', false, true, 'paste'], ['ime-noesc-paste', true, false, 'paste'], ['ime-esc-type', true, true, 'type'], ['plain-esc-paste', null, true, 'paste']]) {
  def(`reinserted-click-start-${nm}`, async () => {
    await start('aaa\n\nmid\n\nzzz\n', 'mid');
    await press('Meta+a'); await press('Backspace'); await settle();
    await type('xy'); await settle();
    if (emoji === true) await B.ime(['x'], String.fromCodePoint(0x1f389));
    else if (emoji === false) await type(String.fromCodePoint(0x1f389));
    await settle();
    const s1 = await B.source();
    if (esc) { await press('Escape'); await settle(); }
    const { pointOf } = await import('./v3-ses-lib.mjs');
    await sleep(700);
    const p = await pointOf(page, 'xy', 0, 'left');
    await page.mouse.click(p.x, p.y);
    await waitSession();
    const v0 = await view(page);
    if (how === 'paste') { await page.evaluate(() => navigator.clipboard.writeText('bqf')); await press('Meta+v'); }
    else await type('bqf');
    await settle(600);
    const v = await view(page);
    const want = s1.replace('xy', 'bqfxy');
    return { ok: v.src === want, detail: `beforeClick=${J(s1)} caret=${v0.caret} html0=${J(v0.editing && v0.editing.html)} after=${J(v.src)} want=${J(want)}` };
  });
}
// a click at the very start of a paragraph (no session before), then a paste
for (const [nm, doc, needle, clip] of [
  ['para', 'aaa\n\nxyz words\n\nzzz\n', 'xyz', 'bqf'],
  ['para-first-block', 'xyz words\n\nzzz\n', 'xyz', 'bqf'],
  ['heading', 'aaa\n\n# xyz words\n\nzzz\n', 'xyz', 'bqf'],
  ['quote', 'aaa\n\n> xyz words\n\nzzz\n', 'xyz', 'bqf'],
  ['li', 'aaa\n\n- xyz words\n\nzzz\n', 'xyz', 'bqf'],
  ['para-2lines', 'aaa\n\nxyz words\n\nzzz\n', 'xyz', 'b1\nb2'],
]) {
  def(`click-start-paste-${nm}`, async () => {
    await B.loadDoc(doc); await sleep(700);
    const { pointOf } = await import('./v3-ses-lib.mjs');
    const p = await pointOf(page, needle, 0, 'left');
    await page.mouse.click(p.x, p.y);
    await waitSession();
    const sel = await page.evaluate(() => { const s = getSelection(); const n = s.anchorNode; return { node: n ? (n.nodeType === 3 ? 'text:' + JSON.stringify(n.data.slice(0, 8)) : n.nodeName) : null, off: s.anchorOffset }; });
    await page.evaluate((t) => navigator.clipboard.writeText(t), clip);
    await press('Meta+v');
    await settle(600);
    const v = await view(page);
    const want = clip.includes('\n') ? doc.replace(needle, clip.replace('\n', '  \n') + needle) : doc.replace(needle, clip + needle);
    return { ok: v.src === want, detail: `caretAt=${J(sel)} after=${J(v.src)} want=${J(want)}` };
  });
}
// a session ended with Esc, then a click at the very start of the same paragraph and a paste (fuzz seed 110)
for (const [nm, prep] of [['esc-typed', 'type'], ['esc-untouched', 'none'], ['click-away-control', 'away']]) {
  def(`esc-then-click-start-paste-${nm}`, async () => {
    await B.loadDoc('aaa\n\nxyz words\n\nzzz\n'); await sleep(700);
    await clickText(page, 'words', 4, { side: 'right' });
    await waitSession();
    if (prep !== 'none') await type('Q');
    if (prep === 'away') await clickText(page, 'zzz', 1); else await press('Escape');
    await sleep(1200);
    const { pointOf } = await import('./v3-ses-lib.mjs');
    const p = await pointOf(page, 'xyz', 0, 'left');
    await page.mouse.click(p.x, p.y);
    await waitSession();
    const sel = await page.evaluate(() => { const s = getSelection(); const n = s.anchorNode; return { node: n ? (n.nodeType === 3 ? 'text' : n.nodeName) : null, off: s.anchorOffset }; });
    await page.evaluate(() => navigator.clipboard.writeText('bqf'));
    await press('Meta+v');
    await settle(600);
    const v = await view(page);
    const want = 'aaa\n\nbqfxyz words' + (prep !== 'none' ? 'Q' : '') + '\n\nzzz\n';
    return { ok: v.src === want, detail: `caret=${J(sel)} after=${J(v.src)} want=${J(want)}` };
  });
}
// ---------------------------------------------------------------- caret after a history step (trailing blank lines)
const CARET = [
  // name, doc, needle (caret after), actions before ⌘Z, number of ⌘Z (or redo spec), expected source after typing Q
  ['caret-undo-new-para-at-end', 'abc\n\nzzz\n', 'abc', ['Enter', 'def'], ['Meta+z'], 'abcQ\n\nzzz\n'],
  ['caret-undo-new-para-last-block', 'abc\n', 'abc', ['Enter', 'def'], ['Meta+z'], 'abcQ\n'],
  ['caret-undo-new-item', '- one\n- two\n\nz\n', 'two', ['Enter', 'xyz'], ['Meta+z'], '- one\n- twoQ\n\nz\n'],
  ['caret-undo-typed-at-end-2lines', 'abc\ndef\n\nz\n', 'def', ['Enter', 'ghi'], ['Meta+z'], 'abc\ndefQ\n\nz\n'],
  ['caret-redo-delete-mid', 'a\n\nmid\n\nz\n', 'mid', ['Meta+a', 'Backspace', 'wait', 'Meta+z', 'wait'], ['Meta+Shift+z'], null],
  ['caret-undo-delete-mid', 'a\n\nmid\n\nz\n', 'mid', ['Meta+a', 'Backspace', 'wait'], ['Meta+z'], null],
];
for (const [name, doc, needle, acts, hist, exp] of CARET) {
  def(name, async () => {
    await start(doc, needle);
    await at(needle);
    for (const a of acts) { if (a === 'wait') await settle(); else if (/^(Enter|Backspace|Meta\+.|Meta\+Shift\+.)$/.test(a)) await press(a); else await type(a); }
    await settle();
    const fin = await B.source();
    for (const h of hist) { await press(h); await sleep(150); await B.settle(120); }
    await settle(400);
    const mid = await B.source();
    await type('Q'); await settle();
    const v = await view(page);
    const ok = exp === null ? true : v.src === exp;
    return { ok, detail: `edited=${J(fin)} afterHistory=${J(mid)} afterQ=${J(v.src)} exp=${J(exp)} editing=${J(v.editing && v.editing.text)}` };
  });
}
// ---------------------------------------------------------------- an Enter that leaves a formula / image at a paragraph start
const ATOM = [
  ['atom-u13-math', 'abc $x$ d\n', 'abc', 'after', ['Enter', 'Q'], 'abc\n\nQ$x$ d\n'],
  ['atom-nows-math', 'abc$x$ d\n', 'abc', 'after', ['Enter', 'Q'], 'abc\n\nQ$x$ d\n'],
  ['atom-start-math-type', '$x$ d\n\nz\n', ' d', 'before', ['Home', 'Q'], 'Q$x$ d\n\nz\n'],
  ['atom-u13-img', 'abc ![i](data:image/gif;base64,R0lGODlhAQABAAAAACw=) d\n', 'abc', 'after', ['Enter', 'Q'], 'abc\n\nQ![i](data:image/gif;base64,R0lGODlhAQABAAAAACw=) d\n'],
  ['atom-u13-math-li', '- abc $x$ d\n', 'abc', 'after', ['Enter', 'Q'], '- abc\n- Q$x$ d\n'],
];
for (const [name, doc, needle, where, keys, exp] of ATOM) {
  def(name, async () => {
    const orig = await start(doc, needle.trim() || needle);
    await at(needle, where);
    for (const k of keys) { if (k.length === 1) await type(k); else await press(k); }
    await settle();
    const v = await view(page);
    const u = await undoTo(B, orig, 8);
    return { ok: v.src === exp && u.ok, detail: `src=${J(v.src)} exp=${J(exp)} html=${J(v.editing && v.editing.html)} undo=${u.ok ? u.n : 'FAIL'}` };
  });
}
// ---------------------------------------------------------------- U13
const U13 = [
  // name, doc, needle (caret after), keys, expected source
  ['u13-p-one-space', 'abc def\n', 'abc', ['Enter', 'Q'], 'abc\n\nQdef\n'],
  ['u13-p-three-spaces', 'abc   def\n', 'abc', ['Enter', 'Q'], 'abc\n\nQdef\n'],
  ['u13-p-tab', 'abc\tdef\n', 'abc', ['Enter', 'Q'], 'abc\n\nQdef\n'],
  ['u13-p-src-nbsp-kept', 'abc&nbsp;def\n', 'abc', ['Enter'], 'abc\n\n&nbsp;def\n'],
  ['u13-p-ideographic-kept', 'abc' + IDSP + 'def\n', 'abc', ['Enter'], 'abc\n\n' + IDSP + 'def\n'],
  ['u13-p-space-then-nbsp', 'abc &nbsp;def\n', 'abc', ['Enter'], 'abc\n\n&nbsp;def\n'],
  ['u13-h-space', '# abc def\n\nz\n', 'abc', ['Enter', 'Q'], '# abc\n\nQdef\n\nz\n'],
  ['u13-quote-space', '> abc def\n\nz\n', 'abc', ['Enter', 'Q'], '> abc\n>\n> Qdef\n\nz\n'],
  ['u13-li-space', '- abc def\n- two\n', 'abc', ['Enter', 'Q'], '- abc\n- Qdef\n- two\n'],
  ['u13-li-nested-space', '- one\n  - abc def\n', 'abc', ['Enter', 'Q'], '- one\n  - abc\n  - Qdef\n'],
  ['u13-task-space', '- [ ] abc def\n', 'abc', ['Enter', 'Q'], '- [ ] abc\n- [ ] Qdef\n'],
  ['u13-shift-p', 'abc def\n', 'abc', ['Shift+Enter', 'Q'], 'abc  \nQdef\n'],
  ['u13-shift-cell', '| h |\n|---|\n| abc def |\n', 'abc', ['Shift+Enter', 'Q'], '| h |\n|---|\n| abc<br>Qdef |\n'],
  ['u13-twice', 'abc  def\n', 'abc', ['Enter', 'Enter', 'Q'], null],
  ['u13-bold-space', 'abc **def ghi**\n', 'def', ['Enter', 'Q'], 'abc **def**\n\n**Qghi**\n'],
  ['u13-before-bold', 'abc **def**\n', 'abc', ['Enter', 'Q'], 'abc\n\n**Qdef**\n'],
  ['u13-space-before-code', 'abc `def`\n', 'abc', ['Enter', 'Q'], 'abc\n\nQ`def`\n'],
  ['u13-space-before-link', 'abc [def](http://e.com/)\n', 'abc', ['Enter', 'Q'], 'abc\n\nQ[def](http://e.com/)\n'],
  ['u13-softbreak', 'abc\ndef\n', 'abc', ['Enter', 'Q'], 'abc\n\nQdef\n'],
  ['u13-softbreak-indented', 'abc\n   def\n', 'abc', ['Enter', 'Q'], 'abc\n\nQdef\n'],
  ['u13-only-ws-after', 'abc   \n\nz\n', 'abc', ['Enter', 'Q'], 'abc\n\nQ\n\nz\n'],
  ['u13-space-before-br', 'abc  \ndef\n', 'abc', ['Enter', 'Q'], null],
  ['u13-space-before-math', 'abc $x$ d\n', 'abc', ['Enter', 'Q'], 'abc\n\nQ$x$ d\n'],
  ['u13-shift-twice', 'abc def\n', 'abc', ['Shift+Enter', 'Shift+Enter', 'Q'], null],
];
for (const [name, doc, needle, keys, exp] of U13) {
  def(name, async () => {
    const orig = await start(doc, needle);
    await at(needle);
    for (const k of keys) { if (k.length === 1) await type(k); else await press(k); }
    await settle();
    const v = await view(page);
    const sh = await shownText(page);
    await B.esc(); await settle();
    const sh2 = await shownText(page);
    // undo back (click into the first block again)
    await clickText(page, needle, 0, { side: 'right' });
    await waitSession();
    const u = await undoTo(B, orig, 10);
    const r = await redoTo(B, v.src, 10);
    const okExp = exp === null ? !v.src.includes('&nbsp;') : v.src === exp;
    return { ok: okExp && J(sh) === J(sh2) && u.ok && r.ok, detail: `src=${J(v.src)} exp=${J(exp)} shown=${J(sh)} afterEsc=${J(sh2)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)} redo=${r.ok ? r.n : 'FAIL ' + J(r.now)}` };
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
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)), 'console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
