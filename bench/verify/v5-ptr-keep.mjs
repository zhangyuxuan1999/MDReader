// bench/verify/v5-ptr-keep.mjs — verify-session-pointer: P-E (J5) by variation. A click into a block starts a session
// (0.1.1: a caret), optional edits that the write normalises (K5) or that change the block's line boxes, then a gesture
// that leaves the block (drag forward / backward, Shift-click, Esc then Shift-click), then ⌘C. The same gesture runs on
// the 0.1.1 baseline with the document the candidate's source holds at the end. PASS = byte-identical text/plain.
// Run (candidate MDR_PORT 5482, baseline MDR_BASE_PORT 5492): node bench/verify/v5-ptr-keep.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, prepare, results, CP, BP, readClip, clearClip, view } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const DOC = [
  '1. ordered one', '2. ordered two', '3. ordered three', '',
  '- [ ] task alpha', '- [x] task beta', '- [ ] task gamma', '',
  '- lvl one', '  - lvl two', '    - lvl three deep', '- back top', '',
  '| head a | head b |', '| --- | --- |', '| body c | body d |', '',
  'Para with ![pic](x.png) image inside words.', '',
  'Under __score__ and &copy; entity plus \\*esc\\* text.', '',
  'Setext heading here', '===================', '',
  '* star item one', '* star item two', '',
  '$a+b$ leads this line', 'and soft second line.', '',
  'Final omega para.', '',
].join('\n');
const C = [];
const def = (name, steps, doc = DOC) => C.push({ name, steps, doc });
def('ord-fwd-mid', [['click', ['ordered two', 3]], ['drag', ['ordered two', 0], ['task beta', 2]]]);
def('ord-bwd-start', [['click', ['ordered three', 2]], ['drag', ['ordered three', 0], ['ordered one', 3]]]);
def('task-fwd-start', [['click', ['task beta', 3]], ['drag', ['task beta', 0], ['lvl two', 2]]]);
def('task-bwd-start', [['click', ['task gamma', 3]], ['drag', ['task gamma', 0], ['ordered two', 2]]]);
def('task-shift', [['click', ['task alpha', 0]], ['shift', ['lvl one', 2]]]);
def('deep-fwd-start', [['click', ['lvl three', 3]], ['drag', ['lvl three', 0], ['body c', 2]]]);
def('deep-bwd-end', [['click', ['lvl three', 3]], ['drag', ['deep', 3, 'right'], ['task gamma', 1]]]);
def('back-top-start-bwd', [['click', ['back top', 2]], ['drag', ['back top', 0], ['lvl one', 1]]]);
def('th-fwd-start', [['click', ['head b', 2]], ['drag', ['head b', 0], ['image inside', 3]]]);
def('td-bwd-start', [['click', ['body d', 2]], ['drag', ['body d', 0], ['head a', 1]]]);
def('img-fwd-after', [['click', ['image inside', 2]], ['drag', ['image', 0], ['score', 2]]]);
def('img-bwd-before', [['click', ['Para with', 3]], ['drag', ['Para with', 9, 'right'], ['body c', 1]]]);
def('k5-score-fwd', [['click', ['score', 0]], ['type', 'Q', { after: 500 }], ['drag', ['entity', 1], ['Setext', 2]]]);
def('k5-score-bwd', [['click', ['score', 0]], ['type', 'Q', { after: 500 }], ['drag', ['plus', 2], ['body d', 2]]]);
def('k5-score-shift-before', [['click', ['entity', 0]], ['type', 'Q', { after: 500 }], ['shift', ['image', 2]]]);
def('k5-setext-fwd', [['click', ['heading here', 0]], ['type', 'Q', { after: 500 }], ['drag', ['heading', 0], ['star item two', 2]]]);
def('k5-star-fwd', [['click', ['star item one', 0]], ['type', 'Q', { after: 500 }], ['drag', ['star item two', 0], ['leads', 2]]]);
def('k5-star-bwd-start', [['click', ['star item two', 0]], ['type', 'Q', { after: 500 }], ['drag', ['star item two', 0], ['heading here', 2]]]);
def('formula-lead-fwd', [['click', ['leads', 2]], ['drag', ['soft second', 0], ['omega', 2]]]);
def('formula-lead-bwd', [['click', ['leads', 2]], ['drag', ['leads', 0], ['star item one', 2]]]);
def('softline-start-bwd', [['click', ['soft second', 0]], ['type', 'Z', { after: 500 }], ['drag', ['and Z', 0], ['star item two', 3]]]);
def('typed-bs-then-drag', [['click', ['ordered two', 5]], ['type', 'Z', { after: 300 }], ['key', 'Backspace', { after: 500, candOnly: true }], ['drag', ['ordered two', 2], ['task gamma', 3]]]);
def('enter-empty-item-then-drag', [['click', ['ordered one', 10, 'right']], ['key', 'End', { after: 80, candOnly: true }], ['key', 'Enter', { after: 500, candOnly: true }], ['drag', ['ordered two', 0], ['task beta', 2]]]);
def('enter-empty-item-then-drag-bwd', [['click', ['back top', 7, 'right']], ['key', 'End', { after: 80, candOnly: true }], ['key', 'Enter', { after: 500, candOnly: true }], ['drag', ['back top', 3], ['lvl two', 0]]]);
def('enter-item-split-then-drag', [['click', ['beta', 0]], ['key', 'Enter', { after: 500, candOnly: true }], ['drag', ['beta', 0], ['lvl two', 2]]]);
def('tab-indent-then-drag', [['click', ['ordered two', 3]], ['key', 'Tab', { after: 500, candOnly: true }], ['drag', ['ordered three', 0], ['task alpha', 2]]]);
def('esc-shift-task-start', [['click', ['task gamma', 0]], ['key', 'Escape', { after: 500 }], ['shift', ['lvl two', 2]]]);
def('esc-shift-th', [['click', ['head b', 0]], ['key', 'Escape', { after: 500 }], ['shift', ['image', 2]]]);
def('esc-shift-k5', [['click', ['score', 0]], ['type', 'Q', { after: 400 }], ['key', 'Escape', { after: 500 }], ['shift', ['Final', 2]]]);
def('dbl-word-k5-drag', [['click', ['entity', 0]], ['type', 'Q', { after: 400 }], ['drag', ['plus', 1], ['Final', 2], { clickCount: 2 }]]);

let A = null, Bs = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); await Bs?.close(); });
try {
  A = await openAt(CP, false);
  Bs = await openAt(BP, true);
  for (const c of C) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await prepare(A, c.doc);
      await runSteps(A.page, c.steps);
      await clearClip(A.page); await A.page.keyboard.press('Meta+c'); await sleep(180);
      const ca = await readClip(A.page);
      const v = await view(A.page);
      await A.page.keyboard.press('Escape'); await A.settle(120);
      const src = await A.source();
      await prepare(Bs, src);
      await runSteps(Bs.page, c.steps, { baseline: true });
      await clearClip(Bs.page); await Bs.page.keyboard.press('Meta+c'); await sleep(180);
      const cb = await readClip(Bs.page);
      check(c.name, ca.plain === cb.plain, `cand=${J(ca.plain)} base=${J(cb.plain)} session=${!!v.editing} srcChanged=${src !== c.doc}`);
    } catch (e) { check(c.name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); await Bs?.close(); }
process.exitCode = results.fail ? 1 : 0;
