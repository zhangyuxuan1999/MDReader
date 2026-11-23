// bench/verify/v4-app-perf.mjs — verify-app (0.2.0 stage 2d): suspected cost of round 3's joinsAbove() (U18 (c)),
// which reads and re-segments the WHOLE block directly above a session block on every write when the line above
// is not blank. Types 30 characters into a heading session that sits directly under a fenced code block of
// N lines (no blank line between) and, as a control, under the same fence with a blank line between.
// Prints the mean main-thread time per write (ms) measured around replaceSource via performance marks is not
// available, so it prints the wall time from the first key to the source holding all 30 characters.
//   MDR_PORT=5436 node bench/verify/v4-app-perf.mjs [lines=40000]
// Indicative only (machine loaded). Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const N = Number(process.argv[2]) || 40000;
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const fence = ['```', ...Array.from({ length: N }, (_, i) => `code line ${i} with some text`), '```'].join('\n');
try {
  await B.boot('mode=split');
  for (const [name, doc] of [['tight', `${fence}\n## 标题文字\n\n尾段。\n`], ['blank', `${fence}\n\n## 标题文字\n\n尾段。\n`]]) {
    await page.keyboard.press('Escape');
    await B.loadDoc(doc);
    const line = doc.split('\n').findIndex((l) => l.startsWith('## ')) + 1;
    await B.mountLine(line); await sleep(800);
    await B.clickLine(line, 'first', '标题');
    await B.caretAt('标题文字');
    await sleep(300);
    const t0 = Date.now();
    const lag = await page.evaluate(async () => {
      // measure long tasks while typing
      const longs = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); });
      try { po.observe({ type: 'longtask', buffered: false }); } catch { /* */ }
      window.__longs = longs; window.__po = po;
      return true;
    });
    for (let i = 0; i < 30; i++) { await page.keyboard.type('x'); await sleep(30); }
    const end = Date.now() + 20000;
    while (Date.now() < end && !(await page.evaluate(() => window.__mdr.app.getText().includes('标题文字' + 'x'.repeat(30))))) await sleep(50);
    const wall = Date.now() - t0;
    const longs = await page.evaluate(() => { window.__po.disconnect(); return window.__longs; });
    out(name, { lines: N, wallMs: wall, longTasks: longs.length, longTaskMs: Math.round(longs.reduce((a, b) => a + b, 0)), maxLong: Math.round(Math.max(0, ...longs)), lag });
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  console.log('BASE', BASE);
}
