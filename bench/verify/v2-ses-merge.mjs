// bench/verify/v2-ses-merge.mjs — verify-session: Backspace at the start of a paragraph (U3 merge), Delete at the
// end, merge + undo + redo. For each case: the source after the merge, the merged block's VISIBLE text compared
// with the two visible texts joined (what a text editor shows), ⌘Z back to the original byte for byte, ⇧⌘Z
// forward again, and the caret at the join (a typed marker lands there).
// Run: MDR_PORT=5282 node bench/verify/v2-ses-merge.mjs [filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
const vis = () => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => s.innerText.replace(/\n+$/, '')));
const kindsOf = async () => (await B.blocks()).map((b) => b.kind).join(',');
// [name, doc, line of the second paragraph, its first word, merged block expected visible text (or null)]
const C = [
  ['plain', 'abc\n\ndef\n', 3, 'def', 'abcdef'],
  ['two-blank-lines', 'abc\n\n\n\ndef\n', 5, 'def', 'abcdef'],
  ['multi-line-prev', 'a1\na2\n\ndef\n', 4, 'def', null],
  ['multi-line-cur', 'abc\n\ndef\nghi\n', 3, 'def', null],
  ['trailing-spaces', 'abc  \n\ndef\n', 3, 'def', 'abcdef'],
  ['trailing-backslash', 'abc\\\n\ndef\n', 3, 'def', 'abc\\def'],
  ['backslash-then-em', 'abc\\\n\n*em* x\n', 3, 'em', 'abc\\em x'],
  ['digit-then-dot', '1\n\n. x\n', 3, 'x', '1. x'],
  ['digit-then-paren', '12\n\n) x\n', 3, 'x', '12) x'],
  ['star-forms-em', 'a *b\n\nc* d\n', 3, 'c', 'a *bc* d'],
  ['bracket-forms-link', 'see [t\n\n](https://e.com) z\n', 3, 'z', 'see [t](https://e.com) z'],
  ['code-tick', 'a `b\n\nc` d\n', 3, 'c', 'a `bc` d'],
  ['dollar-forms-math', 'cost $5\n\nand 6$ z\n', 3, 'and', 'cost $5and 6$ z'],
  ['tilde-forms-del', 'a ~~b\n\nc~~ d\n', 3, 'c', 'a ~~bc~~ d'],
  ['nbsp-cur', 'abc\n\n&nbsp;def\n', 3, 'def', null],
  ['escaped-cur', 'abc\n\n\\# def\n', 3, 'def', 'abc# def'],
  ['cjk', '中文\n\n英文\n', 3, '英文', '中文英文'],
  ['heading-prev', '# H\n\ndef\n', 3, 'def', null],
  ['list-prev', '- a\n\ndef\n', 3, 'def', null],
  ['quote-prev', '> a\n\ndef\n', 3, 'def', null],
  ['comment-between', 'abc\n\n<!-- c -->\n\ndef\n', 5, 'def', null],
  ['first-block', 'def\n\nabc\n', 1, 'def', null],
  ['last-no-newline', 'abc\n\ndef', 3, 'def', 'abcdef'],
  ['tight-heading-before', '# H\nabc\n\ndef\n', 4, 'def', null],
];
try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, want] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc);
      const before = await vis();
      await B.clickLine(line, 'first', needle);
      await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); const w = document.createTreeWalker(el, 4); let n = w.nextNode(); while (n && !n.data.trim()) n = w.nextNode(); r.setStart(n, n.data.search(/\S/)); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await page.keyboard.press('Backspace');
      await sleep(300); await B.settle(200);
      const merged = await B.source();
      const st = await B.state();
      await page.keyboard.type('|');
      await sleep(300); await B.settle(200);
      const marked = await B.source();
      await page.keyboard.press('Escape'); await B.settle(300);
      const after = await vis();
      const kinds = await kindsOf();
      // undo the marker + the merge, then redo
      await B.clickLine(1, 'first'); await sleep(100);
      let u = await B.source();
      for (let i = 0; i < 6 && u !== doc; i++) { await page.keyboard.press('Meta+z'); await sleep(250); await B.settle(80); u = await B.source(); }
      const undoOk = u === doc;
      const problems = [];
      if (want !== null) {
        const shown = after.find((t) => t.includes('|')) ?? '';
        if (shown.replace('|', '') !== want) problems.push(`visible ${J(shown)} expected ${J(want)} (before: ${J(before)})`);
      }
      if (!undoOk) problems.push(`undo: ${J(u)}`);
      check(name, problems.length === 0, `${problems.join('; ')} merged=${J(merged)} marked=${J(marked)} kinds=${kinds} live=${st.editing !== null}`);
      await page.keyboard.press('Escape'); await sleep(100);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  // Delete at the end of a block: no merge (contract)
  await B.loadDoc('abc\n\ndef\n'); await B.clickLine(1, 'first', 'abc'); await B.caretAt('abc'); await page.keyboard.press('Delete'); await sleep(300); await B.settle();
  check('delete-at-end-no-merge', (await B.source()) === 'abc\n\ndef\n', J(await B.source()));
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
