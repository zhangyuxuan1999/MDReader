// s02 — typing while the initial render of huge.md (340k lines) is still in progress.
// Edits must never be lost: final editor text === typed text + original; preview reflects it.
// Run: node bench/verify/s02_type_during_load.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, makeChecker, report, fetchTestDoc, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  const original = await fetchTestDoc('huge.md');
  const origLines = original.split('\n').length;
  const tStart = Date.now();
  await open(page, '?doc=/test-data/huge.md&mode=split');
  // Wait only for the editor to hold the document (worker/preview still busy), then type immediately.
  await page.waitForFunction((n) => window.__mdr.app.editor.lineCount() >= n, origLines, { timeout: 60000 });
  const tEditorReady = Date.now() - tStart;
  const state = await page.evaluate(() => ({ structure: window.__wmsgs.structure, idle: window.__wmsgs.idle, html: window.__wmsgs.html, pending: document.querySelectorAll('.md-block.is-pending').length, blocks: document.querySelectorAll('.md-block').length, focused: window.__mdr.app.editor.hasFocus() }));
  C.check('render still in progress when typing starts', state.idle < 1, state);
  if (!state.focused) await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__lat.length = 0; });

  const typed = 'Typed during load: ' + 'abc '.repeat(60) + 'END ';
  const t0 = Date.now();
  await page.keyboard.type(typed, { delay: 0 });
  const typeMs = Date.now() - t0;
  const lat = await latencyStats(page);
  C.measure('editor ready after navigation (ms)', tEditorReady, 'informational', true);
  C.measure('input latency p95 while initial render in progress (ms)', lat.p95, '< 100', lat.p95 < 100);
  C.measure('input latency max while initial render in progress (ms)', lat.max, 'informational', true);
  C.measure(`typing ${typed.length} chars wall (ms)`, typeMs, 'informational', true);

  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('no edits lost: editor text === typed + original', text === typed + original, `len ${text.length} vs ${typed.length + original.length}; head="${text.slice(0, 60)}"`);

  const s = await settle(page, 120000);
  C.check('worker settled after typing during load', s.ok, s);
  const sc = await structureCheck(page);
  C.check('structure tiles the document', sc.problems.length === 0, sc);
  const firstBlockText = await page.evaluate(() => document.querySelector('.md-block')?.textContent || '');
  C.check('preview first block shows the typed text', firstBlockText.includes('Typed during load'), firstBlockText.slice(0, 80));
  const lt = await longTasks(page);
  C.measure('long tasks (count / max ms) whole scenario', `${lt.count}/${lt.max}`, 'max < 120 (CM state), informational', lt.max < 240);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s02 type during load', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
