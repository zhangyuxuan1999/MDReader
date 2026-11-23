// s03 — large.md: select-all + delete + undo (+ redo). Empty doc must yield 0 blocks and zero stats;
// undo must restore the exact text and a consistent structure equal to the fresh render.
// Run: node bench/verify/s03_selectall_delete_undo.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, makeChecker, report, fetchTestDoc, sleep } from './_lib.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const { browser, page, log } = await launch();
const C = makeChecker();
try {
  const original = await fetchTestDoc('large.md');
  await open(page, '?doc=/test-data/large.md&mode=split');
  let s = await settle(page, 120000);
  C.check('initial settle large.md', s.ok, s);
  const sc0 = await structureCheck(page);
  C.check('initial structure tiles', sc0.problems.length === 0, sc0);
  const stats0 = await page.evaluate(() => document.querySelector('.mdr-statusbar')?.textContent);

  await page.evaluate(() => { window.__mdr.app.editor.focus(); window.__longTasks.length = 0; window.__lat.length = 0; });
  let t0 = Date.now();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press('Delete');
  const delMs = Date.now() - t0;
  const afterDel = await page.evaluate(() => ({ text: window.__mdr.app.editor.getText(), lines: window.__mdr.app.editor.lineCount() }));
  C.check('editor empty after select-all + delete', afterDel.text === '', afterDel);
  s = await settle(page, 30000);
  C.check('settled after delete', s.ok, s);
  const scDel = await structureCheck(page);
  C.check('0 blocks after delete', scDel.blocks === 0 && scDel.domBlocks === 0, scDel);
  const statsDel = await page.evaluate(() => document.querySelector('.mdr-statusbar')?.textContent);
  C.check('status bar shows zero stats after delete', /字数 0/.test(statsDel || '') && /字符 0/.test(statsDel || ''), statsDel);
  let lt = await longTasks(page);
  C.measure('select-all+delete: wall ms / long tasks (count/max)', `${delMs} / ${lt.count}/${lt.max}`, 'informational', true);

  t0 = Date.now();
  await page.keyboard.press(`${MOD}+z`);
  const undoMs = Date.now() - t0;
  const afterUndo = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('undo restores exact original text', afterUndo === original, `len ${afterUndo.length} vs ${original.length}`);
  s = await settle(page, 120000);
  C.check('settled after undo', s.ok, s);
  const scUndo = await structureCheck(page);
  C.check('structure tiles after undo', scUndo.problems.length === 0, scUndo);
  C.check('block count after undo equals initial', scUndo.blocks === sc0.blocks, `${scUndo.blocks} vs ${sc0.blocks}`);
  const statsUndo = await page.evaluate(() => document.querySelector('.mdr-statusbar')?.textContent);
  const onlyStats = (t) => ((t || '').match(/字数 \d+字符 \d+约 \d+ 分钟/) || [''])[0];
  C.check('stats after undo equal initial', onlyStats(statsUndo) === onlyStats(stats0), { stats0, statsUndo });
  lt = await longTasks(page);
  C.measure('undo: wall ms / long tasks (count/max)', `${undoMs} / ${lt.count}/${lt.max}`, 'informational', true);

  // Redo, then undo again — typing must remain responsive
  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.keyboard.press(`${MOD}+z`);
  const again = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('redo+undo still original', again === original);
  s = await settle(page, 120000);
  await page.evaluate(() => { window.__lat.length = 0; window.__mdr.app.editor.gotoLine(50000, 0); });
  await page.keyboard.type('after undo typing test ', { delay: 0 });
  const lat = await latencyStats(page);
  C.measure('input latency p95 after undo cycle (ms)', lat.p95, '< 100', lat.p95 < 100);
  s = await settle(page, 60000);
  C.check('settled after typing', s.ok, s);
  const scT = await structureCheck(page);
  C.check('structure tiles after typing', scT.problems.length === 0, scT);
  // Visible blocks near the cursor must show the typed text
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).some((b) => b.textContent.includes('after undo typing test')));
  C.check('preview shows typed text after undo cycle', shown);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s03 select-all delete undo', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
