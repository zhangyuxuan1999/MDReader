// s38 — does ordinary fast typing inside a 50 000-line fence also outrun the worker (same
// O(changes × block lines) cost, ~9.5 ms per change)? 400 chars at delay 0, then measure the
// lag from the last keystroke to the worker's `structure`/`idle` for that version.
// Run: node bench/verify/s38_fence_typing_burst.mjs
import { launch, open, settle, structureCheck, latencyStats, toasts, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const T0 = Date.now();
page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[workerClient]')) console.log(`  +${Date.now() - T0} ms  ${m.text()}`); });
try {
  await open(page, '?mode=split');
  await settle(page, 60000);
  for (const [lines, chars] of [[5000, 400], [50000, 400], [50000, 1200]]) {
    await page.evaluate(async (lines) => {
      let t = '# Log\n\n```js\n';
      for (let i = 0; i < lines; i++) t += `const v${i} = "value ${i}";\n`;
      t += '```\n';
      await window.__mdr.loadText(t, 'fence.md');
    }, lines);
    let s = await settle(page, 240000);
    C.check(`[${lines}-line fence] settles`, s.ok, s);
    const r0 = log.restarts;
    await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(Math.floor(e.lineCount() / 2), 0); e.focus(); window.__lat.length = 0; });
    const t0 = Date.now();
    await page.keyboard.type('// ' + 'abcdefghij '.repeat(Math.round(chars / 11)), { delay: 0 });
    const typeMs = Date.now() - t0;
    const lat = await latencyStats(page);
    C.measure(`[${lines}-line fence] ${chars}-char burst: wall ms / input latency p95`, `${typeMs} / ${lat.p95}`, 'p95 < 100', (lat.p95 ?? 0) < 100);
    const lag = await page.evaluate(async () => {
      const want = window.__mdr.version();
      const t0 = performance.now();
      let structureMs = -1, idleMs = -1;
      while (performance.now() - t0 < 180000) {
        if (structureMs < 0 && window.__wmsgs.structure >= want) structureMs = Math.round(performance.now() - t0);
        if (window.__wmsgs.idle >= want) { idleMs = Math.round(performance.now() - t0); break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { structureMs, idleMs };
    });
    C.measure(`[${lines}-line fence] last keystroke → worker \`structure\` (ms)`, lag.structureMs < 0 ? '>180000' : lag.structureMs, '< 10000 (silence limit)', lag.structureMs >= 0 && lag.structureMs < 10000);
    C.measure(`[${lines}-line fence] last keystroke → worker \`idle\` (ms)`, lag.idleMs < 0 ? '>180000' : lag.idleMs, '< 20000 (P3)', lag.idleMs >= 0 && lag.idleMs < 20000);
    const t = await toasts(page);
    C.check(`[${lines}-line fence] a ${chars}-char typing burst does not restart the renderer`, log.restarts === r0, { restarts: log.restarts - r0, toasts: t });
    const sc = await structureCheck(page);
    C.check(`[${lines}-line fence] structure tiles after the burst`, sc.problems.length === 0, sc);
  }
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s38 fence typing burst', log, { warnings: log.warnings.slice(0, 10) });
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
