// Sanity: confirm the injected longtask/LoAF/monitor probes capture a synthetic 100 ms busy loop.
import { BASE, launch, readProbe, dumpErrors, sleep } from './common.mjs';
const { browser, page, errors } = await launch();
try {
  await page.goto(`${BASE}/?doc=/test-data/small.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await sleep(1500);
  await page.evaluate(() => { window.__probeMonitor(true); });
  await sleep(300);
  await page.evaluate(() => setTimeout(() => { const t = performance.now(); while (performance.now() - t < 100) {} }, 50));
  await sleep(1000);
  const p = await readProbe(page);
  console.log('longtasks:', p.longTasks.map(x => x.dur.toFixed(0)));
  console.log('loaf:', p.loaf.map(x => x.dur.toFixed(0)));
  console.log('gaps>20:', p.gaps.filter(g => g.gap > 20).map(g => g.gap.toFixed(0)));
  console.log('gaps count', p.gaps.length, 'sum', p.gaps.reduce((a,b)=>a+b.gap,0).toFixed(0));
} finally { dumpErrors(errors); await browser.close(); }
