// s33 — search-panel extremes: regexp that can match the empty string (^ , a* , \b) with Replace all,
// 100 000-match replace-all that grows the document, and undo of it. Watches for hangs (the page must
// stay responsive), structure consistency and preview correctness.
// Run: node bench/verify/s33_search_extremes.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, loadText, longTasks, latencyStats, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openPanel() {
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press(`${MOD}+f`);
  const panel = page.locator('.cm-search');
  await panel.waitFor({ timeout: 5000 });
  return panel;
}
async function setRegexp(panel, on) {
  const cb = panel.locator('input[name=re]');
  if (await cb.count()) { const checked = await cb.isChecked(); if (checked !== on) await cb.click(); }
  else C.check('search panel exposes a regexp toggle', false, 'input[name=re] missing');
}

try {
  // ---------------------------------------------------------------- A. empty-matching regexps
  await open(page, '?mode=split');
  await settle(page, 60000);
  await page.evaluate(async () => {
    let t = '';
    for (let i = 0; i < 2000; i++) t += `Line ${i} with words here.\n\n`;
    await window.__mdr.loadText(t, 'regexp.md');
  });
  let s = await settle(page, 90000);
  C.check('(A) base doc settles', s.ok, s);
  const before = await page.evaluate(() => window.__mdr.app.editor.getText());

  for (const pattern of ['^', 'a*', '\\b', '(?:)']) {
    const panel = await openPanel();
    await setRegexp(panel, true);
    await panel.locator('input[name=search]').fill(pattern);
    await panel.locator('input[name=replace]').fill('#');
    const t0 = Date.now();
    let timedOut = false;
    try {
      await panel.locator('button[name=replaceAll]').click({ timeout: 20000 });
      // the page must answer within 20 s
      await page.evaluate(() => window.__mdr.app.editor.lineCount(), { timeout: 20000 });
    } catch (e) { timedOut = true; }
    const ms = Date.now() - t0;
    C.check(`(A) replace-all with /${pattern}/ does not hang the page`, !timedOut, `${ms} ms${timedOut ? ' TIMEOUT' : ''}`);
    C.measure(`(A) replace-all /${pattern}/ wall (ms)`, ms, '< 20000', ms < 20000);
    const st = await page.evaluate(() => ({ len: window.__mdr.app.editor.getText().length, lines: window.__mdr.app.editor.lineCount() })).catch(() => ({ len: -1, lines: -1 }));
    console.log(`      /${pattern}/ → len ${st.len} lines ${st.lines}`);
    s = await settle(page, 120000);
    C.check(`(A) worker settles after replace-all /${pattern}/`, s.ok, s);
    const sc = await structureCheck(page);
    C.check(`(A) structure tiles after replace-all /${pattern}/`, sc.problems.length === 0, sc);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.app.editor.focus());
    await page.keyboard.press(`${MOD}+z`);
    await sleep(200);
    const undone = await page.evaluate(() => window.__mdr.app.editor.getText());
    C.check(`(A) undo restores the document after /${pattern}/`, undone === before, `len ${undone.length} vs ${before.length}`);
    await settle(page, 120000);
  }

  // ---------------------------------------------------------------- B. 100k-match replace-all that grows the doc
  await page.evaluate(async () => {
    let t = '';
    for (let i = 0; i < 50000; i++) t += `tok line ${i} tok\n`;
    await window.__mdr.loadText(t, 'many.md');
  });
  s = await settle(page, 180000);
  C.check('(B) 100k-match doc settles', s.ok, s);
  const sc0 = await structureCheck(page);
  const base = await page.evaluate(() => window.__mdr.app.editor.getText());
  const panel = await openPanel();
  await setRegexp(panel, false);
  await panel.locator('input[name=search]').fill('tok');
  await panel.locator('input[name=replace]').fill('TOKEN-REPLACED');
  await page.evaluate(() => { window.__longTasks.length = 0; });
  let t0 = Date.now();
  await panel.locator('button[name=replaceAll]').click({ timeout: 60000 });
  const rMs = Date.now() - t0;
  C.measure('(B) replace-all over 100 000 matches: wall (ms)', rMs, '< 20000', rMs < 20000);
  let lt = await longTasks(page);
  C.measure('(B) long tasks during the 100k replace-all (count/max ms)', `${lt.count}/${lt.max}`, 'max < 1000', lt.max < 1000);
  const after = await page.evaluate(() => ({ len: window.__mdr.app.editor.getText().length, n: (window.__mdr.app.editor.getText().match(/TOKEN-REPLACED/g) || []).length, lines: window.__mdr.app.editor.lineCount() }));
  C.check('(B) all 100 000 matches replaced', after.n === 100000, after);
  s = await settle(page, 240000);
  C.check('(B) worker settles after the 100k replace-all', s.ok, s);
  let sc = await structureCheck(page);
  C.check('(B) structure tiles after the 100k replace-all', sc.problems.length === 0, sc);
  C.check('(B) block count unchanged (same block boundaries)', sc.blocks === sc0.blocks, `${sc.blocks} vs ${sc0.blocks}`);
  // block line ranges must tile the doc — structureCheck already asserts that; verify preview content too
  const incr = await previewSnapshot(page);
  const txt = await page.evaluate(() => window.__mdr.app.editor.getText());
  await loadText(page, txt, 'fresh-many.md');
  await settle(page, 240000);
  const fresh = await previewSnapshot(page);
  C.check('(B) preview after the 100k replace-all === fresh render', diffSnapshots(incr, fresh).length === 0, diffSnapshots(incr, fresh));

  // undo it
  await loadText(page, base, 'many.md');
  await settle(page, 240000);
  const panel2 = await openPanel();
  await panel2.locator('input[name=search]').fill('tok');
  await panel2.locator('input[name=replace]').fill('TOKEN-REPLACED');
  await panel2.locator('button[name=replaceAll]').click({ timeout: 60000 });
  await settle(page, 240000);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__mdr.app.editor.focus(); window.__lat.length = 0; });
  t0 = Date.now();
  await page.keyboard.press(`${MOD}+z`);
  const uMs = Date.now() - t0;
  const lat = await latencyStats(page);
  C.measure('(B) undo of the 100k replace-all: wall ms / latency max', `${uMs} / ${lat.max}`, 'latency < 100', (lat.max ?? 0) < 100);
  s = await settle(page, 240000);
  C.check('(B) settles after undoing the 100k replace-all', s.ok, s);
  const restored = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('(B) undo restores the 100k-match document exactly', restored === base, `len ${restored.length} vs ${base.length}`);
  sc = await structureCheck(page);
  C.check('(B) structure tiles after the undo', sc.problems.length === 0 && sc.blocks === sc0.blocks, sc);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s33 search extremes', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
