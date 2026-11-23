// bench/verify/review-paste.mjs — paste medium.md (20k lines) into the MIDDLE of large.md: the preview's
// middle-insertion path creates every new wrapper synchronously (createPreview.insertWrappers), unlike
// the sliced initial creation. Measures the longest main-thread task caused. Run: node bench/verify/review-paste.mjs
import { readFileSync } from 'node:fs';
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, sleep, r1, report } from './review-lib.mjs';

const { browser, page, errors } = await openPage();
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, 'large.md');
  await waitIdle(page);
  await installMonitor(page);
  const text = readFileSync(new URL('../../test-data/medium.md', import.meta.url), 'utf8');
  const mid = await page.evaluate(() => { const ed = window.__mdr.app.editor; const l = Math.floor(ed.lineCount() / 2); ed.gotoLine(l, 0); return l; });
  await sleep(800);
  await resetMonitor(page);
  const t0 = Date.now();
  // insert via a CM transaction (same path as paste: one transaction, one edit message)
  await page.evaluate((t) => {
    const v = window.__mdr.app.editor.view;
    const pos = v.state.selection.main.head;
    v.dispatch({ changes: { from: pos, insert: t + '\n' }, userEvent: 'input.paste' });
  }, text);
  await sleep(1500);
  await waitIdle(page);
  const mon = await readMonitor(page);
  const blocks = await page.evaluate(() => window.__mdr.app.preview.blockCount());
  const longest = mon.longtasks.reduce((a, t) => Math.max(a, t.dur), 0);
  const loafMax = mon.loaf.reduce((a, t) => Math.max(a, t.dur), 0);
  report('review-paste medium.md into middle of large.md', [
    { name: 'longest main-thread task after mid-doc paste (longtask API)', value: `${r1(longest)} ms; all: ${JSON.stringify(mon.longtasks.map((t) => r1(t.dur)))}`, target: '< 120 ms (P4 "longest main task"), ideally sliced', pass: longest < 120 },
    { name: 'longest animation frame', value: `${r1(loafMax)} ms`, target: 'informational', pass: true },
    { name: 'blocks after paste', value: String(blocks), target: '> 30000', pass: blocks > 30000 },
    { name: 'wall time paste → idle', value: `${Date.now() - t0} ms`, target: 'informational', pass: true },
  ]);
  console.log(`cursor line ${mid}; errors:`, errors.length ? errors : 'none');
} finally {
  await browser.close();
}
