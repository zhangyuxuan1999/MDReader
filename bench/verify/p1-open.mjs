// bench/verify/p1-open.mjs — P1 (open → first-visible), P3 (idle), P4 (longest task during open,
// long tasks after t=1 s), P13-load (memory after load) for large.md and huge.md.
// Usage: node bench/verify/p1-open.mjs [large|huge] [runs]
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, memory, report, dumpErrors, sleep, fmt } from './common.mjs';

const which = process.argv[2] ?? 'large';
const runs = Number(process.argv[3] ?? 2);
const { browser, page, cdp, errors } = await launch();
const results = [];
try {
  await warmUp(page);
  for (let run = 0; run < runs; run++) {
    const url = `${BASE}/?doc=/test-data/${which}.md&mode=split`;
    await page.goto(url);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    const t = await waitFirstVisible(page, 90_000);
    const mounted0 = await page.evaluate(() => ({
      mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
      wrappers: document.querySelectorAll('.md-block').length,
      blocks: window.__mdr.app.preview.blockCount(),
      lines: window.__mdr.app.editor.lineCount(),
    }));
    // wait until 1 s past open, then 5 s more to catch long tasks after t=1s
    await sleep(6000);
    const idleMs = await Promise.race([waitIdle(page, 120_000), sleep(120_000).then(() => -1)]);
    await sleep(1000);
    const probe = await readProbe(page);
    const open = t.open;
    const during = probe.longTasks.filter((x) => x.start >= open && x.start < open + 1000);
    const after = probe.longTasks.filter((x) => x.start >= open + 1000);
    const worstDuring = Math.max(0, ...during.map((x) => x.dur));
    const worstAfter = Math.max(0, ...after.map((x) => x.dur));
    const mem = await memory(page, cdp);
    console.log(`\n[${which} run ${run}] open→structure ${fmt(t.structure)} ms, open→first-visible ${fmt(t.firstVisible)} ms, open→idle ${fmt(idleMs)} ms`);
    console.log(`  blocks=${mounted0.blocks} wrappers@fv=${mounted0.wrappers} mounted@fv=${mounted0.mounted} lines=${mounted0.lines}`);
    console.log(`  ALL long tasks since nav (rel. to open): ${probe.longTasks.map((x) => `${x.dur.toFixed(0)}ms@${(x.start - open).toFixed(0)}`).join(', ') || 'none'}`);
    console.log(`  long tasks during open (<1s): ${during.map((x) => `${x.dur.toFixed(0)}ms@+${(x.start - open).toFixed(0)}`).join(', ') || 'none'}`);
    console.log(`  long tasks after 1s: ${after.length} ${after.slice(0, 15).map((x) => `${x.dur.toFixed(0)}ms@+${(x.start - open).toFixed(0)}`).join(', ')}`);
    console.log(`  LoAF ≥50ms after open: ${probe.loaf.filter((x) => x.start >= open).slice(0, 10).map((x) => `${x.dur.toFixed(0)}ms(block ${x.blocking.toFixed(0)})@+${(x.start - open).toFixed(0)} ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ')}`);
    console.log(`  memory: heap ${fmt(mem.jsHeapUsedMB)} MB used / ${fmt(mem.jsHeapTotalMB)} MB total, DOM nodes ${mem.nodes}, UA-specific ${typeof mem.uaSpecificMB === 'number' ? fmt(mem.uaSpecificMB) + ' MB' : mem.uaSpecificMB}`);
    results.push({ run, firstVisible: t.firstVisible, structure: t.structure, idle: idleMs, worstDuring, afterCount: after.length, worstAfter, mem });
  }
  const best = (k) => Math.min(...results.map((r) => r[k]));
  const worst = (k) => Math.max(...results.map((r) => r[k]));
  console.log('\n==== summary', which);
  report(`P1 ${which} open→first-visible (best of ${runs})`, `${fmt(best('firstVisible'))} ms (worst ${fmt(worst('firstVisible'))})`, '< 400 ms', best('firstVisible') < 400);
  report(`P3 ${which} open→idle (best)`, `${fmt(best('idle'))} ms`, '< 20000 ms', best('idle') > 0 && best('idle') < 20000);
  report(`P4 ${which} longest task during open (best)`, `${fmt(best('worstDuring'))} ms (worst ${fmt(worst('worstDuring'))})`, '< 120 ms', best('worstDuring') < 120);
  report(`P4 ${which} long tasks >50ms after t=1s (best run)`, `${best('afterCount')} (worst run ${worst('afterCount')}, longest ${fmt(worst('worstAfter'))} ms)`, '0', best('afterCount') === 0);
  console.log(`P13-load ${which} JS heap: ${results.map((r) => fmt(r.mem.jsHeapUsedMB)).join(', ')} MB`);
} finally {
  dumpErrors(errors);
  await browser.close();
}
