// bench/verify/v5-ptr-arrowatom.mjs — verify-session-pointer: the caret moved by arrow keys (or collapsed after a
// triple-click) next to an inline formula must never sit INSIDE the formula's rendering (contenteditable=false), where
// every typed key is swallowed. Each case puts the caret by a click, moves it with keys, types 'TYPED' and checks that
// it is in the source exactly once (and where the caret was: focus element).
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-arrowatom.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const P = 'Para Aaa with $x^2$ formula words.\n\nNext Bbb end.\n';
const H = '# Head Aaa with $x^2$ formula\n\nNext Bbb end.\n';
const E = 'Para Aaa ends with $x^2$\n\nNext Bbb end.\n';
const C = [
  // [name, doc, click [needle, k, side], clickCount, keys]
  ['para-before-right1', P, ['with ', 4, 'right'], 1, ['ArrowRight']],
  ['para-before-right2', P, ['with ', 4, 'right'], 1, ['ArrowRight', 'ArrowRight']],
  ['para-after-left1', P, [' formula', 0], 1, ['ArrowLeft']],
  ['para-after-left2', P, [' formula', 0], 1, ['ArrowLeft', 'ArrowLeft']],
  ['para-triple-right', P, ['with', 1], 3, ['ArrowRight']],
  ['para-triple-left', P, ['with', 1], 3, ['ArrowLeft']],
  ['heading-triple-right', H, ['with', 1], 3, ['ArrowRight']],
  ['heading-dbl-right', H, ['with', 1], 2, ['ArrowRight', 'ArrowRight']],
  ['para-shift-right-type', P, ['with ', 4, 'right'], 1, ['Shift+ArrowRight']],
  ['ends-end', E, ['ends', 1], 1, ['End']],
  ['ends-triple-right', E, ['ends', 1], 3, ['ArrowRight']],
  ['para-alt-right', P, ['with', 0], 1, ['Alt+ArrowRight', 'Alt+ArrowRight']],
  ['para-down-up', 'First line here\n\nPara Aaa with $x^2$ formula words.\n\nNext Bbb end.\n', ['line', 1], 1, ['ArrowDown']],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const [name, doc, at, cc, keys] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await prepare(A, doc);
      await clickText(A.page, at[0], at[1], { side: at[2] ?? 'left' }); await sleep(350);
      if (cc > 1) { await clickText(A.page, at[0], at[1], { side: at[2] ?? 'left', clickCount: 2 }); await sleep(20); }
      if (cc > 2) { await clickText(A.page, at[0], at[1], { side: at[2] ?? 'left', clickCount: 3 }); }
      await sleep(250);
      for (const k of keys) { await A.page.keyboard.press(k); await sleep(80); }
      const where = await A.page.evaluate(() => { const n = getSelection().focusNode; const e = n?.nodeType === 1 ? n : n?.parentElement; return { el: e?.tagName, inMath: !!e?.closest('.md-math'), inEditing: !!e?.closest('.is-editing') }; });
      const live = await sessionOn(A.page);
      await A.page.keyboard.type('TYPED'); await sleep(700); await A.settle(150);
      await A.page.keyboard.press('Escape'); await A.settle(250);
      const src = await A.source();
      const k = src.split('TYPED').length - 1;
      check(name, live && k === 1, `caret=${J(where)} live=${live} src=${show(src)}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
