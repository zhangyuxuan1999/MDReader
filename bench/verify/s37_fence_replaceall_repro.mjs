// s37 — end-user repro of the replace-all stall: open the spec's own pathological case (one 50 000-line
// fenced code block), press Mod-F and Replace all. Pure UI actions, no internal APIs.
// Run: node bench/verify/s37_fence_replaceall_repro.mjs
import { launch, open, settle, structureCheck, toasts, latencyStats, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const T0 = Date.now();
page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[workerClient]')) console.log(`  +${Date.now() - T0} ms  ${m.text()}`); });
try {
  await open(page, '?mode=split');
  await settle(page, 60000);
  // exactly bench/gen-fixture's pathological "one 50k-line fence"
  await page.evaluate(async () => {
    let t = '# Log\n\n```js\n';
    for (let i = 0; i < 50000; i++) t += `const tok${i} = "tok value ${i}"; // tok\n`;
    t += '```\n';
    await window.__mdr.loadText(t, 'pathological-fence.md');
  });
  let s = await settle(page, 240000);
  C.check('50k-line fence document settles', s.ok, s);
  let sc = await structureCheck(page);
  C.check('it is one Code block', sc.blocks === 2 || sc.blocks === 1, sc);
  C.check('no restart on load', log.restarts === 0, `restarts=${log.restarts}`);

  // user opens find/replace and replaces "tok" (150 000 matches) — but let us start small: 1000 matches
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press(`${MOD}+f`);
  const panel = page.locator('.cm-search');
  await panel.waitFor({ timeout: 5000 });
  await panel.locator('input[name=search]').fill('tok value');   // 50 000 matches, one per line
  await panel.locator('input[name=replace]').fill('TOKEN value');
  console.log('  clicking Replace all (50 000 matches in one 50 000-line Code block)…');
  const t0 = Date.now();
  await panel.locator('button[name=replaceAll]').click({ timeout: 120000 });
  // how long until the preview catches up?
  const caught = await page.evaluate(async () => {
    const want = window.__mdr.version();
    const t0 = performance.now();
    while (performance.now() - t0 < 120000) {
      if (window.__wmsgs.structure >= want) return { structureMs: Math.round(performance.now() - t0) };
      await new Promise((r) => setTimeout(r, 50));
    }
    return { structureMs: -1 };
  });
  const wall = Date.now() - t0;
  C.measure('Replace all (50k matches, one 50k-line Code block): ms until the worker posts `structure`',
    caught.structureMs < 0 ? '>120000' : caught.structureMs, '< 10000 (silence limit)', caught.structureMs >= 0 && caught.structureMs < 10000);
  C.measure('Replace all wall time (ms)', wall, 'informational', true);
  const t = await toasts(page);
  C.check('DEFECT: a plain Replace all restarts the renderer and shows 「渲染器已重启」',
    log.restarts === 0 && !t.some((x) => x.includes('渲染器')), { restarts: log.restarts, toasts: t });
  // keep using the app the way a user would: type after the replace
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(4, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; });
  await page.keyboard.type('// typed after replace', { delay: 20 });
  const lat = await latencyStats(page);
  C.measure('input latency max right after the replace (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  s = await settle(page, 240000);
  C.check('the document eventually settles again', s.ok, s);
  const t2 = await toasts(page);
  C.check('DEFECT: repeated restarts push the client into the permanent give-up state',
    !t2.some((x) => x.includes('停止自动重启')), { restarts: log.restarts, toasts: t2 });
  sc = await structureCheck(page);
  C.check('structure still tiles the document', sc.problems.length === 0, sc);
  const replaced = await page.evaluate(() => (window.__mdr.app.editor.getText().match(/TOKEN value/g) || []).length);
  C.check('the replacement itself is correct in the editor (50 000 replacements)', replaced === 50000, replaced);
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s37 fence replace-all repro', log, { warnings: log.warnings.slice(0, 10) });
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
