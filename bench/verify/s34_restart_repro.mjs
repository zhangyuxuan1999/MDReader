// s34 — isolate the unexpected renderer restarts seen at the end of s33: a document that is ONE
// 50 000-line Prose block, replace-all over 100 000 matches, then reload/undo. Prints every
// restart reason with a timestamp and what the worker was doing.
// Run: node bench/verify/s34_restart_repro.mjs
import { launch, open, settle, structureCheck, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const events = [];
page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('[workerClient]')) events.push({ t: Date.now(), text: m.text() }); });
const T0 = Date.now();
const mark = (s) => { events.push({ t: Date.now(), text: '— ' + s }); console.log(`[${Date.now() - T0} ms] ${s}`); };

try {
  await open(page, '?mode=split');
  await settle(page, 60000);
  mark('loading the 50 000-line single-Prose-block document (0.9 MB, no blank lines)');
  await page.evaluate(async () => { let t = ''; for (let i = 0; i < 50000; i++) t += `tok line ${i} tok\n`; await window.__mdr.loadText(t, 'many.md'); });
  let s = await settle(page, 240000);
  mark(`settled: ${JSON.stringify(s)}`);
  C.check('single-block 50k-line doc settles', s.ok, s);
  let sc = await structureCheck(page);
  C.check('it is one block', sc.blocks === 1, sc);
  C.check('no restart on load', log.restarts === 0, `restarts=${log.restarts}`);

  mark('opening search panel / replace-all over 100 000 matches');
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press(`${MOD}+f`);
  const panel = page.locator('.cm-search');
  await panel.waitFor({ timeout: 5000 });
  await panel.locator('input[name=search]').fill('tok');
  await panel.locator('input[name=replace]').fill('TOKEN-REPLACED');
  const r0 = log.restarts;
  await panel.locator('button[name=replaceAll]').click({ timeout: 60000 });
  mark('replaceAll clicked');
  s = await settle(page, 240000);
  mark(`settled after replace-all: ${JSON.stringify(s)} restarts=${log.restarts}`);
  C.check('no restart during replace-all', log.restarts === r0, `restarts ${r0} → ${log.restarts}`);

  mark('undo');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.app.editor.focus());
  const r1 = log.restarts;
  await page.keyboard.press(`${MOD}+z`);
  s = await settle(page, 240000);
  mark(`settled after undo: ${JSON.stringify(s)} restarts=${log.restarts}`);
  C.check('no restart during undo of the replace-all', log.restarts === r1, `restarts ${r1} → ${log.restarts}`);

  mark('mountAll of the 2 MB single block + scroll');
  await page.evaluate(() => window.__mdr.app.preview.mountAll());
  await sleep(3000);
  mark(`after mountAll restarts=${log.restarts}`);

  // repeat replace-all/undo a few times: this is what s33 did before the restarts appeared
  for (let i = 0; i < 3; i++) {
    const rb = log.restarts;
    await page.keyboard.press(`${MOD}+f`);
    await panel.locator('input[name=search]').fill(i % 2 ? 'TOKEN-REPLACED' : 'tok');
    await panel.locator('input[name=replace]').fill(i % 2 ? 'tok' : 'TOKEN-REPLACED');
    await panel.locator('button[name=replaceAll]').click({ timeout: 60000 });
    s = await settle(page, 240000);
    await page.keyboard.press('Escape');
    mark(`round ${i}: settled=${s.ok} restarts ${rb} → ${log.restarts}`);
    C.check(`round ${i}: no restart`, log.restarts === rb, `${rb} → ${log.restarts}`);
  }

  sc = await structureCheck(page);
  C.check('structure tiles at the end', sc.problems.length === 0, sc);
  C.check('OVERALL: no worker restart in the whole scenario', log.restarts === 0, `restarts=${log.restarts}`);
  console.log('\nrestart events:');
  for (const e of events) console.log(`  +${e.t - T0} ms  ${e.text}`);
  console.log('\nall warnings:', JSON.stringify(log.warnings.slice(0, 20), null, 1));
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s34 restart repro', log, { warnings: log.warnings.slice(0, 10) });
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
