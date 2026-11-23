// bench/verify/review-open.mjs — P1/P3/P4 on large.md and huge.md: mdr:open→first-visible, →idle, longest
// task, long tasks after t = 1 s. Run: node bench/verify/review-open.mjs
import { openPage, gotoApp, installMonitor, readMonitor, marks, sleep, r1, report } from './review-lib.mjs';

for (const DOC of (process.env.DOCS || 'large.md,huge.md').split(',')) {
  const { browser, page, errors } = await openPage();
  try {
    await gotoApp(page, 'mode=split');
    await installMonitor(page);
    await page.evaluate((n) => { window.__mdr.loadUrl(`/test-data/${n}`); }, DOC);
    await page.waitForFunction(() => performance.getEntriesByName('mdr:open').length > 1 || performance.getEntriesByName('mdr:first-visible').length > 1, null, { timeout: 60000 }).catch(() => {});
    await page.evaluate(() => window.__mdr.waitIdle(), null, { timeout: 180000 });
    await sleep(500);
    const mk = await marks(page);
    const mon = await readMonitor(page);
    const open = mk['mdr:open'].at(-1);
    const fv = (mk['mdr:first-visible'] || []).filter((t) => t >= open)[0];
    const idle = (mk['mdr:idle'] || []).filter((t) => t >= open).at(-1);
    const structure = (mk['mdr:structure'] || []).filter((t) => t >= open)[0];
    const lt = mon.longtasks.filter((t) => t.start >= open);
    const longest = lt.reduce((a, t) => Math.max(a, t.dur), 0);
    const after1s = lt.filter((t) => t.start > open + 1000);
    report(`review-open ${DOC}`, [
      { name: 'open → structure', value: `${r1(structure - open)} ms`, target: 'informational', pass: true },
      { name: 'open → first-visible (P1)', value: `${r1(fv - open)} ms`, target: '< 400 ms', pass: fv - open < 400 },
      { name: 'open → idle (P3)', value: `${r1(idle - open)} ms`, target: '< 20 s', pass: idle - open < 20000 },
      { name: 'longest main task after open (P4)', value: `${r1(longest)} ms; all: ${JSON.stringify(lt.map((t) => r1(t.dur)))}`, target: '< 120 ms', pass: longest < 120 },
      { name: 'long tasks > 50 ms after t = 1 s (P4)', value: `${after1s.length} ${JSON.stringify(after1s.map((t) => `${r1(t.start - open)}@${r1(t.dur)}`))}`, target: '0', pass: after1s.length === 0 },
    ]);
    console.log('errors:', errors.length ? errors : 'none');
  } finally {
    await browser.close();
  }
}
