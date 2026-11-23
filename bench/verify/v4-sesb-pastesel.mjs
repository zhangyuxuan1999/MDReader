// bench/verify/v4-sesb-pastesel.mjs — verify-session-b: U19 / H14 variations. For every selection shape (a double-
// clicked word in several places and formats, a selection with a leading or trailing space, across bold and a link,
// a whole paragraph, across list items, across two paragraphs, in code, in a table cell) and several texts (one
// line, two words, two paragraphs), the source after PASTING over the selection must equal the source after TYPING
// the same text over the same selection (measured in the same run), and one ⌘Z must give the document back.
// Run (candidate server up on MDR_PORT, default 5432): node bench/verify/v4-sesb-pastesel.mjs [name-filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const FENCE = '`'.repeat(3);
const DOC = [
  'Some words here to replace now.', '',
  'Lead **bold words** tail and [link](https://e.x/y) end.', '',
  'Word `code span` more [one](https://e.x/z) rest.', '',
  '- item alpha one', '- item beta two', '',
  'para one here', '', 'para two here', '',
  '> quote one here', '>', '> quote two here', '',
  FENCE, 'code line one', 'code line two', FENCE, '',
  '| ha | hb |', '| --- | --- |', '| cell one | cell two |', '',
  'Last.', '',
].join('\n');
// [name, click needle, selection: {dbl:[needle,k]} | {triple:[needle,k]} | {js: text} ]
const SHAPES = [
  ['dbl-mid-word', 'Some words', { dbl: ['here', 1] }],
  ['dbl-first-word', 'Some words', { dbl: ['Some', 1] }],
  ['dbl-last-word', 'Some words', { dbl: ['now', 1] }],
  ['dbl-bold-word', 'Lead', { dbl: ['bold', 1] }],
  ['dbl-link-word', 'Lead', { dbl: ['link', 1] }],
  ['dbl-code-word', 'Word', { dbl: ['span', 1] }],
  ['dbl-one-word-link', 'Word', { dbl: ['one', 1] }],
  ['js-lead-space', 'Some words', { js: ' here' }],
  ['js-trail-space', 'Some words', { js: 'here ' }],
  ['js-both-spaces', 'Some words', { js: ' here ' }],
  ['js-across-bold', 'Lead', { js: 'old words tai' }],
  ['js-across-link', 'Lead', { js: 'and link en' }],
  ['js-whole-bold', 'Lead', { js: 'bold words' }],
  ['js-whole-link', 'Lead', { js: 'link' }],
  ['js-whole-para', 'Some words', { js: 'Some words here to replace now.' }],
  ['triple-para', 'Some words', { triple: ['here', 1] }],
  ['js-across-items', 'item alpha', { js: 'alpha one' + '|' + 'item beta' }],
  ['js-across-quote-paras', 'quote one', { js: 'one here' + '|' + 'quote two' }],
  ['js-in-code', 'code line', { js: 'line one' }],
  ['js-across-code-lines', 'code line', { js: 'one' + '|' + 'code line' }],
  ['js-in-cell', 'cell one', { js: 'one' }],
  ['js-whole-cell', 'cell one', { js: 'cell one' }],
];
const TEXTS = [['x', 'X'], ['xy', 'X Y'], ['paras', 'X\n\nY']];

async function makeSel(page, how) {
  if (how.dbl || how.triple) {
    const [needle, k] = how.dbl || how.triple;
    const p = await pointOf(page, needle, k);
    if (!p) throw new Error('not shown ' + needle);
    await page.mouse.move(p.x, p.y);
    const n = how.dbl ? 2 : 3;
    for (let c = 1; c <= n; c++) { await page.mouse.down({ clickCount: c }); await page.mouse.up({ clickCount: c }); }
    await sleep(250);
    return;
  }
  // js: a selection of the exact text inside the editing block (a '|' marks the join of two text runs: the
  // text between them is skipped — across element boundaries)
  await page.evaluate((spec) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    if (!el) throw new Error('no session');
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('[data-mdr-ui], .katex-mathml') ? 2 : 1) });
    const nodes = []; let all = '';
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { nodes.push([n, all.length]); all += n.data; }
    const at = (off, preferNext) => {
      for (let k = 0; k < nodes.length; k++) {
        const [n, base] = nodes[k];
        if (off < base + n.data.length || (off === base + n.data.length && !preferNext)) return [n, off - base];
      }
      const [n] = nodes[nodes.length - 1]; return [n, n.data.length];
    };
    let a, b;
    if (spec.includes('|')) {
      const [p, q] = spec.split('|');
      const i = all.indexOf(p); const j = all.indexOf(q, i + p.length);
      if (i < 0 || j < 0) throw new Error('js sel not found ' + spec);
      a = at(i, true); b = at(j + q.length, false);
    } else {
      const i = all.indexOf(spec);
      if (i < 0) throw new Error('js sel not found ' + spec);
      a = at(i, true); b = at(i + spec.length, false);
    }
    const s = getSelection(); s.setBaseAndExtent(a[0], a[1], b[0], b[1]);
  }, how.js);
  await sleep(120);
}
async function startSession(A, needle) {
  const p = await pointOf(A.page, needle, 2);
  if (!p) throw new Error('not shown ' + needle);
  await A.page.mouse.click(p.x, p.y);
  await sleep(350);
  const v = await view(A.page);
  if (!v.editing) throw new Error('no session on ' + needle);
}
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [name, click, how] of SHAPES) {
    for (const [tn, text] of TEXTS) {
      const cname = `${name}-${tn}`;
      if (filter && !cname.includes(filter)) continue;
      try {
        // typing
        await prepare(A, DOC);
        await startSession(A, click);
        await makeSel(page, how);
        const selT = await page.evaluate(() => getSelection().toString());
        await page.keyboard.type(text);
        await sleep(400);
        await page.keyboard.press('Escape'); await A.settle(150);
        const typed = await A.source();
        // paste
        await prepare(A, DOC);
        await startSession(A, click);
        await makeSel(page, how);
        const selP = await page.evaluate(() => getSelection().toString());
        await page.evaluate((t) => navigator.clipboard.writeText(t), text);
        await page.keyboard.press('Meta+v');
        await sleep(450);
        const pasted = await A.source();
        const v = await view(page);
        await page.keyboard.press('Meta+z');
        await sleep(450); await A.settle(150);
        const undone = await A.source();
        await page.keyboard.press('Escape'); await A.settle(100);
        // P-A (Stage-2d review decisions, J1): a paste over the WHOLE text of a link puts the pasted text INSIDE the link.
        // Typing does that for its first character only (Chrome types the next ones next to the link, at its edge), so
        // for a text of several characters the expectation is the whole text inside the link (fix-session-d, round 4).
        const wholeLink = ['dbl-link-word', 'dbl-one-word-link', 'js-whole-link'].includes(name) && tn === 'xy';
        const want = wholeLink ? typed.replace(/\[X\]\((https:[^)]*)\) Y/, '[X Y]($1)') : typed;
        const ok = pasted === want && undone === DOC && selT === selP;
        const d = (x) => { const i = [...x].findIndex((ch, k) => ch !== DOC[k]); return J(x.slice(Math.max(0, i - 12), i + 40)); };
        check(cname, ok, ok ? '' : `sel=${J(selP)}${selT !== selP ? ' selT=' + J(selT) : ''} typed=${d(typed)}${want !== typed ? ' want=' + d(want) : ''} pasted=${d(pasted)} undoOk=${undone === DOC} session=${!!v.editing}`);
      } catch (e) { check(cname, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
  if (A.pageErrors.length) console.log('page errors: ' + J(A.pageErrors.slice(0, 3)));
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
