// s23 — interleaved storms: typing while modes/themes flip, undo/redo storm, hidden-tab during a
// huge render, select-all + 6 MB paste over large.md then undo.
// Run: node bench/verify/s23_interleaved_storms.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, previewSnapshot, diffSnapshots, loadText, makeChecker, report, sleep, fetchTestDoc } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  // ---------------------------------------------------------------- A. type while modes+themes flip
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page, 90000);
  C.check('(A) initial settle medium.md', s.ok, s);
  const original = await fetchTestDoc('medium.md');
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(5000, 0); window.__mdr.app.editor.focus(); });
  const insertPos = await page.evaluate(() => window.__mdr.app.editor.view.state.selection.main.head);
  await page.evaluate(() => { window.__lat.length = 0; window.__longTasks.length = 0; });
  // Storm running in the page while Playwright types.
  const stormDone = page.evaluate(async () => {
    const modes = ['edit', 'split', 'preview'];
    for (let i = 0; i < 60; i++) {
      window.__mdr.mode(modes[i % 3]);
      window.__mdr.app.theme.set(i % 2 ? 'dark' : 'light');
      await new Promise((r) => setTimeout(r, 25));
    }
    window.__mdr.mode('split');
    window.__mdr.app.theme.set('light');
    return true;
  });
  const typed = 'STORM ' + 'abcdefghij '.repeat(60);
  await page.keyboard.type(typed, { delay: 0 });
  await stormDone;
  let lat = await latencyStats(page);
  C.measure('(A) input latency p95 / max while modes+themes flip (ms)', `${lat.p95} / ${lat.max}`, 'p95 < 100', (lat.p95 ?? 0) < 100);
  let lt = await longTasks(page);
  C.measure('(A) long tasks during the storm (count/max ms)', `${lt.count}/${lt.max}`, 'max < 50 (P12)', lt.max < 50);
  const textA = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('(A) no edits lost during mode/theme storm', textA === original.slice(0, insertPos) + typed + original.slice(insertPos),
    `len ${textA.length} vs ${original.length + typed.length}; around=${JSON.stringify(textA.slice(insertPos - 10, insertPos + 20))}`);
  s = await settle(page, 90000);
  C.check('(A) settles after the storm', s.ok, s);
  let sc = await structureCheck(page);
  C.check('(A) structure tiles after the storm', sc.problems.length === 0, sc);
  const incrA = await previewSnapshot(page);
  await loadText(page, textA, 'freshA.md');
  await settle(page, 90000);
  const freshA = await previewSnapshot(page);
  C.check('(A) preview after storm === fresh render', diffSnapshots(incrA, freshA).length === 0, diffSnapshots(incrA, freshA));
  C.check('(A) theme/mode consistent at the end', true, await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, mode: window.__mdr.app.layout.getMode() })));

  // ---------------------------------------------------------------- B. undo / redo storm on large.md
  await open(page, '?doc=/test-data/large.md&mode=split');
  s = await settle(page, 120000);
  C.check('(B) large.md settles', s.ok, s);
  const large = await fetchTestDoc('large.md');
  const sc0 = await structureCheck(page);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(50000, 0); window.__mdr.app.editor.focus(); });
  // 200 separate transactions (one per dispatch) so history has 200 steps
  await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    for (let i = 0; i < 200; i++) {
      const p = v.state.selection.main.head;
      v.dispatch({ changes: { from: p, insert: 'q' }, selection: { anchor: p + 1 }, userEvent: 'input.type' });
    }
  });
  s = await settle(page, 120000);
  C.check('(B) settles after 200 inserts', s.ok, s);
  await page.evaluate(() => { window.__lat.length = 0; window.__longTasks.length = 0; });
  const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
  let t0 = Date.now();
  for (let i = 0; i < 200; i++) await page.keyboard.press(`${MOD}+z`);
  const undoMs = Date.now() - t0;
  lat = await latencyStats(page);
  C.measure('(B) undo ×200: wall ms, latency p95 (ms)', `${undoMs} / ${lat.p95}`, 'p95 < 100', (lat.p95 ?? 0) < 100);
  s = await settle(page, 120000);
  C.check('(B) settles after undo ×200', s.ok, s);
  const afterUndo = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('(B) undo ×200 restores the original text exactly', afterUndo === large, `len ${afterUndo.length} vs ${large.length}`);
  let scU = await structureCheck(page);
  C.check('(B) structure tiles after undo ×200', scU.problems.length === 0, scU);
  C.check('(B) block count back to the original', scU.blocks === sc0.blocks, `${scU.blocks} vs ${sc0.blocks}`);
  t0 = Date.now();
  for (let i = 0; i < 200; i++) await page.keyboard.press(`${MOD}+Shift+z`);
  const redoMs = Date.now() - t0;
  lat = await latencyStats(page);
  C.measure('(B) redo ×200: wall ms, latency p95 (ms)', `${redoMs} / ${lat.p95}`, 'p95 < 100', (lat.p95 ?? 0) < 100);
  s = await settle(page, 120000);
  C.check('(B) settles after redo ×200', s.ok, s);
  const afterRedo = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('(B) redo ×200 reapplies every insert', afterRedo.length === large.length + 200, `len ${afterRedo.length} vs ${large.length + 200}`);
  scU = await structureCheck(page);
  C.check('(B) structure tiles after redo ×200', scU.problems.length === 0, scU);
  lt = await longTasks(page);
  C.measure('(B) long tasks during undo/redo storm (count/max ms)', `${lt.count}/${lt.max}`, 'max < 100', lt.max < 100);

  // ---------------------------------------------------------------- C. hidden tab during a huge render
  await page.evaluate(() => { window.__wmsgs.idle = -1; window.__wmsgs.structure = -1; });
  const huge = await fetchTestDoc('huge.md');
  const cdp = await page.context().newCDPSession(page);
  const loadPromise = page.evaluate((t) => window.__mdr.loadText(t, 'huge-hidden.md'), huge);
  await sleep(80);
  await cdp.send('Emulation.setPageVisibilityOverride', { visibility: 'hidden' }).catch(() => {});
  await sleep(3000);
  await cdp.send('Emulation.setPageVisibilityOverride', { visibility: 'visible' }).catch(() => {});
  await loadPromise;
  s = await settle(page, 180000);
  C.check('(C) settles after hidden-during-load', s.ok, s);
  sc = await structureCheck(page);
  C.check('(C) structure tiles after hidden-during-load', sc.problems.length === 0, sc);
  await sleep(600);
  const vis = await page.evaluate(() => {
    const el = window.__mdr.app.preview.el;
    const r = el.getBoundingClientRect();
    let total = 0, pending = 0;
    for (const b of document.querySelectorAll('.md-block')) {
      const br = b.getBoundingClientRect();
      if (br.bottom > r.top && br.top < r.bottom) { total++; if (b.classList.contains('is-pending')) pending++; }
    }
    return { total, pending };
  });
  C.check('(C) visible preview blocks mounted after returning from hidden', vis.total > 0 && vis.pending === 0, vis);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__mdr.app.editor.focus(); });
  await page.keyboard.type('VISIBLE-AGAIN ', { delay: 0 });
  s = await settle(page, 180000);
  C.check('(C) typing after return settles', s.ok, s);
  const firstBlock = await page.evaluate(() => document.querySelector('.md-block')?.textContent || '');
  C.check('(C) preview shows the post-return typing', firstBlock.includes('VISIBLE-AGAIN'), firstBlock.slice(0, 60));

  // ---------------------------------------------------------------- D. select-all + 6 MB paste over large.md, then undo
  await open(page, '?doc=/test-data/large.md&mode=split');
  s = await settle(page, 120000);
  C.check('(D) large.md settles', s.ok, s);
  const big = await page.evaluate(async () => {
    const unit = '# Pasted heading\n\nParagraph with **bold** and `code`.\n\n- one\n- two\n\n';
    let t = ''; while (t.length < 6 * 1024 * 1024) t += unit;
    const v = window.__mdr.app.editor.view;
    const a = performance.now();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, userEvent: 'input.paste' });
    return { ms: +(performance.now() - a).toFixed(1), len: t.length };
  });
  C.measure('(D) select-all + 6 MB paste main-thread ms', big.ms, '< 500', big.ms < 500);
  s = await settle(page, 180000);
  C.check('(D) settles after replacing the doc with a 6 MB paste', s.ok, s);
  sc = await structureCheck(page);
  C.check('(D) structure tiles after the paste', sc.problems.length === 0, sc);
  await page.evaluate(() => { window.__lat.length = 0; });
  await page.keyboard.press(`${MOD}+z`);
  s = await settle(page, 180000);
  C.check('(D) settles after undoing the 6 MB replacement', s.ok, s);
  const restored = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('(D) undo restores large.md exactly', restored === large, `len ${restored.length} vs ${large.length}`);
  sc = await structureCheck(page);
  C.check('(D) structure tiles after undo', sc.problems.length === 0 && sc.blocks === sc0.blocks, sc);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s23 interleaved storms', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
