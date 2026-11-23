// bench/verify/v4-sesb-drag.mjs — verify-session-b: U20 (H8) variations. Each case: a click into a block (a session in
// 0.2.0, a plain caret in 0.1.1), optional typing, then a gesture that leaves the block (drag forward / backward, out
// and back, out of the window, after a double / triple click, Shift-click before / after), then ⌘C. The same gesture
// runs on the 0.1.1 baseline renderer with the document the candidate's source holds at the end (so typed text is
// part of both). PASS = byte-identical clipboard text.
// Run (both servers up: candidate `npx vite --port 5432`, baseline `npx vite preview --outDir
//   release/baseline-0.1.1.noindex/dist --port 5442`):  node bench/verify/v4-sesb-drag.mjs [name-filter]
// Env: MDR_PORT (5432), MDR_BASE_PORT (5442). Exit 1 on a failure. Writes only into the scratch directory.
import { writeFileSync } from 'node:fs';
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, copied, selFacts, prepare, requireServer, SCRATCH, view } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432), BP = Number(process.env.MDR_BASE_PORT || 5442);
await requireServer(CP); await requireServer(BP, true);
const FENCE = '`'.repeat(3);
const DOC = [
  '# Heading alpha one', '',
  'First para **bold words** and *ital* plus [a link](https://example.com/x) end.', '',
  '> Quote line one', '> still quote.', '>', '> Second quote para here.', '',
  '- item one text', '- item two text', '  - nested three', '',
  '| col a | col b |', '| --- | --- |', '| cell one | cell two |', '| cell three | cell four |', '',
  'Inline $x^2+y^2$ formula and more words.', '',
  FENCE + 'js', 'const code = 1;', 'let other = 2;', FENCE, '',
  'Last para omega words.', '',
].join('\n');

const C = [];
const def = (name, steps, doc = DOC) => C.push({ name, steps, doc });
def('fwd-from-bold', [['click', ['bold words', 2]], ['drag', ['bold words', 3], ['Quote line', 3]]]);
def('bwd-from-bold', [['click', ['bold words', 1]], ['drag', ['bold words', 7], ['Heading', 2]]]);
def('fwd-from-2nd-quote-para-start', [['click', ['Second quote', 3]], ['drag', ['Second quote', 0], ['item two', 3]]]);
def('fwd-from-item-two-start', [['click', ['item two', 2]], ['drag', ['item two', 0], ['cell one', 2]]]);
def('bwd-from-item-two-start', [['click', ['item two', 2]], ['drag', ['item two', 0], ['Quote line', 2]]]);
def('fwd-from-nested-start', [['click', ['nested three', 2]], ['drag', ['nested three', 0], ['cell one', 2]]]);
def('fwd-from-cell', [['click', ['cell three', 2]], ['drag', ['cell three', 1], ['formula', 3]]]);
def('fwd-from-cell2-start', [['click', ['cell four', 2]], ['drag', ['cell four', 0], ['formula', 3]]]);
def('bwd-from-cell', [['click', ['cell three', 2]], ['drag', ['cell three', 4], ['item one', 2]]]);
def('fwd-from-code', [['click', ['other', 1]], ['drag', ['other', 0], ['omega', 2]]]);
def('bwd-from-code', [['click', ['other', 1]], ['drag', ['other', 2], ['cell four', 1]]]);
def('fwd-from-code-line2-start', [['click', ['other', 1]], ['drag', ['let', 0], ['omega', 2]]]);
def('fwd-from-heading-start', [['click', ['alpha', 1]], ['drag', ['Heading', 0], ['plus', 1]]]);
def('bwd-from-block-end', [['click', ['omega', 1]], ['drag', ['words.', 5, 'right'], ['formula', 0]]]);
def('formula-opened-then-drag', [['click', { css: '.md-math' }], ['drag', ['and more', 1], ['omega', 1]]]);
def('formula-opened-then-drag-bwd', [['click', { css: '.md-math' }], ['drag', ['more words', 2], ['cell two', 1]]]);
def('shift-after', [['click', ['bold words', 3]], ['shift', ['item one', 2]]]);
def('shift-before', [['click', ['Second quote', 4]], ['shift', ['First para', 2]]]);
def('shift-after-from-code', [['click', ['code', 2]], ['shift', ['omega', 2]]]);
def('dbl-then-drag', [['click', ['ital', 1]], ['drag', ['ital', 1], ['Quote line', 2], { clickCount: 2 }]]);
def('triple-then-drag', [['click', ['item one', 1]], ['drag', ['item one', 1], ['cell two', 2], { clickCount: 3 }]]);
def('out-and-back', [['click', ['First para', 2]], ['drag', ['First para', 1], ['link', 1], { via: ['Quote line', 2] }]]);
def('out-and-back-bwd', [['click', ['Second quote', 2]], ['drag', ['para here', 2], ['Quote line', 6], { via: ['Heading', 2] }]]);
def('release-outside-window', [['click', ['cell one', 1]], ['drag', ['cell one', 2], null, { outside: true }]]);
def('typed-then-drag', [['click', ['one text', 7, 'right']], ['type', 'Z', { after: 400 }], ['drag', ['one text', 1], ['cell one', 2]]]);
def('typed-fast-then-drag', [['click', ['one text', 7, 'right']], ['type', 'ZYX'], ['drag', ['one text', 1], ['cell one', 2], { gap: 5 }]]);
def('typed-fast-then-drag-bwd', [['click', ['two text', 7, 'right']], ['type', 'ZYX'], ['drag', ['two text', 2], ['Quote line', 2], { gap: 5 }]]);
def('typed-dblspace-then-drag', [['click', ['Last para', 4]], ['type', '  ', { after: 400 }], ['drag', ['omega', 1], ['formula', 2]]]);
def('typed-trailing-space-then-drag-bwd', [['click', ['and more words', 13, 'right']], ['type', ' ', { after: 400 }], ['drag', ['and more', 2], ['cell one', 2]]]);
def('typed-in-code-then-drag', [['click', ['other', 4, 'right']], ['type', 'QQ', { after: 400 }], ['drag', ['let', 1], ['omega', 3]]]);
def('hardbreak-2nd-line-start', [['click', ['line two', 2]], ['drag', ['line two', 0], ['omega', 2]]], DOC.replace('Last para omega words.', 'Line one here  \nline two here\n\nLast para omega words.'));
def('loose-item-2nd-para-start', [['click', ['inner two', 2]], ['drag', ['inner two', 0], ['omega', 2]]], DOC.replace('Last para omega words.', '- outer item\n\n  inner two para\n\nLast para omega words.'));

// the session's write changes the block's kind (and with it the block's identity), then a drag out of it
const DOC2 = 'First para alpha words here.\n\nSecond para beta words here.\n\nThird para gamma words here.\n';
def('kind-change-heading-then-drag', [['click', ['Second', 0]], ['type', '# ', { after: 600 }], ['drag', ['para beta', 2], ['gamma', 3]]], DOC2);
def('kind-change-list-then-drag', [['click', ['Second', 0]], ['type', '- ', { after: 600 }], ['drag', ['para beta', 2], ['gamma', 3]]], DOC2);
def('kind-change-quote-then-drag-bwd', [['click', ['Second', 0]], ['type', '> ', { after: 600 }], ['drag', ['para beta', 2], ['alpha', 2]]], DOC2);
def('kind-change-heading-then-shift', [['click', ['Second', 0]], ['type', '# ', { after: 600 }], ['click', ['para beta', 2]], ['shift', ['gamma', 3]]], DOC2);

// the drag starts OUTSIDE the session's block and ends inside it (the session ends at the press; its block re-renders
// with the drag's focus inside it)
def('drag-into-session-mid', [['click', ['Second quote', 3]], ['drag', ['bold words', 2], ['para here', 3]]]);
def('drag-into-session-item-start', [['click', ['item two', 3]], ['drag', ['Quote line', 2], ['item two', 0]]]);
def('drag-into-session-cell-start-bwd', [['click', ['cell four', 3]], ['drag', ['omega', 2], ['cell four', 0]]]);

// after Esc the caret the session had is put back by text offset; a Shift-click then extends from it
def('esc-then-shift-from-item-start', [['click', ['item two', 0]], ['key', 'Escape', { after: 500 }], ['shift', ['cell one', 2]]]);
def('esc-then-shift-from-quote-para2-start', [['click', ['Second quote', 0]], ['key', 'Escape', { after: 500 }], ['shift', ['item one', 2]]]);

const out = [];
const stop = globalTimeout(Number(process.env.T_MS ?? 300_000), async () => { await A?.close(); await Bs?.close(); });
let A = null, Bs = null;
try {
  A = await openAt(CP, false);
  Bs = await openAt(BP, true);
  for (const c of C) {
    if (filter && !new RegExp(filter).test(c.name)) continue;
    let ca = null, ba = null, err = null;
    try {
      await prepare(A, c.doc);
      await runSteps(A.page, c.steps);
      const sa = await selFacts(A.page);
      const cpA = await copied(A.page);
      const v = await view(A.page);
      await A.page.keyboard.press('Escape'); await A.settle(100);
      const srcA = await A.source();
      ca = { copied: cpA, sel: sa, session: !!v.editing, src: srcA };
      await prepare(Bs, srcA);
      await runSteps(Bs.page, c.steps, { baseline: true });
      const sb = await selFacts(Bs.page);
      const cpB = await copied(Bs.page);
      ba = { copied: cpB, sel: sb };
    } catch (e) { err = String(e && e.message ? e.message : e).split('\n')[0]; }
    out.push({ name: c.name, cand: ca, base: ba, err });
    if (err) check(c.name, false, 'threw ' + err);
    else check(c.name, ca.copied === ba.copied, `cand=${J(ca.copied)} base=${J(ba.copied)}${ca.copied !== ba.copied ? ` candSel=${J(ca.sel)} baseSel=${J(ba.sel)}` : ''}`);
  }
  writeFileSync(`${SCRATCH}/v4-sesb-drag.json`, JSON.stringify(out, null, 1));
  summary();
  if (A.pageErrors.length) console.log('candidate page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); await Bs?.close(); }
process.exitCode = results().fail ? 1 : 0;
function results() { return { fail: out.filter((o) => o.err || !o.cand || o.cand.copied !== o.base?.copied).length }; }
