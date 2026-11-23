// bench/verify/v5-chb-sel.mjs — challenge-b (round 4): variations of J5 / P-E (the text copied after a released block's
// re-render is byte-identical to 0.1.1's for the same gesture). A click starts a session in block A; a Shift-click (or a
// drag) into another block ends it, the block re-renders, then ⌘C. End points at the start of an item, a nested item,
// a quote line (lazy and explicit), a table cell, a heading, a code line, after an image / a formula / a footnote
// reference / a hard break / an entity, the end of a line; both directions. The same steps on the 0.1.1 baseline.
// Run: MDR_PORT=5486 MDR_BASE_PORT=5496 node bench/verify/v5-chb-sel.mjs [case-prefix ...]   (baseline: vite preview of
//   release/baseline-0.1.1.noindex/dist, opened with ?perf=1). Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chb/lib';
const { sleep, globalTimeout, J, check, summary, openAt, runSteps, copied, prepare, requireServer } = await import('./v4-sesb-lib.mjs');

const only = process.argv.slice(2);
const CP = Number(process.env.MDR_PORT || 5486), BP = Number(process.env.MDR_BASE_PORT || 5496);
await requireServer(CP); await requireServer(BP, true);
const C0 = await openAt(CP), B0 = await openAt(BP, true);
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await C0.close(); await B0.close(); });

const DOC = [
  '# Heading text here', '',
  'Para one with ![img](data:image/gif;base64,R0lGODlhAQABAAAAACw=) image and $x^2$ math and note[^1] here.', '',
  'Line a  ', 'line b after break &amp; entity', '',
  '- item one', '- item two', '  - nested three', '- item four', '',
  '> quote line one', 'lazy line two', '>', '> quote para two', '',
  '| h1 | h2 |', '| --- | --- |', '| cell one | cell two |', '| cell three | cell four |', '',
  '```', 'code line one', 'code line two', '```', '',
  'Last para words.', '',
  '[^1]: The note.', '',
].join('\n');
const C = [];
const def = (name, steps) => C.push([name, steps]);
// a session in the first block named, a Shift-click into the second point
const pairs = [
  ['item-two-start-fwd', ['item two', 2], ['item two', 0, 'left'], ['cell one', 2]],
  ['item-two-start-bwd', ['item two', 2], ['item two', 0, 'left'], ['Heading', 2]],
  ['nested-start-fwd', ['nested three', 3], ['nested three', 0, 'left'], ['Last para', 2]],
  ['item-four-start-bwd', ['item four', 3], ['item four', 0, 'left'], ['Para one', 3]],
  ['lazy-start-fwd', ['lazy line', 3], ['lazy line', 0, 'left'], ['cell two', 2]],
  ['quote2-start-bwd', ['quote para two', 3], ['quote para two', 0, 'left'], ['item one', 2]],
  ['cell-start-fwd', ['cell three', 3], ['cell three', 0, 'left'], ['Last para', 3]],
  ['cell-start-bwd', ['cell four', 3], ['cell four', 0, 'left'], ['quote line one', 3]],
  ['heading-start-fwd', ['Heading', 3], ['Heading', 0, 'left'], ['item two', 3]],
  ['code-line2-start-bwd', ['code line two', 3], ['code line two', 0, 'left'], ['cell one', 3]],
  ['after-break-start-fwd', ['line b', 3], ['line b', 0, 'left'], ['item one', 3]],
  ['entity-after-fwd', ['entity', 2], ['entity', 0, 'left'], ['nested three', 3]],
  ['line-end-fwd', ['item two', 2], ['item two', 7, 'right'], ['Last para', 2]],
  ['image-after-fwd', ['image and', 3], ['image and', 0, 'left'], ['line b', 3]],
  ['math-after-bwd', ['and note', 3], ['and note', 0, 'left'], ['Heading', 3]],
  ['note-after-fwd', ['here.', 3], ['here.', 0, 'left'], ['item one', 3]],
];
for (const [name, start, anchor, other] of pairs) {
  // click at the anchor point itself (the session's caret there), then Shift-click elsewhere
  def(name, [['click', start], ['click', anchor], ['shift', other, { after: 900 }]]);
}
// typed: a session at `at`, keys typed there, then a Shift-click at `other`; the baseline loads the candidate's final
// source and does click `baseAt` + the same Shift-click (the 0.1.1 gesture for the same end points)
const typed = [
  ['typed-item-start', ['item two', 0, 'left'], 'XY', ['cell one', 2], ['XYitem two', 2, 'left']],
  ['typed-item-start-bwd', ['item two', 0, 'left'], 'XY', ['Heading', 2], ['XYitem two', 2, 'left']],
  ['typed-cell-start', ['cell three', 0, 'left'], 'Q', ['Last para', 3], ['Qcell three', 1, 'left']],
  ['typed-quote-start', ['quote para two', 0, 'left'], 'Q', ['cell one', 3], ['Qquote para two', 1, 'left']],
  ['typed-double-space', ['item two', 7, 'right'], '  b', ['cell one', 2], ['item two b', 9, 'right']],
  ['typed-trailing-space', ['item two', 7, 'right'], ' ', ['cell one', 2], ['item two', 7, 'right']],
  ['typed-star', ['item two', 4, 'right'], '*', ['cell one', 2], ['item* two', 4, 'right']],
  ['typed-amp', ['entity', 5, 'right'], '&', ['item one', 3], ['entity&', 6, 'right']],
  ['typed-before-math', ['math and', 0, 'left'], 'Z', ['Heading', 3], ['Zmath and', 1, 'left']],
];
let bad = 0;
try {
  for (const [name, at, text, other, baseAt] of typed) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    try {
      await prepare(C0, DOC);
      await runSteps(C0.page, [['click', [at[0], Math.min(2, at[0].length - 1)]], ['click', at], ['type', text, { after: 120 }], ['shift', other, { after: 900 }]]);
      await C0.settle(400);
      const ca = await copied(C0.page);
      const fin = await C0.source();
      await prepare(B0, fin);
      await runSteps(B0.page, [['click', baseAt], ['shift', other, { after: 600 }]], { baseline: true });
      const ba = await copied(B0.page);
      if (!check(name, ca === ba, `cand=${J(ca.slice(0, 100))} base=${J(ba.slice(0, 100))} src=${J(fin.split('\n').find((l) => l.includes(text.trim() || 'item two')) ?? '')}`)) bad++;
      await C0.page.keyboard.press('Escape');
    } catch (err) { check(name, false, 'error ' + (err && err.message)); bad++; }
  }
  for (const [name, steps] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    try {
      await prepare(C0, DOC); await prepare(B0, DOC);
      await runSteps(C0.page, steps); await runSteps(B0.page, steps, { baseline: true });
      await C0.settle(400);
      const ca = await copied(C0.page), ba = await copied(B0.page);
      const src = await C0.source();
      const ok = ca === ba && src === DOC;
      if (!check(name, ok, `cand=${J(ca.slice(0, 120))} base=${J(ba.slice(0, 120))}${src !== DOC ? ' SOURCE CHANGED' : ''}`)) bad++;
      await C0.page.keyboard.press('Escape'); await B0.page.keyboard.press('Escape');
    } catch (err) { check(name, false, 'error ' + (err && err.message)); bad++; }
  }
} finally {
  summary();
  clearTimeout(stop);
  await C0.close(); await B0.close();
}
process.exit(bad ? 1 : 0);
