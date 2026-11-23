// bench/verify/r4-id-clip.mjs — fix-session-d (round 4, item 4: J2 / P-A). A copy whose selection holds NO helper
// character of a session is left to the browser: both clipboard flavours (text/plain and text/html) must be byte-identical
// to what the 0.1.1 renderer copies for the same gesture. Five ordinary selections (a double-clicked word, a
// triple-clicked list item, a drag inside a paragraph, a drag across blocks, a double-clicked word in a table cell), plus
// two selections that DO hold a helper (⌘A / Shift+End in a paragraph that starts with a formula): there the candidate's
// clipboard must hold no U+200B (0.1.1 has no session, so no same gesture: its drag over the same text is printed).
// The text/html of a copy depends on the build's style sheets: it is compared only with MDR_HTML=1, for two production
// builds (vite preview of both); against the dev server it is printed.
// Run (candidate and the 0.1.1 baseline up): MDR_PORT=5466 MDR_BASE_PORT=5476 node bench/verify/r4-id-clip.mjs [filter]
// Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, prepare, requireServer, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5466), BP = Number(process.env.MDR_BASE_PORT || 5476);
await requireServer(CP); await requireServer(BP, true);
const ZW = String.fromCharCode(0x200b);
const DOC = 'Lead para with several words here.\n\n- first item text\n- second item text\n\n| head a | head b |\n| --- | --- |\n| cell one | cell two |\n\nLast para words.\n';
const FDOC = '$x^2$ starts this para here\n\nnext para words\n';
// [name, doc, candidate steps, baseline steps, helper case]
const C = [
  ['dblclick-word', DOC, [['click', ['several', 2], { clickCount: 2, after: 400 }]], null, false],
  ['tripleclick-item', DOC, [['click', ['second item', 3], { clickCount: 3, after: 400 }]], null, false],
  ['drag-in-para', DOC, [['drag', ['with', 0], ['words here', 4], { steps: 8 }]], null, false],
  ['drag-across', DOC, [['drag', ['several', 0], ['first item', 5], { steps: 10 }]], null, false],
  ['dblclick-cell', DOC, [['click', ['cell one', 6], { clickCount: 2, after: 400 }]], null, false],
  ['helper-selall', FDOC, [['click', ['starts', 2]], ['key', 'Meta+a', { after: 200 }]], [['drag', { css: '.md-math', fx: 0.02 }, ['para here', 8, 'right']]], true],
  ['helper-shift-end', FDOC, [['click', ['starts', 2]], ['key', 'Home', { after: 120 }], ['key', 'Shift+End', { after: 200 }]], [['drag', { css: '.md-math', fx: 0.02 }, ['para here', 8, 'right']]], true],
];
const clip = (page) => page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  const r = {};
  for (const it of items) for (const ty of it.types) r[ty] = await (await it.getType(ty)).text();
  return { plain: r['text/plain'] ?? null, html: r['text/html'] ?? null };
});
async function copyOf(B, steps, baseline) {
  await B.page.evaluate(() => navigator.clipboard.writeText('<<none>>'));
  await runSteps(B.page, steps, { baseline });
  await B.page.keyboard.press('Meta+c');
  await sleep(200);
  return clip(B.page);
}
let A = null, Bs = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); await Bs?.close(); });
try {
  A = await openAt(CP, false);
  Bs = await openAt(BP, true);
  for (const [name, doc, cs, bs, helper] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await prepare(A, doc);
      const ca = await copyOf(A, cs, false);
      const session = await A.page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
      await A.page.keyboard.press('Escape'); await A.settle(150);
      await prepare(Bs, doc);
      const cb = await copyOf(Bs, bs ?? cs, true);
      const zw = (ca.plain ?? '').includes(ZW) || (ca.html ?? '').includes(ZW);
      // (a helper case has no same gesture in 0.1.1, which has no session: ⌘A in a block is the candidate's; only the
      // absence of a helper is required there, the comparison is printed)
      // text/html only with MDR_HTML=1 (both sides production builds: the dev server's style sheets differ)
      const ok = helper ? !zw : ca.plain === cb.plain && (!process.env.MDR_HTML || ca.html === cb.html);
      check(name, ok, `session=${session} plainSame=${ca.plain === cb.plain} htmlSame=${ca.html === cb.html} zw=${zw} cand=${J((ca.plain ?? '').slice(0, 40))} base=${J((cb.plain ?? '').slice(0, 40))}${ca.html !== cb.html ? ` candHtml=${J((ca.html ?? '').slice(0, 160))} baseHtml=${J((cb.html ?? '').slice(0, 160))}` : ''}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); await Bs?.close(); }
process.exitCode = results.fail ? 1 : 0;
