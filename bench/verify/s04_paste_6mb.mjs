// s04 — paste 6 MB of markdown into the editor in one transaction (view.dispatch), on top of medium.md.
// Measures the dispatch (main-thread) time, input latency right after, time to settle; verifies structure.
// Run: node bench/verify/s04_paste_6mb.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page, 60000);
  C.check('initial settle', s.ok, s);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(10000, 0); window.__longTasks.length = 0; });

  const r = await page.evaluate(() => {
    const unit = '## Pasted heading\n\nA pasted paragraph with **bold**, `code`, 中文 and a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n```ts\nexport const x: number = 42;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n';
    let text = '';
    while (text.length < 6 * 1024 * 1024) text += unit;
    const view = window.__mdr.app.editor.view;
    const pos = view.state.selection.main.head;
    const t0 = performance.now();
    view.dispatch({ changes: { from: pos, insert: text }, userEvent: 'input.paste' });
    const dispatchMs = performance.now() - t0;
    return { dispatchMs: +dispatchMs.toFixed(1), pasted: text.length, pos, lines: view.state.doc.lines };
  });
  C.measure('6 MB paste dispatch main-thread time (ms)', r.dispatchMs, '< 500 (informational)', r.dispatchMs < 1000);
  // responsiveness right after the paste
  await page.evaluate(() => { window.__lat.length = 0; });
  await page.keyboard.type('typing right after paste ', { delay: 0 });
  const lat = await latencyStats(page);
  C.measure('input latency p95 immediately after paste (ms)', lat.p95, '< 100', lat.p95 < 100);
  C.measure('input latency max immediately after paste (ms)', lat.max, 'informational', true);

  const t1 = Date.now();
  s = await settle(page, 180000);
  C.check('settled after 6 MB paste', s.ok, s);
  C.measure('time from paste to worker idle (ms)', Date.now() - t1, '< 20000 (P3 idle)', Date.now() - t1 < 20000);
  const sc = await structureCheck(page);
  C.check('structure tiles the document after paste', sc.problems.length === 0, sc);
  const lt = await longTasks(page);
  C.measure('long tasks after paste (count / max ms / >100ms)', `${lt.count}/${lt.max}/${lt.over100}`, 'informational', true);
  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('editor holds pasted text + typed text', text.includes('typing right after paste') && text.length > 6 * 1024 * 1024, `len ${text.length}`);

  // Scroll the preview into the pasted region and check it renders
  await page.evaluate(() => window.__mdr.app.preview.scrollToLine(10050, 0, 'instant'));
  await sleep(800);
  const region = await page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const b = p.blockAtLine(10050);
    const el = document.querySelector(`.md-block[data-id="${b.id}"]`);
    return { pending: el?.classList.contains('is-pending'), text: el?.textContent?.slice(0, 60) };
  });
  C.check('pasted region mounted in preview', region.pending === false, region);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s04 paste 6 MB', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
