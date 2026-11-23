// bench/verify/v5-ptr-pastemd.mjs — verify-session-pointer: a pasted text is TEXT. Pastes of Markdown- and HTML-active
// strings (one line, or as a later pasted paragraph) into a paragraph, a list item, a heading, a table cell and a quote;
// after Esc the preview must show the pasted characters literally (whitespace collapsed), every original word must
// still show, and the source holds no invisible character the document did not hold.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-pastemd.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, invisibleExtra, none, sessionOn, clickText } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const [SH, SN] = (process.env.SHARD || '0/1').split('/').map(Number);
const BS = String.fromCharCode(92);
const PAY = [
  '# not heading', '- not item', '1. not ordered', '> not quote', '[foo]: /url', '<b>bold</b>', '&amp; &copy; &#65;',
  BS + '* star', '`tick', '$5 and $6', '$x$', '*em* **b**', '[t](u)', '<http://a.b>', '| pipe |', '---', '===',
  '~~~', '```', 'end ' + BS, '<!-- c -->', '[^1]', '![i](x.png)', 'x<y>z', BS + '$', '$$', BS + BS, '__init__', 'a_b_c',
  '+ plus', '* star item', '2) paren', '<div>blk</div>', '[ ] box', '- [ ] task',
];
const MULTI = ['# H2', '- li', '[foo]: /url', '    code four', '---', '===', '<div>x</div>', '1. one', '> q', '| a |\n|---|'];
const DOCS = {
  para: ['Alpha first words here.\n\nBravo [foo] second.\n', 'first', 'Alpha first words here.'],
  item: ['- Item first words here\n- Other item\n\nBravo [foo] second.\n', 'first', 'Item first words here'],
  heading: ['## Head first words here\n\nBravo [foo] second.\n', 'first', 'Head first words here'],
  cell: ['| Cell first words here | k |\n|---|---|\n| v | w |\n\nBravo [foo] second.\n', 'first', 'Cell first words here'],
  quote: ['> Quote first words here.\n\nBravo [foo] second.\n', 'first', 'Quote first words here.'],
};
const visible = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => {
  const c = s.cloneNode(true); for (const k of c.querySelectorAll('.katex-mathml, [data-mdr-ui]')) k.remove();
  for (const i of c.querySelectorAll('img')) i.replaceWith('[IMG]'); for (const i of c.querySelectorAll('input')) i.replaceWith('[BOX]');
  return c.textContent;
}).join(' ').replace(/\s+/g, ' ').trim());
const norm = (s) => s.replace(/\s+/g, ' ').trim();
let A = null, n = 0;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const cases = [];
  for (const dk of Object.keys(DOCS)) {
    for (const [i, p] of PAY.entries()) cases.push([`${dk}-one${i}`, dk, ' ' + p + ' ', [p]]);
    if (dk === 'para' || dk === 'quote') for (const [i, m] of MULTI.entries()) cases.push([`${dk}-multi${i}`, dk, 'Pone\n\n' + m, ['Pone', m]]);
  }
  for (const [nm, dk, text, parts] of cases) {
    if (filter && !nm.includes(filter)) continue;
    if ((n++ % SN) !== SH) continue;
    const [doc, needle, orig] = DOCS[dk];
    try {
      await prepare(A, doc);
      await clickText(A.page, needle, 5, { side: 'right' }); await sleep(350);
      const live = await sessionOn(A.page);
      await A.page.evaluate((t) => navigator.clipboard.writeText(t), text);
      await A.page.keyboard.press('Meta+v');
      await sleep(700); await A.settle(150);
      await A.page.keyboard.press('Escape'); await A.settle(300);
      const src = await A.source();
      const vis = await visible(A.page);
      const probs = [];
      if (!live) probs.push('no session');
      for (const p of parts) if (!vis.includes(norm(p))) probs.push(`not shown ${J(p)}`);
      for (const w of orig.split(/\s+/)) if (!vis.includes(w.replace(/first/, 'fir'))) probs.push(`lost ${w}`);
      if (!vis.includes('Bravo [foo] second.')) probs.push('next block changed');
      const ix = invisibleExtra(src, doc);
      if (!none(ix)) probs.push('invisible ' + J(ix));
      check(nm, probs.length === 0, `${probs.join(',')} pasted=${J(text)} src=${show(src)}${probs.length ? ` vis=${J(vis)}` : ''}`);
    } catch (e) { check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
