// s05 — replace-all via the CM search panel with 1000 matches that change block structure
// ("xx " → "# " turns 1000 paragraphs into headings). Structure must stay consistent (tiling,
// block count, outline) and equal the from-scratch render.
// Run: node bench/verify/s05_replace_all.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, latencyStats, longTasks, makeChecker, report, loadText, sleep } from './_lib.mjs';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?mode=split');
  let doc = '';
  for (let i = 0; i < 1000; i++) doc += `xx Title ${i}\n\nParagraph ${i} with some text and a foo token.\n\n- item ${i}\n\n`;
  await loadText(page, doc, 'replace.md');
  let s = await settle(page, 60000);
  C.check('loaded 1000-section doc', s.ok, s);
  const sc0 = await structureCheck(page);
  C.check('initial structure tiles', sc0.problems.length === 0, sc0);
  const toc0 = await page.evaluate(() => document.querySelectorAll('.mdr-toc__item').length);

  const versionBefore = await page.evaluate(() => window.__mdr.version());
  await page.evaluate(() => { window.__mdr.app.editor.focus(); window.__longTasks.length = 0; });
  await page.keyboard.press(`${MOD}+f`);
  const panel = page.locator('.cm-search');
  await panel.waitFor({ timeout: 5000 });
  await panel.locator('input[name=search]').fill('xx ');
  await panel.locator('input[name=replace]').fill('# ');
  const t0 = Date.now();
  await panel.locator('button[name=replaceAll]').click();
  const replaceMs = Date.now() - t0;
  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  const headings = (text.match(/^# Title \d+$/gm) || []).length;
  C.check('1000 replacements applied in the editor', headings === 1000 && !text.includes('xx '), `headings=${headings}`);
  const versionAfter = await page.evaluate(() => window.__mdr.version());
  C.check('replace-all is one transaction (one version bump)', versionAfter === versionBefore + 1, `version ${versionBefore} → ${versionAfter}`);

  s = await settle(page, 60000);
  C.check('settled after replace-all', s.ok, s);
  const lt = await longTasks(page);
  C.measure('replace-all wall ms / long tasks (count/max)', `${replaceMs} / ${lt.count}/${lt.max}`, 'informational', true);
  const sc = await structureCheck(page);
  C.check('structure tiles after replace-all', sc.problems.length === 0, sc);
  C.check('1000 heading blocks in structure', sc.kinds[1] === 1000, sc.kinds);
  await sleep(300);
  const toc1 = await page.evaluate(() => document.querySelectorAll('.mdr-toc__item').length);
  C.check('TOC shows 1000 headings after replace-all', toc1 === 1000, `before=${toc0} after=${toc1}`);
  const incr = await previewSnapshot(page);

  await loadText(page, text, 'fresh.md');
  s = await settle(page, 60000);
  const sc2 = await structureCheck(page);
  C.check('fresh block count equals incremental', sc2.blocks === sc.blocks, `${sc.blocks} vs ${sc2.blocks}`);
  const fresh = await previewSnapshot(page);
  const diffs = diffSnapshots(incr, fresh);
  C.check('incremental preview === fresh render after replace-all', diffs.length === 0, diffs);

  // Second pass: regexp replace that merges/splits blocks ("\n\n- item" → " item"), then undo.
  await loadText(page, doc, 'replace2.md');
  await settle(page, 60000);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press(`${MOD}+f`);
  await panel.locator('input[name=search]').fill('foo token');
  await panel.locator('input[name=replace]').fill('bar\n\n> quoted');
  await panel.locator('button[name=replaceAll]').click();
  const text2 = await page.evaluate(() => window.__mdr.app.editor.getText());
  s = await settle(page, 60000);
  const sc3 = await structureCheck(page);
  C.check('structure tiles after second replace-all', sc3.problems.length === 0, sc3);
  const incr2 = await previewSnapshot(page);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press(`${MOD}+z`);
  const undone = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('undo after replace-all restores the document', undone === doc, `len ${undone.length} vs ${doc.length}`);
  s = await settle(page, 60000);
  const sc4 = await structureCheck(page);
  C.check('structure tiles after undo of replace-all', sc4.problems.length === 0 && sc4.blocks === sc0.blocks, sc4);
  await loadText(page, text2, 'fresh2.md');
  await settle(page, 60000);
  const fresh2 = await previewSnapshot(page);
  const diffs2 = diffSnapshots(incr2, fresh2);
  C.check('incremental preview === fresh render after second replace-all', diffs2.length === 0, diffs2);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s05 replace-all', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
