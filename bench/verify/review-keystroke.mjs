// bench/verify/review-keystroke.mjs — sanity check of the SPEC §11 P5 budget from the static-review
// lens: main-thread work per keystroke while typing mid-document in large.md (target p95 < 5 ms,
// max < 10 ms at 1x CPU) plus the long-animation-frame blocking time during the burst.
// Run: node bench/verify/review-keystroke.mjs   (own dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep, pct, r1 } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const { browser, page, errors } = await openPage();
await gotoApp(page, 'mode=split');
await page.evaluate((d) => window.__mdr.loadUrl(`/test-data/${d}`), DOC);
await waitIdle(page, 180000);
await sleep(800);

// put the cursor in the middle of the document
await page.evaluate(() => {
  const v = window.__mdr.app.editor.view;
  const mid = Math.floor(v.state.doc.lines / 2);
  window.__mdr.app.editor.gotoLine(mid, 0);
});
await sleep(400);
await waitIdle(page, 60000);

await page.evaluate(() => {
  window.__ks = [];
  window.__loaf = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__loaf.push({ dur: e.duration, block: e.blockingDuration }); })
      .observe({ type: 'long-animation-frame' });
  } catch {}
  const v = window.__mdr.app.editor.view;
  window.__typeOne = (ch) => {
    const t0 = performance.now();
    v.dispatch({ changes: { from: v.state.selection.main.head, insert: ch }, selection: { anchor: v.state.selection.main.head + ch.length }, userEvent: 'input.type' });
    v.measure();  // force CodeMirror's DOM sync inside the measurement, as a real keystroke would
    window.__ks.push(performance.now() - t0);
  };
});

const TEXT = '性能测试performance中文abc 段落 test '.repeat(6).slice(0, 200);
for (const ch of TEXT) {
  await page.evaluate((c) => window.__typeOne(c), ch);
  await sleep(16);   // ~60 wpm-ish burst
}
await sleep(600);

const r = await page.evaluate(() => ({ ks: window.__ks.slice(), loaf: window.__loaf.slice() }));
const p95 = pct(r.ks, 0.95);
const max = Math.max(...r.ks);
const loafBlock = r.loaf.map((l) => l.block);
console.log(`doc=${DOC} keystrokes=${r.ks.length}`);
console.log(`  view.dispatch+measure  p50=${r1(pct(r.ks, 0.5))}ms  p95=${r1(p95)}ms  max=${r1(max)}ms   (target p95 < 5, max < 10)`);
console.log(`  long-animation-frames  n=${r.loaf.length}  maxBlocking=${r1(Math.max(0, ...loafBlock))}ms`);
console.log('errors:', errors.slice(0, 5));
console.log('__RESULT__' + JSON.stringify({ doc: DOC, p50: pct(r.ks, 0.5), p95, max, loaf: r.loaf.length, maxBlocking: Math.max(0, ...loafBlock) }));
await browser.close();
