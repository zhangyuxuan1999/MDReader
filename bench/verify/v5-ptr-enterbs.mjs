// bench/verify/v5-ptr-enterbs.mjs — verify-session-pointer: U23 / U21 sweep for DATA LOSS. In a live session the caret is
// put (by script) at every text-node boundary and next to every atom (formula, image, checkbox) of a block; then
// Enter + Backspace (or Shift+Enter + Backspace, or Enter + 'Q' + Backspace + Backspace) at human speed; after Esc the
// source is compared with the original. Classes: SAME; KNOWN-J29 (only a space next to the caret lost); KNOWN-J7 (a
// backslash break written); OTHER (any other change: a lost character, atom, mark or line: printed in full).
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-enterbs.mjs [name-substring] [--mode enter|shift|typed]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, sessionOn, clickText } from './v5-ptr-lib.mjs';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const mi = process.argv.indexOf('--mode');
const MODE = mi > 0 ? process.argv[mi + 1] : 'enter';
const DOCS = [
  ['para-atoms', 'Lead $x$ and ![i](x.png) then $y$$z$ end.\n\nnext\n', 'Lead'],
  ['bold-atom', 'Pre **bold $x$ in** post ![i](x.png).\n\nnext\n', 'Pre'],
  ['link-img', 'See [the ![i](x.png) link](http://e.x/) here.\n\nnext\n', 'here'],
  ['heading-atom', '## Head $h$ with ![i](x.png) img\n\nnext\n', 'Head'],
  ['item-atom', '- item $q$ one\n- item two ![i](x.png)\n\nnext\n', 'one'],
  ['task-item', '- [ ] task one\n- [x] task two\n\nnext\n', 'one'],
  ['quote-atom', '> quote $w$ line\n> second\n\nnext\n', 'quote'],
  ['cell-atom', '| a $c$ b | d |\n|---|---|\n| e | f |\n\nnext\n', 'd'],
  ['code-span', 'Use `code here` and *em* text.\n\nnext\n', 'Use'],
  ['hardbreak', 'first line  \nsecond $s$ line\n\nnext\n', 'first'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
const counts = { SAME: 0, 'KNOWN-J29': 0, 'KNOWN-J7': 0, OTHER: 0, NOSESSION: 0 };
try {
  A = await openAt(CP, false);
  for (const [name, doc, click] of DOCS) {
    if (filter && !name.includes(filter)) continue;
    await prepare(A, doc);
    await clickText(A.page, click, 1); await sleep(350);
    const npos = await A.page.evaluate(() => {
      const ed = document.querySelector('.mdr-preview .is-editing'); if (!ed) return 0;
      const pts = [];
      const tw = document.createTreeWalker(ed, 5, { acceptNode: (n) => (n.parentElement?.closest('.katex, [data-mdr-ui], .md-math') ? 2 : 1) });
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (n.nodeType === 3) { if (!n.data.trim()) continue; pts.push(1); pts.push(1); if (n.data.length > 2) pts.push(1); }
        else if (n.matches('.md-math, img, input')) { pts.push(1); pts.push(1); }
      }
      return pts.length;
    });
    await A.page.keyboard.press('Escape'); await A.settle(100);
    for (let k = 0; k < npos; k++) {
      const nm = `${name}-${MODE}-p${k}`;
      try {
        await prepare(A, doc);
        await clickText(A.page, click, 1); await sleep(350);
        const where = await A.page.evaluate((k) => {
          const ed = document.querySelector('.mdr-preview .is-editing'); if (!ed) return null;
          const pts = [];
          const tw = document.createTreeWalker(ed, 5, { acceptNode: (n) => (n.parentElement?.closest('.katex, [data-mdr-ui], .md-math') ? 2 : 1) });
          for (let n = tw.nextNode(); n; n = tw.nextNode()) {
            if (n.nodeType === 3) { if (!n.data.trim()) continue; pts.push([n, 0]); pts.push([n, n.data.length]); if (n.data.length > 2) pts.push([n, Math.floor(n.data.length / 2)]); }
            else if (n.matches('.md-math, img, input')) {
              const i = Array.prototype.indexOf.call(n.parentNode.childNodes, n);
              pts.push([n.parentNode, i]); pts.push([n.parentNode, i + 1]);
            }
          }
          const [node, off] = pts[k];
          getSelection().setBaseAndExtent(node, off, node, off);
          const r = document.createRange(); r.setStart(ed, 0); r.setEnd(node, off);
          return r.toString().slice(-8) + '|';
        }, k);
        if (where === null) { counts.NOSESSION++; check(nm, false, 'no session'); continue; }
        await sleep(80);
        if (MODE === 'shift') { await A.page.keyboard.press('Shift+Enter'); await sleep(300); await A.page.keyboard.press('Backspace'); }
        else if (MODE === 'typed') { await A.page.keyboard.press('Enter'); await sleep(300); await A.page.keyboard.type('Q'); await sleep(150); await A.page.keyboard.press('Backspace'); await sleep(150); await A.page.keyboard.press('Backspace'); }
        else { await A.page.keyboard.press('Enter'); await sleep(300); await A.page.keyboard.press('Backspace'); }
        await sleep(600); await A.settle(150);
        await A.page.keyboard.press('Escape'); await A.settle(200);
        const src = await A.source();
        let cls = 'SAME';
        if (src !== doc) {
          const strip = (s) => s.replace(/ /g, '');
          if (strip(src) === strip(doc) && src.length === doc.length - 1) cls = 'KNOWN-J29';
          else if (src.includes('\\\n') && !doc.includes('\\\n')) cls = 'KNOWN-J7';
          else cls = 'OTHER';
        }
        counts[cls]++;
        check(nm, cls !== 'OTHER', `${cls} caret=${J(where)}${cls !== 'SAME' ? ` src=${show(src)}` : ''}`);
      } catch (e) { counts.OTHER++; check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  console.log('classes ' + J(counts));
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
