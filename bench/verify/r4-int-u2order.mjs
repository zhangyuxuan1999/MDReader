// bench/verify/r4-int-u2order.mjs — integrate (round 4): why v5-chc-u2's toolbar-far differs only after
// preview-mode-redo ran first. Runs the steps of preview-mode-redo (optionally on one build only), then the reset of
// toolbar-far and its step 0 (scrollEd 0.7), and prints for both builds the editor and preview scroll state and the
// block observation. Needs the candidate on MDR_PORT and 0.1.1 on MDR_BASE_PORT. Writes nothing into the tree.
//   MDR_PORT=5470 MDR_BASE_PORT=5471 node bench/verify/r4-int-u2order.mjs [both|cand|none]
import * as L from './v5-offd-lib.mjs';

const which = process.argv[2] || 'both';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const text = { inCss: 'p', o: 3 };
const ed3 = { edLine: 3, endOfLine: true };
const REDO = [['scrollEd', 0.9], ['edit', { at: ed3, text: ' F' }], ['key', 'Meta+z'], ['mode', 'preview'], ['scrollPv', 0], ['click', text], ['key', 'Meta+Shift+z']];
const state = (S) => S.page.evaluate(() => {
  const ed = document.querySelector('.cm-scroller'); const pv = document.querySelector('.mdr-preview');
  return { edTop: ed && Math.round(ed.scrollTop), edH: ed && ed.scrollHeight, pvTop: pv && Math.round(pv.scrollTop), pvH: pv && pv.scrollHeight, mode: document.documentElement.dataset.mode || null };
});
const P = await L.openPair();
try {
  const sides = which === 'both' ? [P.cand, P.base] : which === 'cand' ? [P.cand] : [];
  await Promise.all([L.reset(P.cand, 'large', 'split', { fresh: true }), L.reset(P.base, 'large', 'split', { fresh: true })]);
  for (const st of REDO) await Promise.all(sides.map((S) => L.step(S, st).catch((e) => 'ERR ' + e.message)));
  await Promise.all([L.reset(P.cand, 'large', 'split', { fresh: true }), L.reset(P.base, 'large', 'split', { fresh: true })]);
  console.log('after reset', JSON.stringify({ cand: await state(P.cand), base: await state(P.base) }));
  await Promise.all([L.step(P.cand, ['scrollEd', 0.7]), L.step(P.base, ['scrollEd', 0.7])]);
  console.log('after scrollEd', JSON.stringify({ cand: await state(P.cand), base: await state(P.base) }));
  const [c, b] = await Promise.all([L.obs(P.cand), L.obs(P.base)]);
  const d = L.diff(c, b, { ignore: ['ev', 'pts'], tol: 2 });
  console.log('diff', d.length ? L.fmtDiff(d).slice(0, 600) : 'SAME');
  await L.sleep(3000);
  const [c2, b2] = await Promise.all([L.obs(P.cand), L.obs(P.base)]);
  const d2 = L.diff(c2, b2, { ignore: ['ev', 'pts'], tol: 2 });
  console.log('diff after 3 s', d2.length ? L.fmtDiff(d2).slice(0, 600) : 'SAME', JSON.stringify({ cand: await state(P.cand), base: await state(P.base) }));
} finally {
  clearTimeout(killer);
  await L.closeAll();
  process.exit(0);
}
