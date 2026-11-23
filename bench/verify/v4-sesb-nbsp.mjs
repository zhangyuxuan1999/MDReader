// bench/verify/v4-sesb-nbsp.mjs — verify-session-b: typing or pasting over a selection that joins two paragraphs of
// ONE block (a quote, a loose list item) writes `&nbsp;` where the source has a plain space: Chromium moves the second
// paragraph's text into a <span style="background-color: …"> (the focus-line tint differs between the two
// paragraphs) and respells the space that now follows the inserted text. Expected: what a text editor writes (the
// selection replaced, the space kept as a space), as U19 says for a paste ("no &nbsp;").
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-nbsp.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
// [name, doc, click needle, from-text, to-text (selection from the start of `from` to the end of `to`), expected after X]
const C = [
  ['quote-two-paras', '> quote one here\n>\n> quote two here\n\nLast.\n', 'quote one', 'one here', 'quote two', '> quote X here\n\nLast.\n'],
  ['quote-two-paras-mid', '> alpha beta gamma\n>\n> delta epsilon zeta\n\nLast.\n', 'alpha', 'beta', 'delta', '> alpha X epsilon zeta\n\nLast.\n'],
  ['loose-item-two-paras', '- item one here\n\n  item two here\n\nLast.\n', 'item one', 'one here', 'item two', '- item X here\n\nLast.\n'],
  ['quote-three-paras-across', '> p one a\n>\n> p two b\n>\n> p three c\n\nLast.\n', 'p one', 'one a', 'p three', '> p X c\n\nLast.\n'],
];
async function selectAcross(page, from, to) {
  return page.evaluate(({ from, to }) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const nodes = []; let all = '';
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    const i = all.indexOf(from), j = all.indexOf(to, i + from.length) + to.length;
    const at = (o, nx) => { for (const [n, b] of nodes) if (o < b + n.data.length || (o === b + n.data.length && !nx)) return [n, o - b]; return null; };
    const a = at(i, true), b = at(j, false);
    getSelection().setBaseAndExtent(a[0], a[1], b[0], b[1]);
    return getSelection().toString();
  }, { from, to });
}
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, doc, click, from, to, exp] of C) {
    for (const how of ['type', 'paste']) {
      const cname = `${name}-${how}`;
      if (filter && !new RegExp(filter).test(cname)) continue;
      try {
        await prepare(A, doc);
        const p = await pointOf(page, click, 2); await page.mouse.click(p.x, p.y); await sleep(350);
        if (!(await view(page)).editing) throw new Error('no session');
        const sel = await selectAcross(page, from, to);
        if (how === 'type') await page.keyboard.type('X');
        else { await page.evaluate(() => navigator.clipboard.writeText('X')); await page.keyboard.press('Meta+v'); }
        await sleep(400);
        const html = (await view(page)).editing?.html ?? '';
        await page.keyboard.press('Escape'); await A.settle(150);
        const src = await A.source();
        check(cname, src === exp, `sel=${J(sel)} src=${J(src)}${src === exp ? '' : ' exp=' + J(exp) + ' html=' + J(html.slice(0, 220))}`);
      } catch (e) { check(cname, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
