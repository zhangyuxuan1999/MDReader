// bench/verify/r4-int-metak.mjs — integrate (round 4): v5-offd-matrix large/preview/ks-Meta+k differs from 0.1.1
// (switch off). Same gesture on both builds through v5-offd-lib (switch stored "0" on the candidate): large.md in
// preview mode, the matrix's deep place, a double-click selection, then a key; prints scroll, focus, source change
// and toasts after the key. MDR_PORT=<cand> MDR_BASE_PORT=<0.1.1> node bench/verify/r4-int-metak.mjs [key] [doc] [mode]
import * as L from './v5-offd-lib.mjs';

const key = process.argv[2] || 'Meta+k';
const WORD = JSON.parse(process.env.R4INT_WORD || '{"inCss":"p","o":3}');
const doc = process.argv[3] || 'large';
const mode = process.argv[4] || 'preview';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const st = (S) => S.page.evaluate(() => {
  const ed = document.querySelector('.cm-scroller'); const pv = document.querySelector('.mdr-preview');
  const a = document.activeElement;
  return { edTop: ed ? Math.round(ed.scrollTop) : null, pvTop: pv ? Math.round(pv.scrollTop) : null, active: a ? a.tagName + '.' + (a.className || '').toString().slice(0, 30) : null,
    sel: String(getSelection()).slice(0, 30), version: window.__mdr.version() };
});
const P = await L.openPair();
if (doc === 'large') await L.setupDeep(P);
try {
  const out = {};
  for (const [nm, S] of [['cand', P.cand], ['base', P.base]]) {
    await L.reset(S, doc, mode, { fresh: true });
    const steps = [['click', WORD, { count: 2 }], ['key', key]];
    const before = await st(S);
    if (process.env.R4INT_PRE === 'none') steps.shift();
    const r = [];
    await L.step(S, steps[0]).catch((e) => r.push('ERR ' + e.message));
    const mid = await st(S);
    await L.step(S, steps[1]).catch((e) => r.push('ERR ' + e.message));
    await L.sleep(1200);
    out[nm] = { before, mid, after: await st(S), r };
  }
  console.log(JSON.stringify(out, null, 1));
} finally {
  clearTimeout(killer);
  await L.closeAll();
  process.exit(0);
}
