// bench/verify/v4-sesb-zwcopy.mjs — verify-session-b: what ⌘C copies from INSIDE a session. U21 puts a zero-width
// space (U+200B) before every inline formula that starts a line, and the H14 paste leaves one when it is all its text
// node holds; the serializer drops them, but the clipboard does not. Each case copies a selection inside a session
// (⌘A once = the block, or a drag inside the block) and compares the clipboard text with the 0.1.1 baseline's copy of
// the same gesture on the same source; then pastes the clipboard into the editor pane (CodeMirror) and checks that no
// U+200B reached the source.
// Run (servers up or started: candidate 5432, baseline 5442): node bench/verify/v4-sesb-zwcopy.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, copied, prepare, requireServer, view, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432), BP = Number(process.env.MDR_BASE_PORT || 5442);
await requireServer(CP); await requireServer(BP, true);
const ZW = String.fromCharCode(0x200b);
const show = (t) => J(t.split(ZW).join('<ZWSP>'));
const C = [
  // [name, doc, candidate steps, baseline steps]
  ['formula-start-selall', '$x^2$ starts here\n\nnext para\n', [['click', ['starts', 2]], ['key', 'Meta+a', { after: 150 }]],
    [['drag', { css: '.md-math', fx: 0.02 }, ['starts here', 10, 'right']]]],
  ['formula-start-drag', 'Lead line\n\n$y^2$ second starts\n\nnext para\n', [['click', ['second', 2]], ['drag', ['second', 0], ['Lead', 1], { steps: 8 }]],
    [['drag', ['second', 0], ['Lead', 1], { steps: 8 }]]],
  ['formula-after-break-selall', 'first line  \n$z$ after break\n\nnext\n', [['click', ['after', 2]], ['key', 'Meta+a', { after: 150 }]],
    [['drag', ['first', 0], ['after break', 10, 'right']]]],
  ['item-formula-start-selall', '- $a$ item one\n- plain two\n\nnext\n', [['click', ['item one', 2]], ['key', 'Meta+a', { after: 150 }]],
    [['drag', { css: '.md-math', fx: 0.02 }, ['plain two', 8, 'right']]]],
];
let A = null, Bs = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); await Bs?.close(); });
try {
  A = await openAt(CP, false);
  Bs = await openAt(BP, true);
  for (const [name, doc, cs, bs] of C) {
    if (filter && !new RegExp(filter).test(name)) continue;
    try {
      await prepare(A, doc);
      await runSteps(A.page, cs);
      const v = await view(A.page);
      const ca = await copied(A.page);
      await A.page.keyboard.press('Escape'); await A.settle(150);
      // paste the candidate's clipboard into the editor pane at the end of the document
      await A.page.evaluate(() => { const ev = window.__mdr.app.editor.view; ev.focus(); ev.dispatch({ selection: { anchor: ev.state.doc.length } }); });
      await A.page.keyboard.press('Meta+v'); await sleep(300);
      const src = await A.source();
      await prepare(Bs, doc);
      await runSteps(Bs.page, bs, { baseline: true });
      const cb = await copied(Bs.page);
      const ok = !ca.includes(ZW) && !src.includes(ZW);
      check(name, ok, `session=${!!v.editing} cand=${show(ca)} base=${show(cb)} zwInSourceAfterEditorPaste=${src.includes(ZW)}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  // the H14 paste over a whole bold word leaves U+200B in the session DOM; copy the block afterwards
  if (!filter || /bold/.test('paste-over-bold-then-copy')) {
    try {
      const doc = 'Lead **bold** tail\n\nnext\n';
      await prepare(A, doc);
      await runSteps(A.page, [['click', ['tail', 2]], ['click', ['bold', 1], { clickCount: 2, after: 250 }]]);
      await A.page.evaluate(() => navigator.clipboard.writeText('X')); await A.page.keyboard.press('Meta+v'); await sleep(400);
      const html = (await view(A.page)).editing?.html ?? '';
      await A.page.keyboard.press('Meta+a'); await sleep(150);
      const ca = await copied(A.page);
      await A.page.keyboard.press('Escape'); await A.settle(150);
      const s1 = await A.source();
      check('paste-over-bold-then-copy', !ca.includes(ZW), `src=${J(s1)} copy=${show(ca)} sessionHtmlHasZW=${html.includes(ZW)}`);
    } catch (e) { check('paste-over-bold-then-copy', false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); await Bs?.close(); }
process.exitCode = results.fail ? 1 : 0;
