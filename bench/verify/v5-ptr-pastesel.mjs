// bench/verify/v5-ptr-pastesel.mjs — verify-session-pointer: P-A / U19, a paste over a selection equals TYPING the same
// text over the same selection. The selection is set exactly by script inside a live session (block text offsets of
// a needle, widened by dl / dr characters across element edges). For one-line texts the paste's source must equal the
// typed source; for every text: no inline element without text is left in the DOM, no "[](" / "****" / "~~~~" / "``"
// pair is written, no invisible character the document did not hold, the visible text equals the expected one, and
// ONE ⌘Z in the session gives the original source back byte for byte.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-pastesel.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, invisibleExtra, none, emptyInline, sessionOn, clickText, domZw } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const [SH, SN] = (process.env.SHARD || '0/1').split('/').map(Number);
const CLICK = { link: 'tail', linkstart: 'line', bold: 'tail', em: 'tail', del: 'tail', code: 'tail', boldlink: 'tail', linkbold: 'tail', bi: 'tail', heading: 'words', item: 'item', nested: 'nested', cell: 'cell', quote: 'quoted', para: 'paragraph', linkimg: 'tail', boldformula: 'tail' };
let caseNo = 0;
const DOCS = {
  link: 'Lead **bold words** tail and [link](https://e.x/y) end.\n\nnext\n',
  linkstart: '[start](https://e.x/s) of the line here.\n\nnext\n',
  bold: 'Lead **bold** tail.\n\nnext\n',
  em: 'Lead *italic* tail.\n\nnext\n',
  del: 'Lead ~~gone~~ tail.\n\nnext\n',
  code: 'Lead `code` tail.\n\nnext\n',
  boldlink: 'Lead [**strong**](https://e.x/b) tail.\n\nnext\n',
  linkbold: 'Lead **[inner](https://e.x/i)** tail.\n\nnext\n',
  bi: 'Lead ***both*** tail.\n\nnext\n',
  heading: '## Heading words\n\nnext\n',
  item: '- first item\n- second item\n- third\n\nnext\n',
  nested: '- top\n  - nested item\n- last\n\nnext\n',
  cell: '| a | b |\n|---|---|\n| cell one | cell two |\n\nnext\n',
  quote: '> quoted words here\n\nnext\n',
  para: 'Whole paragraph text.\n\nnext\n',
  linkimg: 'Lead [![im](x.png) word](https://e.x/w) tail.\n\nnext\n',
  boldformula: 'Lead **bo $x$ ld** tail.\n\nnext\n',
};
// [name, doc, needle, dl, dr, text] — the selection is needle's characters, start moved by dl, end by dr.
// MDR_SUB=1: every document's first block also holds a KaTeX subscript (its rendering then has zero-width characters
// of its own, and the session trusts only its registry of helpers); the live session DOM is then checked right after
// the paste for a zero-width character that is no helper (not right before an atom).
if (process.env.MDR_SUB) for (const k of Object.keys(DOCS)) DOCS[k] = DOCS[k].replace('\n\nnext', k === 'cell' ? '\n\nnext' : ' $y_2$\n\nnext').replace('| cell two |', '| cell two $y_2$ |');
const SEL = [
  ['link-whole', 'link', 'link', 0, 0], ['link-l1', 'link', 'link', -1, 0], ['link-r1', 'link', 'link', 0, 1], ['link-in1', 'link', 'link', 1, 0],
  ['linkstart-whole', 'linkstart', 'start', 0, 0], ['linkstart-r1', 'linkstart', 'start', 0, 1],
  ['bold-whole', 'bold', 'bold', 0, 0], ['bold-l1', 'bold', 'bold', -1, 0], ['bold-r1', 'bold', 'bold', 0, 1],
  ['em-whole', 'em', 'italic', 0, 0], ['em-r1', 'em', 'italic', 0, 1],
  ['del-whole', 'del', 'gone', 0, 0], ['del-l1', 'del', 'gone', -1, 0],
  ['code-whole', 'code', 'code', 0, 0], ['code-r1', 'code', 'code', 0, 1], ['code-l1', 'code', 'code', -1, 0],
  ['boldlink-whole', 'boldlink', 'strong', 0, 0], ['boldlink-r1', 'boldlink', 'strong', 0, 1],
  ['linkbold-whole', 'linkbold', 'inner', 0, 0], ['linkbold-l1', 'linkbold', 'inner', -1, 0],
  ['bi-whole', 'bi', 'both', 0, 0], ['bi-r1', 'bi', 'both', 0, 1],
  ['heading-whole', 'heading', 'Heading words', 0, 0],
  ['item-whole', 'item', 'second item', 0, 0], ['item-cross', 'item', 'item', 0, 2],
  ['nested-whole', 'nested', 'nested item', 0, 0],
  ['cell-whole', 'cell', 'cell two', 0, 0], ['cell-cross', 'cell', 'one', 0, 1],
  ['quote-whole', 'quote', 'quoted words here', 0, 0],
  ['para-whole', 'para', 'Whole paragraph text.', 0, 0],
  ['linkimg-word', 'linkimg', 'word', 0, 0],
  ['boldformula-ld', 'boldformula', 'ld', 0, 0], ['boldformula-bo', 'boldformula', 'bo', 0, 0],
];
const TEXTS = [['x', 'X'], ['xy', 'X Y'], ['md', '*s* `c`'], ['lines', 'L1\nL2'], ['paras', 'P1\n\nP2']];
const ONE_LINE = new Set(['x', 'xy', 'md']);

async function selectIn(page, needle, dl, dr) {
  return page.evaluate(({ needle, dl, dr }) => {
    const ed = document.querySelector('.mdr-preview .is-editing');
    if (!ed) return 'no session';
    const nodes = [];
    const tw = document.createTreeWalker(ed, 4, { acceptNode: (n) => (n.parentElement?.closest('.katex, [data-mdr-ui]') ? 2 : 1) });
    let all = '';
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    const i = all.indexOf(needle);
    if (i < 0) return 'needle not in session: ' + all;
    const at = (o, end) => {
      for (let k = 0; k < nodes.length; k++) {
        const [n, s] = nodes[k];
        if (o < s + n.data.length || (end && o === s + n.data.length) || k === nodes.length - 1) return [n, Math.max(0, Math.min(n.data.length, o - s))];
      }
      return null;
    };
    const a = at(i + dl, false), b = at(i + needle.length + dr, true);
    getSelection().setBaseAndExtent(a[0], a[1], b[0], b[1]);
    return getSelection().toString();
  }, { needle, dl, dr });
}
const visible = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => {
  const c = s.cloneNode(true); for (const k of c.querySelectorAll('.katex-mathml, [data-mdr-ui]')) k.remove(); return c.textContent;
}).join(' ').replace(/\s+/g, ' ').trim());
const dkOf = (doc) => Object.keys(DOCS).find((k) => DOCS[k] === doc);
const BAD_PAIRS = ['[](', '****', '~~~~', '``', '**  **', '__'];

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const run = async (doc, needle, dl, dr, text, how) => {
    await prepare(A, doc);
    await clickText(A.page, CLICK[dkOf(doc)], 1);
    await sleep(350);
    const selText = await selectIn(A.page, needle, dl, dr);
    await sleep(60);
    const beforeVis = await visible(A.page);
    if (how === 'type') await A.page.keyboard.type(text);
    else { await A.page.evaluate((t) => navigator.clipboard.writeText(t), text); await A.page.keyboard.press('Meta+v'); }
    await sleep(500);
    const emp = await emptyInline(A.page);
    const liveZw = (await domZw(A.page)).filter((z) => z.editing && !z.beforeAtom);
    const live = await sessionOn(A.page);
    let undoSrc = null;
    if (how === 'paste') {
      await A.page.keyboard.press('Meta+z'); await sleep(450); await A.settle(150);
      undoSrc = await A.source();
      await A.page.keyboard.press('Meta+Shift+z'); await sleep(450);
    }
    await A.page.keyboard.press('Escape'); await A.settle(250);
    const src = await A.source();
    const vis = await visible(A.page);
    return { selText, beforeVis, emp, live, undoSrc, src, vis, liveZw };
  };
  for (const [name, dk, needle, dl, dr] of SEL) {
    for (const [tk, text] of TEXTS) {
      const nm = `${name}-${tk}`;
      if (filter && !nm.includes(filter)) continue;
      if ((caseNo++ % SN) !== SH) continue;
      const doc = DOCS[dk];
      try {
        const p = await run(doc, needle, dl, dr, text, 'paste');
        let t = null;
        if (ONE_LINE.has(tk)) t = await run(doc, needle, dl, dr, text, 'type');
        const probs = [];
        if (typeof p.selText !== 'string' || p.selText.startsWith('no session') || p.selText.startsWith('needle')) probs.push('setup:' + p.selText);
        if (t && t.src !== p.src) probs.push('paste!=type');
        if (p.emp.length) probs.push('emptyInline:' + J(p.emp));
        if (p.liveZw.length) probs.push('liveZw:' + J(p.liveZw));
        for (const bp of BAD_PAIRS) if (p.src.includes(bp) && !doc.includes(bp)) probs.push('wrote ' + bp);
        const ix = invisibleExtra(p.src, doc + text);
        if (!none(ix)) probs.push('invisible:' + J(ix));
        if (p.undoSrc !== doc) probs.push('undo!=orig');
        const want = p.beforeVis.replace(p.selText.replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ')).replace(/\s+/g, ' ').trim();
        if (p.vis.replace(/ /g, '') !== want.replace(/ /g, '')) probs.push('visible');
        check(nm, probs.length === 0, `${probs.join(',')} sel=${show(p.selText)} pasted=${show(p.src)}${t ? ` typed=${show(t.src)}` : ''} undo=${show(p.undoSrc)}${probs.includes('visible') ? ` vis=${J(p.vis)} want=${J(want)}` : ''}`);
      } catch (e) { check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
