// bench/verify/r5-fa-tasku23.mjs — fix-atoms (stage 2f, fix round 5): U23 with atoms (P-G e) in task lists. Enter in a
// task item makes a new task item with a checkbox the session puts there; Backspace right after that box (or Enter,
// typing, two Backspaces) must give the source back byte for byte, at an item's end, in its middle, before an item's
// text, tight and loose, with a formula in the item. Also: Enter then typing makes a new task item ("- [ ] N").
// Informational (pre-existing, identical on the snapshot taken before round 5): Enter with the caret BEFORE the box (Home).
// Run: MDR_PORT=5461 node bench/verify/r5-fa-tasku23.mjs   (exit 1 on a failure; global timeout 100 s)
import { sleep, globalTimeout, J, check, summary, results, openAt, prepare, CP, clickText } from './v5-ptr-lib.mjs';

let A = null;
const stop = globalTimeout(100_000, async () => { await A?.close(); });
// [name, doc, click needle, k, key before, keys, expected source (null: the document), informational]
const cases = [
  ['end-tight', '- [ ] one first\n- [x] two\n\nnext\n', 'first', 2, 'End', ['Enter', 'Backspace'], null],
  ['end-loose', '- [x] one first\n\n- [ ] two\n\nnext\n', 'first', 2, 'End', ['Enter', 'Backspace'], null],
  ['mid-tight', '- [ ] one first\n- [x] two\n\nnext\n', 'first', 2, null, ['Enter', 'Backspace'], null],
  ['mid-formula', '- [ ] one $x^2$ first\n- [x] two\n\nnext\n', 'first', 2, null, ['Enter', 'Backspace'], null],
  ['text-start-formula', '- [ ] one\n- [x] Lead $\\frac{a}{b}$ two\n\nnext\n', 'Lead', 0, null, ['Enter', 'Backspace'], null],
  ['end-type-bs3', '- [ ] one first\n- [x] two\n\nnext\n', 'first', 2, 'End', ['Enter', 'N', 'Backspace', 'Backspace'], null],
  ['end-type', '- [ ] one first\n- [x] two\n\nnext\n', 'first', 2, 'End', ['Enter', 'N'], '- [ ] one first\n- [ ] N\n- [x] two\n\nnext\n'],
  ['info-before-box', '- [ ] one first\n- [x] two $x$\n\nnext\n', 'two', 2, 'Home', ['Enter', 'Backspace'], null, true],
];
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, doc, needle, k, pre, keys, want, info] of cases) {
    try {
      await prepare(A, doc);
      await clickText(page, needle, k); await sleep(300);
      if (pre) { await page.keyboard.press(pre); await sleep(100); }
      for (const key of keys) { if (key.length === 1) await page.keyboard.type(key); else await page.keyboard.press(key); await sleep(250); }
      await A.settle(250);
      await page.keyboard.press('Escape'); await A.settle(250);
      const src = await A.source();
      const ok = src === (want ?? doc);
      if (info) console.log(`INFO  ${name}  ${ok ? 'same' : 'changed'} ${J(src)}`);
      else check(name, ok, `src=${J(src)}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
