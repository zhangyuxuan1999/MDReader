// bench/verify/v5-ptr-atomloss.mjs — verify-session-pointer: Enter directly before an inline formula that follows
// another formula ($y$|$z$), type a character, Backspace it, Backspace again (the merge back): the source must be the
// original. Observed: the formula BEFORE the caret ($y$) is deleted. GAP = ms between the keys (default 150; the
// script also runs 400 and 800). Variations: image before the formula, formula before an image, text between.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-atomloss.mjs [name-substring]   (RUNS=n)
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const C = [
  ['two-formulas', 'Lead then $y$$z$ end.\n\nnext\n', 'y', 'z'],
  ['image-formula', 'Lead then ![i](x.png)$z$ end.\n\nnext\n', 'img', 'z'],
  ['formula-image', 'Lead then $y$![i](x.png) end.\n\nnext\n', 'y', 'img'],
  ['formula-space-formula', 'Lead then $y$ $z$ end.\n\nnext\n', 'y', 'z'],
  ['text-formula-control', 'Lead then ab$z$ end.\n\nnext\n', 'ab', 'z'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const gap of [150, 400, 800]) {
    for (const [name, doc, , second] of C) {
      if (filter && !name.includes(filter)) continue;
      for (let run = 1; run <= Number(process.env.RUNS || 1); run++) {
        const nm = `${name}-gap${gap}#${run}`;
        try {
          await prepare(A, doc);
          await clickText(A.page, 'Lead', 2); await sleep(350);
          // the caret directly before the second atom (the element position before it)
          const ok0 = await A.page.evaluate((second) => {
            const ed = document.querySelector('.mdr-preview .is-editing'); if (!ed) return false;
            const atoms = Array.from(ed.querySelectorAll('.md-math, img'));
            const t = second === 'img' ? atoms.find((a) => a.tagName === 'IMG') : atoms.filter((a) => a.classList.contains('md-math')).pop();
            const i = Array.prototype.indexOf.call(t.parentNode.childNodes, t);
            getSelection().setBaseAndExtent(t.parentNode, i, t.parentNode, i);
            return true;
          }, second);
          const live = await sessionOn(A.page);
          await A.page.keyboard.press('Enter'); await sleep(gap);
          await A.page.keyboard.type('Q'); await sleep(gap);
          await A.page.keyboard.press('Backspace'); await sleep(gap);
          await A.page.keyboard.press('Backspace'); await sleep(Math.max(gap, 500));
          await A.settle(200);
          await A.page.keyboard.press('Escape'); await A.settle(250);
          const src = await A.source();
          check(nm, ok0 && live && src === doc, `src=${show(src)}`);
        } catch (e) { check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
      }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
