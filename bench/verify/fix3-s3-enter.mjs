// bench/verify/fix3-s3-enter.mjs — fix-session-3: decision U13 (Enter before whitespace) in a real browser.
// Each case: load a document, click the needle's block, put the caret after (or before) the needle, run the key
// actions, settle, and compare the WHOLE source with the expectation. Cases with `undo` then press ⌘Z inside the
// session until the source is the original again (byte for byte) and ⇧⌘Z until it is the edited text again.
// Cases with expect null are INFO: their source is printed (and checked for an &nbsp; the document did not have
// only when `noNbsp` is set). Prints one line per case: expected and actual source. Exit code 1 on a mismatch.
// Needs a renderer on MDR_PORT (started by v2-ses-lib.mjs if nothing answers). Leaves that Vite running.
// Run: MDR_PORT=5380 node bench/verify/fix3-s3-enter.mjs [name-filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
const NBSP = String.fromCharCode(0xa0);
const IDSP = String.fromCharCode(0x3000);

async function act(a) {
  const [k, ...rest] = a.split(':');
  const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'wait') await sleep(Number(v));
  else if (k === 'sel') await B.selectText(v);
  else if (k === 'caret') await B.caretAt(v, 'after');
  else throw new Error('bad action ' + a);
}

// { name, doc, needle, steps, expect (null: INFO), undo, noNbsp, keep }
const C = [
  // paragraphs: one space, three spaces, a tab, a soft line break
  { name: 'p-one', doc: 'abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n' },
  { name: 'p-one-wait', doc: 'abc def\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'type:Q'], expect: 'abc\n\nQdef\n' },
  { name: 'p-three', doc: 'abc   def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n' },
  { name: 'p-tab', doc: 'abc\tdef\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n' },
  { name: 'p-softbreak', doc: 'abc\ndef\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n' },
  { name: 'p-next-block', doc: 'abc def\n\nnext\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n\nnext\n' },
  // a heading (the new block is a paragraph), a quote paragraph
  { name: 'h-one', doc: '# abc def\n\nnext\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '# abc\n\nQdef\n\nnext\n' },
  { name: 'h-three', doc: '## abc   def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '## abc\n\nQdef\n' },
  { name: 'quote-one', doc: '> abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '> abc\n>\n> Qdef\n' },
  // list items: plain, three spaces, a tab, nested, ordered, task
  { name: 'li-one', doc: '- abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '- abc\n- Qdef\n' },
  { name: 'li-three', doc: '- abc   def\n- next\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '- abc\n- Qdef\n- next\n' },
  { name: 'li-tab', doc: '- abc\tdef\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '- abc\n- Qdef\n' },
  { name: 'li-nested', doc: '- top\n  - abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '- top\n  - abc\n  - Qdef\n' },
  { name: 'ol-one', doc: '1. abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '1. abc\n2. Qdef\n' },
  { name: 'task-one', doc: '- [ ] abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '- [ ] abc\n- [ ] Qdef\n' },
  { name: 'task-tab', doc: '- [ ] abc\tdef\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '- [ ] abc\n- [ ] Qdef\n' },
  { name: 'task-noQ', doc: '- [ ] abc def\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'press:Escape'], expect: '- [ ] abc\n- [ ] def\n' },
  // a non-collapsed selection: the run after the selection's end
  { name: 'sel', doc: 'xabc def\n', needle: 'abc', steps: ['sel:abc', 'press:Enter', 'type:Q'], expect: 'x\n\nQdef\n' },
  // only whitespace after the caret: the new paragraph is empty (G11), what is typed goes there
  { name: 'only-spaces', doc: 'abc&#32;&#32;&#32;\n\nnext\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQ\n\nnext\n' },
  { name: 'only-spaces-wait', doc: 'abc&#32;&#32;&#32;\n\nnext\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'type:Q'], expect: 'abc\n\nQ\n\nnext\n' },
  // two Enters in a row; Enter after the space
  { name: 'two-enters', doc: 'abc def\n', needle: 'abc', steps: ['press:Enter', 'press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n' },
  { name: 'after-space', doc: 'abc def\n', needle: 'abc ', steps: ['press:Enter', 'type:Q'], expect: 'abc\n\nQdef\n' },
  // Enters replayed in the resume window (queued) and in the live session
  { name: 'replayed-enter', doc: 'abc def ghi\n', needle: 'abc', steps: ['press:Enter', 'press:ArrowRight', 'press:ArrowRight', 'press:ArrowRight', 'press:Enter', 'type:Q'], expect: 'abc\n\ndef\n\nQghi\n' },
  { name: 'second-enter-live', doc: 'abc def ghi\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'press:ArrowRight', 'press:ArrowRight', 'press:ArrowRight', 'press:Enter', 'wait:400', 'type:Q'], expect: 'abc\n\ndef\n\nQghi\n' },
  { name: 'li-replayed-enter', doc: '- abc def ghi\n', needle: 'abc', steps: ['press:Enter', 'press:ArrowRight', 'press:ArrowRight', 'press:ArrowRight', 'press:Enter', 'type:Q'], expect: '- abc\n- def\n- Qghi\n' },
  // what is NOT removed: the document's own non-breaking space, U+3000, code
  // (typing right before a non-breaking space makes Chromium turn it into a plain space: the cases end with Esc)
  { name: 'doc-nbsp-entity', doc: 'abc&nbsp;def\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'press:Escape'], expect: 'abc\n\n&nbsp;def\n' },
  { name: 'doc-nbsp-entity-Q', doc: 'abc&nbsp;def\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: null },
  { name: 'doc-nbsp-raw', doc: `abc${NBSP}def\n`, needle: 'abc', steps: ['press:Enter', 'wait:400', 'press:Escape'], expect: null, keep: (s) => s.includes('&nbsp;def') || s.includes(NBSP + 'def') },
  { name: 'space-then-nbsp', doc: 'abc &nbsp;def\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'press:Escape'], expect: 'abc\n\n&nbsp;def\n' },
  { name: 'ideographic', doc: `abc${IDSP}def\n`, needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: `abc\n\nQ${IDSP}def\n` },
  { name: 'code-block', doc: '```\nabc def\n```\n', needle: 'abc', steps: ['press:Enter', 'type:Q'], expect: '```\nabc\nQ def\n```\n' },
  { name: 'inline-code', doc: 'x `abc def` y\n', needle: 'abc', steps: ['press:Enter', 'wait:400', 'press:Escape'], expect: null },
  // Shift+Enter (a hard break) before a space
  { name: 'shift-p', doc: 'abc def\n', needle: 'abc', steps: ['press:Shift+Enter', 'type:Q'], expect: 'abc  \nQdef\n' },
  { name: 'shift-p-esc', doc: 'abc def\n', needle: 'abc', steps: ['press:Shift+Enter', 'wait:400', 'press:Escape'], expect: 'abc  \ndef\n' },
  { name: 'shift-cell-esc', doc: '| a | b |\n|---|---|\n| abc def | x |\n', needle: 'abc', steps: ['press:Shift+Enter', 'wait:400', 'press:Escape'], expect: '| a | b |\n|---|---|\n| abc<br>def | x |\n' },
  { name: 'shift-li', doc: '- abc def\n', needle: 'abc', steps: ['press:Shift+Enter', 'type:Q'], expect: null, noNbsp: true },
  { name: 'shift-cell', doc: '| a | b |\n|---|---|\n| abc def | x |\n', needle: 'abc', steps: ['press:Shift+Enter', 'type:Q'], expect: null, noNbsp: true },
  // the resume window: a space TYPED after the Enter is not a split-off space (U13 does not apply) — INFO
  { name: 'typed-space-after-enter', doc: 'xyz\n', needle: 'xyz', steps: ['type:abc', 'press:Enter', 'type: def'], expect: null },
  // undo / redo, byte for byte
  { name: 'undo-p', doc: 'abc def\n', needle: 'abc', steps: ['press:Enter', 'wait:400'], expect: 'abc\n\ndef\n', undo: true },
  { name: 'undo-li', doc: '- abc def\n', needle: 'abc', steps: ['press:Enter', 'wait:400'], expect: '- abc\n- def\n', undo: true },
  { name: 'undo-task', doc: '- [ ] abc   def\n', needle: 'abc', steps: ['press:Enter', 'wait:400'], expect: '- [ ] abc\n- [ ] def\n', undo: true },
  { name: 'undo-h', doc: '# abc def\n', needle: 'abc', steps: ['press:Enter', 'wait:400'], expect: '# abc\n\ndef\n', undo: true },
  { name: 'undo-typed', doc: 'abc def\n', needle: 'abc', steps: ['press:Enter', 'type:Q', 'wait:400'], expect: 'abc\n\nQdef\n', undo: true },
];

async function undoAll(orig, fin) {
  let now = await B.source();
  let n = 0;
  for (; n < 6 && now !== orig; n++) { await page.keyboard.press('Meta+z'); await sleep(150); await B.settle(150); now = await B.source(); }
  const okU = now === orig;
  let m = 0;
  for (; m < 6 && now !== fin; m++) { await page.keyboard.press('Meta+Shift+z'); await sleep(150); await B.settle(150); now = await B.source(); }
  return { okU, n, okR: now === fin, m, now };
}

let mismatch = 0;
try {
  await B.boot('mode=split');
  for (const c of C) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await B.loadDoc(c.doc);
      const line = c.doc.split('\n').findIndex((l) => l.includes(c.needle.trim() || c.needle)) + 1;
      await B.clickLine(line, 'first', c.needle.trim());
      if (!c.steps[0].startsWith('sel:')) await B.caretAt(c.needle, 'after');
      for (const a of c.steps) await act(a);
      await sleep(400);
      await B.settle(200);
      const src = await B.source();
      const st = await B.state();
      let ok = c.expect === null ? true : src === c.expect;
      if (c.expect === null && c.noNbsp) ok = !src.includes('&nbsp;') && !src.includes(NBSP);
      if (c.expect === null && c.keep) ok = c.keep(src);
      let extra = '';
      if (ok && c.undo) {
        const u = await undoAll(c.doc, c.expect);
        extra = ` undo=${u.okU ? `ok(${u.n})` : 'FAIL'} redo=${u.okR ? `ok(${u.m})` : 'FAIL'}${u.okU && u.okR ? '' : ` now=${J(u.now)}`}`;
        ok = u.okU && u.okR;
      }
      if (!ok) mismatch++;
      check(c.name, ok, `${c.expect === null ? 'INFO ' : `expected=${J(c.expect)} `}actual=${J(src)}${extra} editing=${st.editing !== null}`);
      await B.esc();
    } catch (e) { mismatch++; check(c.name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally {
  console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`);
  stop(); await B.close();
  process.exitCode = mismatch > 0 ? 1 : 0;
}
