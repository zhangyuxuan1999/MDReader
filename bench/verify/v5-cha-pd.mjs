// bench/verify/v5-cha-pd.mjs — challenge-a (round 4): variations of J6 / P-D (a source position mapped to a DOM caret
// after Cmd-Z / Shift-Cmd-Z and after a merge counts atoms, knows markup; no key swallowed).
// Oracle (undo / redo cases): start a session, put the caret after `at` (caretTo, editable visible text), type XY, wait,
// Cmd-Z (source must be the original), wait, type Q: the source must equal the source after XY with XY -> Q (the same
// K5 normalisation applies to both first edits). Redo: Cmd-Z, Shift-Cmd-Z, then Q: XY -> XYQ.
// Merge cases: caret before `at`, Backspace, wait, type Q: the source must equal `want`.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-pd.mjs [case-name-prefix ...]   (T_MS: global timeout, default 115 s)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const IMG = '![i](https://e.example/i.png)';
const BS = String.fromCharCode(92);
// [name, doc, click needle, caret after this editable text, mode]
const H = [
  ['u-footnote', 'See note[^1] and more words here\n\n[^1]: The note.\n', 'See', 'more'],
  ['u-star-literal', 'Price 5* only today and more\n\nzz\n', 'Price', 'today'],
  ['u-bad-entity', 'Tom &foo; Jerry and friends\n\nzz\n', 'Tom', 'Jerry'],
  ['u-code-backslash', 'Run `a' + BS + '` then go home now\n\nzz\n', 'Run', 'home'],
  ['u-math-in-bold', 'Text **bold $x^2$ in** after words\n\nzz\n', 'Text', 'after'],
  ['u-image-in-heading', `# Head ${IMG} tail words\n\nzz\n`, 'Head', 'tail'],
  ['u-linked-image', `Go [${IMG}](https://e.example/) then words\n\nzz\n`, 'Go', 'then'],
  ['u-two-images', `${IMG}${IMG} words here\n\nzz\n`, 'words', 'words'],
  ['u-table-cell-math', '| a | b |\n| --- | --- |\n| $x$ c1 | d2 word |\n', 'word', 'word'],
  ['u-task-math', '- [ ] task one\n- [x] task $y$ two\n', 'two', 'two'],
  ['u-nested-math', '- top\n  - inner $z$ word\n', 'word', 'word'],
  ['u-quote-code', '> quote `code` and words\n\nzz\n', 'quote', 'words'],
  ['u-hardbreak', 'line one' + BS + '\nline $x$ two words\n\nzz\n', 'two', 'two'],
  ['u-reflink', 'See [link text][r] and words\n\n[r]: https://e.example/\n', 'See', 'and'],
  ['u-autolink', 'Visit <https://e.example/> now words\n\nzz\n', 'Visit', 'now'],
  ['u-kbd', 'Press <kbd>Ctrl</kbd> then words\n\nzz\n', 'Press', 'then'],
  ['u-escapes', 'Not ' + BS + '*star' + BS + '* and words\n\nzz\n', 'Not', 'and'],
  ['u-amp', 'A &amp; B and words\n\nzz\n', 'words', 'and'],
  ['u-snake', 'snake_case_name and words\n\nzz\n', 'and', 'and'],
  ['u-leading-math', '$x$ starts this line\n\nzz\n', 'line', 'starts'],
  ['u-heading-math', '## Title $a$ word end\n\nzz\n', 'word', 'word'],
  ['u-tilde', 'a ~b c ~~del~~ words\n\nzz\n', 'words', 'words'],
  ['u-star-mid', 'x*y = z and words\n\nzz\n', 'and', 'and'],
  ['u-under-lead', '_x and more words\n\nzz\n', 'more', 'more'],
  ['u-inline-html-img', 'Pic <img src="https://e.example/i.png"> and words\n\nzz\n', 'and', 'and'],
  ['u-ordered-math', '1. one $a$ two\n2. three $b$ four\n', 'four', 'four'],
  ['u-second-line-softbreak', 'first $m$ line\nsecond $n$ line words\n\nzz\n', 'words', 'words'],
  ['u-footnote-two', 'A[^1] B[^2] words\n\n[^1]: n1\n[^2]: n2\n', 'words', 'words'],
  ['e-heading-math-end', '## Title $a^2$\n\nzz\n', 'Title', null],
  ['e-quote-math-end', '> quote $a^2$\n\nzz\n', 'quote', null],
  ['e-nested-math-end', '- top\n  - inner $z$\n', 'inner', null],
  ['e-task-math-end', '- [ ] task $y$\n- [ ] two\n', 'task', null],
  ['e-bold-math-end', 'text **b $x$**\n\nzz\n', 'text', null],
  ['e-image-end', `text ${IMG}\n\nzz\n`, 'text', null],
  ['e-inline-display-end', 'text $$x$$\n\nzz\n', 'text', null],
  ['e-link-math-end', 'text [$x$](https://e.example/)\n\nzz\n', 'text', null],
  ['e-quote-list-math', '> - item $x$ two words\n\nzz\n', 'item', 'two'],
  ['e-list-multipara', '- para one\n\n  para $x$ two words\n\nzz\n', 'one', 'two'],
  ['e-emoji-entity', 'A &#x1F600; B and words\n\nzz\n', 'and', 'and'],
  ['e-html-comment', 'A <!-- c --> B and words\n\nzz\n', 'and', 'and'],
];
const M = [
  ['m-footnote-end', 'see[^1]\n\nb1 yy\n\n[^1]: note\n', 'yy', 'b1', (s) => /^see\[\^1\](\(note\))?Qb1 yy\n\n\[\^1\]: note\n$/.test(s)],
  ['m-entity-end', 'Tom &amp;\n\nb1 yy\n\nzz\n', 'yy', 'b1', (s) => s === 'Tom &amp;Qb1 yy\n\nzz\n' || s === 'Tom &Qb1 yy\n\nzz\n'],
  ['m-escape-end', 'a ' + BS + '*\n\nb1 yy\n\nzz\n', 'yy', 'b1', 'a ' + BS + '*Qb1 yy\n\nzz\n'],
  ['m-link-end', 'go [t](https://e.example/)\n\nb1 yy\n\nzz\n', 'yy', 'b1', (s) => s === 'go [t](https://e.example/)Qb1 yy\n\nzz\n'],
  ['m-two-math-end', 'a1 $x$$y$\n\nb1 yy\n\nzz\n', 'yy', 'b1', 'a1 $x$$y$Qb1 yy\n\nzz\n'],
  ['m-reflink-end', 'see [t][r]\n\nb1 yy\n\n[r]: https://e.example/\n', 'yy', 'b1', (s) => /^see \[t\](\[r\]|\(https:\/\/e\.example\/\))Qb1 yy\n\n\[r\]: https:\/\/e\.example\/\n$/.test(s)],
  ['m-star-literal-end', 'pay 5* x\n\nb1 yy\n\nzz\n', 'yy', 'b1', (s) => /^pay 5(\\)?\* xQb1 yy\n\nzz\n$/.test(s)],
  ['m-hardbreak-mid', 'one' + BS + '\ntwo\n\nb1 yy\n\nzz\n', 'yy', 'b1', (s) => /^one(\\|  )\ntwoQb1 yy\n\nzz\n$/.test(s)],
];
let bad = 0;
const want = (n) => !only.length || only.some((o) => n.startsWith(o));
try {
  await B.boot('mode=split');
  for (const [name, doc, click, at] of H) {
    for (const kind of ['undo', 'redo']) {
      const nm = `${name}-${kind}`;
      if (!want(nm)) continue;
      try {
        await load(B, doc);
        await clickText(page, click, Math.min(1, click.length - 1), { side: 'right' });
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no session ' + J(v0).slice(0, 200));
        await sleep(80);
        if (at) await caretTo(page, at, 'after'); else await page.keyboard.press('Meta+ArrowRight');
        await sleep(80);
        await page.keyboard.type('XY');
        await settle(700);
        const sXY = await B.source();
        if (!sXY.includes('XY')) throw new Error('XY not written ' + J(sXY));
        await page.keyboard.press('Meta+z');
        await settle(700);
        const sU = await B.source();
        if (kind === 'redo') { await page.keyboard.press('Meta+Shift+z'); await settle(700); }
        await page.keyboard.type('Q');
        await settle(600);
        const v = await view(page);
        const exp = kind === 'undo' ? sXY.replace('XY', 'Q') : sXY.replace('XY', 'XYQ');
        const ok = sU === doc && v.src === exp;
        if (!check(nm, ok, `observed=${J(v.src)} expected=${J(exp)}${sU !== doc ? ' afterUndo=' + J(sU) : ''}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
  for (const [name, doc, click, at, exp] of M) {
    if (!want(name)) continue;
    try {
      await load(B, doc);
      await clickText(page, click, Math.min(1, click.length - 1), { side: 'right' });
      const v0 = await waitSession(page);
      if (!v0.editing) throw new Error('no session');
      await sleep(80);
      await caretTo(page, at, 'before');
      await sleep(80);
      await page.keyboard.press('Backspace');
      await settle(700);
      await page.keyboard.type('Q');
      await settle(600);
      const v = await view(page);
      const ok = typeof exp === 'function' ? exp(v.src) : v.src === exp;
      if (!check(name, ok, `observed=${J(v.src)} expected=${typeof exp === 'function' ? '(see script)' : J(exp)}`)) bad++;
    } catch (e) { bad++; check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
