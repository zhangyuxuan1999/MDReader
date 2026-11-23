// s15 — worker crash in the MIDDLE of a typing burst (and a second crash while the restart's setDoc is
// still being processed). Edits must never be lost: after settle, the preview must equal a from-scratch
// render of editor.getText(); exactly the intended restarts; toast shown; latency stays < 100 ms.
// Run: node bench/verify/s15_kill_during_burst.mjs
import { launch, open, settle, structureCheck, previewSnapshot, diffSnapshots, latencyStats, toasts, makeChecker, report, sleep, loadText, fetchTestDoc } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?doc=/test-data/medium.md&mode=split');
  let s = await settle(page, 60000);
  C.check('initial settle', s.ok, s);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(7000, 0); ed.focus(); window.__lat.length = 0; });

  const unit = 'burst **bold** 中文 `code`\n- li\n\n# H\n\n';
  let burst = '';
  while (burst.length < 1200) burst += unit;
  // Crash the worker twice while typing, at ~1/3 and ~2/3 of the burst. Driven by the keystroke COUNT,
  // not by wall-clock timers: the burst used to take > 3.5 s, and after the P5/P11 work it takes ~0.9 s,
  // so fixed 1.5 s / 3.2 s timers fired after the burst had finished and the scenario stopped being tested.
  await page.evaluate((n) => {
    window.__crashAt = [];
    let typed = 0;
    const crash = (why) => {
      window.__workers[window.__workers.length - 1].dispatchEvent(new ErrorEvent('error', { message: why }));
      window.__crashAt.push(performance.now());
    };
    window.addEventListener('keydown', () => {
      typed++;
      if (typed === Math.floor(n / 3)) crash('crash-1');
      else if (typed === Math.floor((n * 2) / 3)) crash('crash-2');
    }, true);
  }, burst.length);
  const t0 = Date.now();
  await page.keyboard.type(burst, { delay: 0 });
  const wall = Date.now() - t0;
  const lat = await latencyStats(page);
  C.measure('burst wall ms (informational: the crashes are keystroke-driven)', wall, 'informational', true);
  C.check('both crashes fired inside the burst', (await page.evaluate(() => window.__crashAt.length)) === 2, await page.evaluate(() => window.__crashAt.map((x) => Math.round(x))));
  C.measure('input latency p95 / max during burst with 2 crashes (ms)', `${lat.p95} / ${lat.max}`, 'p95 < 100', lat.p95 < 100);
  await sleep(300);
  const workers = await page.evaluate(() => window.__workers.length);
  C.check('exactly 2 restarts happened (3 workers)', workers === 3 && log.restarts === 2, { workers, restarts: log.restarts });
  const t = await toasts(page);
  C.check('toast 「渲染器已重启」 shown', t.some((x) => x.includes('渲染器已重启')), t);

  s = await settle(page, 60000);
  C.check('settled after burst + crashes', s.ok, s);
  const text = await page.evaluate(() => window.__mdr.app.editor.getText());
  C.check('editor holds the whole burst', text.includes('burst **bold**') && text.length > 410000 + 1100, `len ${text.length}`);
  const sc = await structureCheck(page);
  C.check('structure tiles after crashes', sc.problems.length === 0, sc);
  const incr = await previewSnapshot(page);
  await loadText(page, text, 'fresh.md');
  s = await settle(page, 60000);
  const fresh = await previewSnapshot(page);
  const diffs = diffSnapshots(incr, fresh);
  C.check('preview after crash-during-burst === fresh render', diffs.length === 0, diffs);

  // crash during the initial setDoc of large.md (restart replays a 2 MB doc; a crash inside the replay)
  const large = await fetchTestDoc('large.md');
  await page.evaluate(() => { window.__wmsgs.structure = -1; });
  const pLoad = page.evaluate(async (t) => { await window.__mdr.loadText(t, 'large.md'); }, large);
  await page.evaluate(() => { window.__workers[window.__workers.length - 1].dispatchEvent(new ErrorEvent('error', { message: 'crash-3' })); });
  await pLoad;
  s = await settle(page, 120000);
  C.check('crash during setDoc(large.md): settles', s.ok, s);
  const sc2 = await structureCheck(page);
  C.check('crash during setDoc(large.md): structure tiles with 30002 blocks', sc2.problems.length === 0 && sc2.blocks === 30002, sc2);
  const restartsNow = log.restarts;
  C.check('3 restarts total so far (limit not yet exceeded)', restartsNow === 3, `restarts=${restartsNow}`);
  await page.evaluate(() => { window.__lat.length = 0; window.__mdr.app.editor.gotoLine(100, 0); window.__mdr.app.editor.focus(); });
  await page.keyboard.type('after three restarts ', { delay: 0 });
  s = await settle(page, 60000);
  // `settle` resolves on the worker's `idle`; the preview still has to run a rAF and flush its mount
  // queue, so poll for the mount instead of sampling the DOM in the same tick.
  const shown = await page
    .waitForFunction(() => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).some((b) => b.textContent.includes('after three restarts')), null, { timeout: 5000 })
    .then(() => true, () => false);
  C.check('preview reflects typing after the 3rd restart', shown);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s15 kill during burst', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
