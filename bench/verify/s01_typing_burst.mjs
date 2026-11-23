// s01 — rapid typing burst: 2000 chars with delay 0 into medium.md, mid-document.
// Verifies: editor text === expected; worker mirror (preview after mountAll) === from-scratch render
// of the final text; block structure tiles the doc; no console/page errors; input latency.
// Run: node bench/verify/s01_typing_burst.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, latencyStats, longTasks, makeChecker, report, sleep, fetchTestDoc, loadText } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page);
  C.check('initial settle medium.md', s.ok, s);
  const original = await fetchTestDoc('medium.md');

  // Cursor at the start of line 5000
  await page.evaluate(() => window.__mdr.app.editor.gotoLine(5000, 0));
  const insertPos = await page.evaluate(() => window.__mdr.app.editor.view.state.selection.main.head);

  // 2000 chars: prose, headings, list items, fence toggles, emoji, CJK
  const unit = '# 标题 Heading\n\nSome **bold** _text_ with `code` and 中文汉字 🚀 emoji.\n- item one\n- item two\n\n```js\nconst x = 1;\n```\n\n';
  let burst = '';
  while (burst.length < 2000) burst += unit;
  burst = burst.slice(0, 2000);

  await page.evaluate(() => { window.__lat.length = 0; window.__longTasks.length = 0; });
  const t0 = Date.now();
  await page.keyboard.type(burst, { delay: 0 });
  const typeMs = Date.now() - t0;
  const lat = await latencyStats(page);
  C.measure('typing 2000 chars wall time (ms)', typeMs, 'informational', true);
  C.measure('input latency p95 during burst (ms)', lat.p95, '< 100', lat.p95 < 100);
  C.measure('input latency max during burst (ms)', lat.max, 'informational', true);

  // Editor text must be original with burst inserted (closeBrackets / list continuation could alter it —
  // keyboard.type sends keys, so Enter inside "- item" triggers list continuation. Compare against CM's own doc.)
  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('editor text grew by ≥ 2000 chars', text.length >= original.length + 2000, `len ${text.length} vs ${original.length}`);
  C.check('editor text prefix intact', text.slice(0, insertPos) === original.slice(0, insertPos));
  C.check('editor text suffix intact', text.endsWith(original.slice(insertPos)));

  s = await settle(page, 60000);
  C.check('worker settled after burst', s.ok, s);
  const lt = await longTasks(page);
  C.measure('long tasks during burst (count/max ms)', `${lt.count}/${lt.max}`, '0 > 100 ms after load', lt.over100 === 0);
  const sc = await structureCheck(page);
  C.check('structure tiles the document after burst', sc.problems.length === 0, sc);
  const incr = await previewSnapshot(page);

  // Fresh render of the same text
  await loadText(page, text, 'fresh.md');
  s = await settle(page, 60000);
  C.check('fresh render settled', s.ok, s);
  const sc2 = await structureCheck(page);
  C.check('fresh structure block count equals incremental', sc2.blocks === sc.blocks, `${sc.blocks} vs ${sc2.blocks}`);
  const fresh = await previewSnapshot(page);
  const diffs = diffSnapshots(incr, fresh);
  C.check('incremental preview === fresh render (per-block HTML)', diffs.length === 0, diffs);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s01 typing burst', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
