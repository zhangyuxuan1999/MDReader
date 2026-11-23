// bench/verify/v4-sesb-esc.mjs — verify-session-b: U20 after Esc. A session in block P (optionally with typing), Esc,
// then after a delay (0 / 120 / 600 ms) a click at the start, in the middle or at the end of P or of a neighbour, then
// 'Q' typed (or "zz" pasted). Expected: the text lands exactly at the clicked character position of the source (a
// model: the needle's index in the source + k, or + k + 1 for a click on the right half of the last character).
// Run (candidate server up on MDR_PORT, default 5432): node bench/verify/v4-sesb-esc.mjs [name-filter]
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, prepare, requireServer, view, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const DOC = [
  '# Head title here', '',
  'Alpha para one text.', '',
  'Beta para **two** text.', '',
  '- list item one', '- list item two', '',
  '> quote para text', '',
  '| ca | cb |', '| --- | --- |', '| cell xx | cell yy |', '',
  'Omega para end.', '',
].join('\n');
// [label, session needle, target needle, k, side]
const TARGETS = [
  ['same-start', 'Beta para', 'Beta para', 0, 'left'],
  ['same-mid', 'Beta para', 'para', 2, 'left'],
  ['same-end', 'Beta para', ' text.', 5, 'right'],
  ['prev-start', 'Beta para', 'Alpha para', 0, 'left'],
  ['prev-end', 'Beta para', 'one text.', 8, 'right'],
  ['next-item2-start', 'Beta para', 'list item two', 0, 'left'],
  ['item-same-start', 'list item two', 'list item two', 0, 'left'],
  ['item-other-start', 'list item two', 'list item one', 0, 'left'],
  ['item-end', 'list item one', 'item one', 7, 'right'],
  ['head-start', 'Head title', 'Head title', 0, 'left'],
  ['quote-start', 'quote para', 'quote para', 0, 'left'],
  ['cell-start', 'cell yy', 'cell yy', 0, 'left'],
  ['cell-other-start', 'cell yy', 'cell xx', 0, 'left'],
  ['omega-start-from-cell', 'cell yy', 'Omega', 0, 'left'],
];
const C = [];
for (const [label, sess, tgt, k, side] of TARGETS) {
  for (const delay of [0, 120, 600]) {
    for (const how of ['type', 'paste']) {
      C.push({ name: `${label}-${delay}-${how}`, sess, tgt, k, side, delay, how });
    }
  }
}
function expectFor(src, tgt, k, side, ins) {
  const i = src.indexOf(tgt);
  if (i < 0) return null;
  const at = i + k + (side === 'right' ? 1 : 0);
  return src.slice(0, at) + ins + src.slice(at);
}
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const c of C) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await prepare(A, DOC);
      await runSteps(page, [['click', [c.sess, 3]], ['type', 'w', { after: 200 }], ['key', 'Backspace', { after: 250 }], ['key', 'Escape', { after: c.delay }], ['click', [c.tgt, c.k, c.side], { after: 350 }]]);
      const ins = c.how === 'type' ? 'Q' : 'zz';
      if (c.how === 'type') await page.keyboard.type('Q');
      else { await page.evaluate(() => navigator.clipboard.writeText('zz')); await page.keyboard.press('Meta+v'); }
      await sleep(300);
      const v = await view(page);
      await page.keyboard.press('Escape'); await A.settle(150);
      const src = await A.source();
      const exp = expectFor(DOC, c.tgt, c.k, c.side, ins);
      check(c.name, src === exp, src === exp ? '' : `src=${J(src)} exp=${J(exp)} session=${!!v.editing} caret=${v.caret}`);
    } catch (e) { check(c.name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
  if (A.pageErrors.length) console.log('page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
