// bench/verify/v5-ptr-pastecross.mjs — verify-session-pointer: a paste over a selection that CROSSES line boxes inside one
// block (two task items, two items of different nesting, two table cells or rows, a hard break, two quote lines, a
// list item into its nested list) equals typing over the same selection (one-line texts), writes nothing invisible,
// shows no literal "[ ]" / "[x]" / "|" that the document did not show, and one ⌘Z gives the source back.
// Also ⌘⇧V (paste and match style) against ⌘V. Selections are set by script inside a live session.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-pastecross.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, invisibleExtra, none, emptyInline, sessionOn, clickText } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const C = [
  // [name, doc, click needle, from needle, from k, to needle, to k]
  ['task-two', '- [ ] task Ccc one\n- [x] task Ddd two\n- [ ] task Eee\n\nnext\n', 'Ccc', 'Ccc', 0, 'Ddd', 3],
  ['task-three', '- [ ] task Ccc one\n- [x] task Ddd two\n- [ ] task Eee\n\nnext\n', 'Ccc', 'one', 0, 'Eee', 1],
  ['task-start-to-start', '- [ ] task Ccc one\n- [x] task Ddd two\n- [ ] task Eee\n\nnext\n', 'Ccc', 'task Ccc', 0, 'task Ddd', 0],
  ['nest-into', '- top Aaa\n  - inner Bbb\n    - deep Ccc\n- back Ddd\n\nnext\n', 'Aaa', 'Aaa', 1, 'Bbb', 2],
  ['nest-out', '- top Aaa\n  - inner Bbb\n    - deep Ccc\n- back Ddd\n\nnext\n', 'Aaa', 'Ccc', 1, 'Ddd', 2],
  ['cells-row', '| Aaa | Bbb |\n|---|---|\n| Ccc | Ddd |\n| Eee | Fff |\n\nnext\n', 'Ccc', 'Ccc', 1, 'Ddd', 2],
  ['cells-rows', '| Aaa | Bbb |\n|---|---|\n| Ccc | Ddd |\n| Eee | Fff |\n\nnext\n', 'Ccc', 'Ddd', 1, 'Eee', 2],
  ['cells-head-body', '| Aaa | Bbb |\n|---|---|\n| Ccc | Ddd |\n| Eee | Fff |\n\nnext\n', 'Ccc', 'Bbb', 1, 'Ccc', 2],
  ['hardbreak', 'line Aaa one  \nline Bbb two\n\nnext\n', 'Aaa', 'one', 1, 'line Bbb', 4],
  ['quote-lines', '> quote Aaa one\n> quote Bbb two\n\nnext\n', 'Aaa', 'one', 1, 'Bbb', 1],
  ['quote-paras', '> quote Aaa one\n>\n> quote Bbb two\n\nnext\n', 'Aaa', 'one', 1, 'Bbb', 1],
  ['ord-two', '1. ord Aaa\n2. ord Bbb\n3. ord Ccc\n\nnext\n', 'Aaa', 'Aaa', 1, 'Bbb', 1],
  ['loose-items', '- loose Aaa\n\n- loose Bbb\n\nnext\n', 'Aaa', 'Aaa', 1, 'Bbb', 1],
  ['item-para2', '- item Aaa\n\n  second Bbb para\n- other Ccc\n\nnext\n', 'Aaa', 'Bbb', 1, 'Ccc', 1],
  ['heading-only', '## Head Aaa words\n\nnext\n', 'Aaa', 'Head', 0, 'words', 5],
];
async function selectRange(page, a, ak, b, bk) {
  return page.evaluate(({ a, ak, b, bk }) => {
    const ed = document.querySelector('.mdr-preview .is-editing');
    if (!ed) return null;
    const find = (needle, k) => {
      const tw = document.createTreeWalker(ed, 4, { acceptNode: (n) => (n.parentElement?.closest('.katex, [data-mdr-ui]') ? 2 : 1) });
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) return [n, i + k]; }
      return null;
    };
    const p = find(a, ak), q = find(b, bk);
    if (!p || !q) return null;
    getSelection().setBaseAndExtent(p[0], p[1], q[0], q[1]);
    return getSelection().toString();
  }, { a, ak, b, bk });
}
const visible = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim());
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const run = async (c, how, text) => {
    const [, doc, click, a, ak, b, bk] = c;
    await prepare(A, doc);
    await clickText(A.page, click, 1); await sleep(350);
    const sel = await selectRange(A.page, a, ak, b, bk);
    await sleep(60);
    if (how === 'type') await A.page.keyboard.type(text);
    else { await A.page.evaluate((t) => navigator.clipboard.writeText(t), text); await A.page.keyboard.press(how === 'pasteMatch' ? 'Meta+Shift+v' : 'Meta+v'); }
    await sleep(500);
    const emp = await emptyInline(A.page);
    let undo = null;
    if (how !== 'type') { await A.page.keyboard.press('Meta+z'); await sleep(450); await A.settle(100); undo = await A.source(); await A.page.keyboard.press('Meta+Shift+z'); await sleep(450); }
    await A.page.keyboard.press('Escape'); await A.settle(250);
    return { sel, emp, undo, src: await A.source(), vis: await visible(A.page) };
  };
  for (const c of C) {
    for (const text of ['X', 'X\n\nY']) {
      const nm = `${c[0]}-${text.length > 1 ? 'paras' : 'x'}`;
      if (filter && !nm.includes(filter)) continue;
      try {
        const p = await run(c, 'paste', text);
        const t = text.length === 1 ? await run(c, 'type', text) : null;
        const m = text.length === 1 ? await run(c, 'pasteMatch', text) : null;
        const probs = [];
        if (p.sel === null) probs.push('setup');
        if (t && t.src !== p.src) probs.push('paste!=type');
        if (m && m.src !== p.src) probs.push('pasteMatch!=paste');
        if (p.emp.length) probs.push('emptyInline ' + J(p.emp));
        if (p.undo !== c[1]) probs.push('undo!=orig');
        const ix = invisibleExtra(p.src, c[1]); if (!none(ix)) probs.push('invisible ' + J(ix));
        for (const lit of ['[ ]', '[x]', '|']) if (p.vis.includes(lit) && !c[1].includes('\\' + lit)) probs.push('shows ' + lit);
        check(nm, probs.length === 0, `${probs.join(',')} sel=${J(p.sel)} pasted=${show(p.src)}${t ? ` typed=${show(t.src)}` : ''}${m && m.src !== p.src ? ` match=${show(m.src)}` : ''}${p.undo !== c[1] ? ` undo=${show(p.undo)}` : ''}`);
      } catch (e) { check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
