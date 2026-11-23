// bench/verify/v4-sesa-repro.mjs — verify-session-a: the repro of every SESA finding, one group per finding.
// Each case: fresh document, a real click into the block, the caret put by text (caretTo) or a key, the keys, then
// the source compared with what a text editor gives (exact string or a predicate); FAIL lines print observed and
// expected. Exit code 1 when a case of the selected groups fails.
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-repro.mjs [SESA-n ...]   (no argument: every group; T_MS default 110 s)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } from './v4-sesa-lib.mjs';

const groups = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const IMG = '![i](https://e.example/i.png)';
const E = [['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]];
const SE = [['k', 'Shift+Enter'], ['w'], ['t', 'Z'], ['w', 500]];
const W7 = ['w', 700];
const noBr = (s) => !s.includes('\\\n') && !/<br>Z/.test(s);
const G = {
  'SESA-1': [
    // ⌘Z / ⇧⌘Z whose position is the end of a line that ends with an inline formula: the caret is put INSIDE the
    // (non-editable) formula and every key typed next is swallowed until a click
    ['undo-math-at-end', 'a1 b1 $x^2$\n\nzz\n', 'b1', 'Meta+ArrowRight', [['t', 'QR'], W7, ['k', 'Meta+z'], W7, ['t', 'W'], ['w', 500]], 'a1 b1 $x^2$W\n\nzz\n'],
    ['undo-newpara-after-math', 'a1 b1 $x^2$\n\nzz\n', 'b1', 'Meta+ArrowRight', [['k', 'Enter'], ['w'], ['t', 'new'], W7, ['k', 'Meta+z'], W7, ['t', 'W'], ['w', 500]], (s) => s === 'a1 b1 $x^2$W\n\nzz\n' || s === 'a1 b1 $x^2$\n\nW\n\nzz\n'],
    ['undo-math-at-end-item', '- a1 $x$\n- b1\n', 'a1', 'Meta+ArrowRight', [['t', 'QR'], W7, ['k', 'Meta+z'], W7, ['t', 'W'], ['w', 500]], '- a1 $x$W\n- b1\n'],
    ['undo-math-at-end-cell', '| h |\n| --- |\n| c1 $x$ |\n', 'c1', 'Meta+ArrowRight', [['t', 'QR'], W7, ['k', 'Meta+z'], W7, ['t', 'W'], ['w', 500]], '| h |\n| --- |\n| c1 $x$W |\n'],
    ['redo-math-at-end', 'a1 b1 $x^2$\n\nzz\n', 'b1', 'End', [['t', 'QR'], W7, ['k', 'Meta+z'], W7, ['k', 'Meta+Shift+z'], W7, ['t', 'W'], ['w', 500]], 'a1 b1 $x^2$QRW\n\nzz\n'],
  ],
  'SESA-2': [
    // U3 merge / ⌘Z / ⇧⌘Z: the mapped caret is displaced by an inline formula, an image, a reference link before
    // it on the line, or cannot reach an empty list item
    ['merge-math-end', 'a1 $x^2$\n\nb1 yy\n\nzz\n', 'yy', 'Meta+ArrowLeft', [['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'a1 $x^2$Qb1 yy\n\nzz\n'],
    ['undo-newpara-after-image', `see ${IMG}\n\nzzz\n`, 'see', 'End', [['k', 'Enter'], ['w'], ['t', 'new'], W7, ['k', 'Meta+z'], W7, ['t', 'Q'], ['w', 500]], `see ${IMG}Q\n\nzzz\n`],
    ['merge-image-end', `see ${IMG}\n\nb1 yy\n\nzz\n`, 'yy', 'Meta+ArrowLeft', [['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], `see ${IMG}Qb1 yy\n\nzz\n`],
    ['undo-after-math', 'a1 $x^2$ b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W7, ['k', 'Meta+z'], W7, ['t', 'Q'], ['w', 500]], 'a1 $x^2$ b1Q yy\n\nzzz\n'],
    ['redo-after-math', 'a1 $x^2$ b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W7, ['k', 'Meta+z'], W7, ['k', 'Meta+Shift+z'], W7, ['t', 'Q'], ['w', 500]], 'a1 $x^2$ b1XYQ yy\n\nzzz\n'],
    ['undo-after-reflink', 'see[^1] b1 yy\n\n[^1]: note\n', 'yy', ['b1', 'after'], [['t', 'XY'], W7, ['k', 'Meta+z'], W7, ['t', 'Q'], ['w', 500]], (s) => /^see\[\^1\](\(note\))? b1Q yy\n\n\[\^1\]: note\n$/.test(s)],
    ['undo-to-empty-item', '- one\n- two\n\nz\n', 'two', 'End', [['k', 'Enter'], ['w'], ['t', 'def'], W7, ['k', 'Meta+z'], W7, ['t', 'Q'], ['w', 500]], (s) => s === '- one\n- two\n- Q\n\nz\n' || s === '- one\n- twoQ\n\nz\n'],
    ['merge-into-math-end-then-type', 'a1 $\\frac{a}{b}$\n\nb1\n\nzz\n', 'b1', 'Meta+ArrowLeft', [['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'a1 $\\frac{a}{b}$Qb1\n\nzz\n'],
  ],
  'SESA-3': [
    // Enter / Shift+Enter before an inline formula inside bold, italic or a link: a hard break nobody typed
    ['math-in-bold', 'abc **$x$ b** y\n\nz\n', 'abc', ['abc', 'after'], E, (s) => noBr(s) && /^abc\n\n(Z\*\*|\*\*Z)\$x\$ b\*\* y\n\nz\n$/.test(s)],
    ['math-in-em', 'abc *$x$ b* y\n\nz\n', 'abc', ['abc', 'after'], E, (s) => noBr(s) && /^abc\n\n(Z\*|\*Z)\$x\$ b\* y\n\nz\n$/.test(s)],
    ['math-in-link', 'abc [$x$ b](https://e.example/) y\n\nz\n', 'abc', ['abc', 'after'], E, (s) => noBr(s) && /^abc\n\n(Z\[|\[Z)\$x\$ b\]\(https:\/\/e\.example\/\) y\n\nz\n$/.test(s)],
    ['math-in-bold-shift', 'abc **$x$ b** y\n\nz\n', 'abc', ['abc', 'after'], SE, (s) => /^abc {2}\n(Z\*\*|\*\*Z)\$x\$ b\*\* y\n\nz\n$/.test(s)],
    ['math-in-bold-item', '- abc **$x$ b** y\n- e\n', 'abc', ['abc', 'after'], E, (s) => noBr(s) && /^- abc\n- (Z\*\*|\*\*Z)\$x\$ b\*\* y\n- e\n$/.test(s)],
  ],
  'SESA-4': [
    // Enter right before an image in a heading, a linked image, an image followed by a formula: Z lands after it
    ['image-in-h2', `## abc ${IMG} y\n\nz\n`, 'abc', ['abc', 'after'], E, `## abc\n\nZ${IMG} y\n\nz\n`],
    ['image-in-h1-nospace', `# abc${IMG} y\n\nz\n`, 'abc', ['abc', 'after'], E, `# abc\n\nZ${IMG} y\n\nz\n`],
    ['linked-image', `abc [${IMG}](https://e.example/) y\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ[${IMG}](https://e.example/) y\n\nz\n`],
    ['image-then-math', `abc ${IMG}$x$ d\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ${IMG}$x$ d\n\nz\n`],
  ],
  'SESA-5': [
    // ⌘A ⌫ ⌫ Q at machine speed: the second ⌫ arrives in the frame of the emptying (before the deletion is written)
    ['fast-prev-heading', '# Hd1\n\nxx para\n\nzz\n', 'para', null, [['fast', 'Meta+a', 'Backspace', 'Backspace', 'Q'], ['w', 900]], '# Hd1Q\n\nzz\n'],
    ['fast-prev-list', '- a1\n- b1\n\nxx para\n\nzz\n', 'para', null, [['fast', 'Meta+a', 'Backspace', 'Backspace', 'Q'], ['w', 900]], '- a1\n- b1Q\n\nzz\n'],
    ['fast-prev-fence', '```\ncode1\n```\n\nxx para\n\nzz\n', 'para', null, [['fast', 'Meta+a', 'Backspace', 'Backspace', 'Q'], ['w', 900]], '```\ncode1Q\n```\n\nzz\n'],
    ['fast-prev-math-end', 'a1 $x^2$\n\nxx para\n\nzz\n', 'para', null, [['fast', 'Meta+a', 'Backspace', 'Backspace', 'Q'], ['w', 900]], 'a1 $x^2$Q\n\nzz\n'],
  ],
  'SESA-6': [
    // deleting the last block of a document without a final newline adds one
    ['last-block-no-final-newline', 'aaa\n\nxx para', 'para', null, [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['k', 'Escape'], ['w']], 'aaa'],
    ['last-block-no-final-newline-3', 'aaa\n\nbbb\n\nxx para', 'para', null, [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['k', 'Escape'], ['w']], 'aaa\n\nbbb'],
    ['last-block-no-final-newline-bs', 'aaa\n\nxx para', 'para', null, [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaaQ'],
  ],
  'SESA-7': [
    // ⌘A ⌫ in a loose list leaves an empty item that typing then writes
    ['loose-list-empty-type', 'aaa\n\n- a1\n\n- b1\n\n- c1\n\nzz\n', 'b1', null, [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['t', 'N'], ['w', 500]], (s) => s === 'aaa\n\n- N\n\nzz\n' || s === 'aaa\n\nN\n\nzz\n'],
    ['loose-task-list-empty-type', '- a1\n\n- [ ] t1\n\n- z1\n', 't1', null, [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['t', 'N'], ['w', 500]], (s) => s === '- N\n' || s === 'N\n'],
  ],
  'SESA-9': [
    // Enter / Shift+Enter right before a hard line break: the typed text goes after the break
    ['enter-before-hardbreak', 'abc  \ndef\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ  \ndef\n\nz\n'],
    ['shift-enter-before-hardbreak', 'abc  \ndef\n\nz\n', 'abc', ['abc', 'after'], SE, 'abc  \nZ  \ndef\n\nz\n'],
    ['enter-before-hardbreak-item', '- abc  \n  def\n- e\n', 'abc', ['abc', 'after'], E, '- abc\n- Z  \n  def\n- e\n'],
  ],
};
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [g, cases] of Object.entries(G)) {
    if (groups.length && !groups.includes(g)) continue;
    for (const [name, doc, click, at, steps, want] of cases) {
      try {
        await load(B, doc);
        await clickText(page, click, Math.min(1, click.length - 1), { side: 'right' });
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no session ' + J(v0));
        await sleep(80);
        if (Array.isArray(at)) await caretTo(page, at[0], at[1]); else if (at) await page.keyboard.press(at);
        await sleep(80);
        for (const st of steps) {
          const [op, a] = st;
          if (op === 'k') await page.keyboard.press(a);
          else if (op === 't') await page.keyboard.type(a);
          else if (op === 'w') await settle(a ?? 320);
          else if (op === 'fast') { for (const k of st.slice(1)) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); } }
        }
        const v = await view(page);
        const ok = typeof want === 'function' ? want(v.src) : v.src === want;
        if (!check(`${g} ${name}`, ok, `observed=${J(v.src)} expected=${typeof want === 'function' ? '(see script)' : J(want)}`)) bad++;
      } catch (e) { bad++; check(`${g} ${name}`, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
  // SESA-7: after ⌘A ⌘A (the whole preview selected) the first click on a block starts no session
  if (!groups.length || groups.includes('SESA-8')) {
    try {
      await load(B, 'aaa\n\nxx para\n\nzz\n');
      await clickText(page, 'xx para', 1, { side: 'right' }); await waitSession(page);
      await page.keyboard.press('Meta+a'); await sleep(50); await page.keyboard.press('Meta+a'); await settle();
      await clickText(page, 'zz', 1, { side: 'right' }); await settle();
      await page.keyboard.type('Y'); await settle(500);
      const s = await B.source();
      if (!check('SESA-8 click-after-select-all', s === 'aaa\n\nxx para\n\nzYz\n' || s === 'aaa\n\nxx para\n\nzzY\n', `observed=${J(s)} expected="aaa\\n\\nxx para\\n\\nzYz\\n" (Y typed where the first click put the caret)`)) bad++;
    } catch (e) { bad++; check('SESA-8 click-after-select-all', false, 'threw ' + String(e.message).split('\n')[0]); }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
