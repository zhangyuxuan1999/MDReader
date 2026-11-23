// bench/verify/v5-chc-ringmem.mjs — challenge-c: memory of the editor's step ring (fix-session-f A1: the last 4096
// doc-changing updates, each keeping the document before it). A document with ONE long line (a paragraph of <kb> KB),
// then <n> single-character insertions into the middle of that line, each its own transaction and frame-separated in
// batches (so CodeMirror draws the line, as when a person types), then a forced GC through CDP and the JS heap size.
// Candidate against 0.1.1 (which has no ring), same gestures.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-ringmem.mjs cand [kb] [n]  |  MDR_BASE_PORT=5497 ... base [kb] [n]
import { openPage, load, sleep, J } from './v5-chc-lib.mjs';
const target = process.argv[2] || 'cand';
const KB = Number(process.argv[3] || 300);
const N = Number(process.argv[4] || 2000);
const killer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 110000);
const { browser, page } = await openPage(target);
try {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await sleep(200); await cdp.send('HeapProfiler.collectGarbage'); const m = await cdp.send('Runtime.getHeapUsage'); return Math.round(m.usedSize / 1048576); };
  const doc = 'Title\n\n' + 'word '.repeat(Math.round(KB * 1024 / 5)) + '\n\nend\n';
  await load(page, doc);
  await sleep(500);
  const h0 = await heap();
  const t0 = Date.now();
  for (let done = 0; done < N; done += 50) {
    await page.evaluate((k) => {
      const v = window.__mdr.app.editor.view;
      for (let i = 0; i < k; i++) { const l = v.state.doc.line(3); v.dispatch({ changes: { from: l.from + Math.floor(l.length / 2), insert: 'x' }, userEvent: 'input.type' }); }
    }, Math.min(50, N - done));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  const ms = Date.now() - t0;
  await sleep(500);
  const h1 = await heap();
  console.log(J({ target, kb: KB, edits: N, heapBeforeMB: h0, heapAfterMB: h1, growthMB: h1 - h0, ms }));
} finally { clearTimeout(killer); await browser.close(); }
