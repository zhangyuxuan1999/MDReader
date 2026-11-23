// bench/verify/v5-cha-pdmath.mjs — challenge-a (round 4): P-D's display-formula branch of caretForSource (a history
// resume into a $$ block opens its TeX source with the caret at its END). A click on the formula opens its TeX source,
// the caret is put after `at` in the TeX, XY is typed, Cmd-Z, then Q: Q must stand where XY stood.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-pdmath.mjs
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickSel, load } from './v4-sesa-lib.mjs';

const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const C = [
  ['tex-end', 'para one\n\n$$\nx^2+y\n$$\n\nzz\n', 'x^2+y'],
  ['tex-mid', 'para one\n\n$$\nx^2+y\n$$\n\nzz\n', 'x^2'],
  ['tex-line1-of-2', 'para one\n\n$$\na+b\n\\\\ c+d\n$$\n\nzz\n', 'a+b'],
];
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, at] of C) {
    try {
      await load(B, doc);
      const v0 = await clickSel(B, '.md-math');
      if (!v0.editing) throw new Error('no session');
      await sleep(200);
      const placed = await page.evaluate((at) => {
        const el = document.querySelector('.mdr-preview .is-editing');
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf(at);
          if (i >= 0 && !n.parentElement.closest('.katex')) { const r = document.createRange(); r.setStart(n, i + at.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
        }
        return false;
      }, at);
      if (!placed) throw new Error('TeX source not shown');
      await page.keyboard.type('XY');
      await settle(700);
      const sXY = await B.source();
      await page.keyboard.press('Meta+z');
      await settle(700);
      const sU = await B.source();
      await page.keyboard.type('Q');
      await settle(600);
      const v = await view(page);
      const exp = sXY.replace('XY', 'Q');
      if (!check(name, sU === doc && v.src === exp, `observed=${J(v.src)} expected=${J(exp)} afterUndo=${J(sU)}`)) bad++;
    } catch (e) { bad++; check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
