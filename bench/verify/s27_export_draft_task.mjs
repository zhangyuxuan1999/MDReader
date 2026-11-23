// s27 — exportHtml on big documents (2 MB / 6.6 MB) incl. concurrent requests, draft autosave of a
// 6.6 MB document, preview checkbox write-back at scale, and worker restart give-up + later recovery.
// Run: node bench/verify/s27_export_draft_task.mjs
import { launch, open, settle, structureCheck, latencyStats, longTasks, toasts, makeChecker, report, sleep, fetchTestDoc } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  // ---------------------------------------------------------------- A. exportHtml on large.md
  await open(page, '?doc=/test-data/large.md&mode=split');
  await page.waitForFunction(() => window.__mdr.version() >= 1, null, { timeout: 120000 });
  let s = await settle(page, 180000);
  C.check('(A) large.md settles', s.ok, s);
  await page.evaluate(() => { window.__longTasks.length = 0; });
  let t0 = Date.now();
  const exp1 = await page.evaluate(() => Promise.race([
    window.__mdr.app.worker.exportHtml().then((h) => ({ ok: true, len: h.length, head: h.slice(0, 60) })),
    new Promise((r) => setTimeout(() => r({ ok: false, reason: 'TIMEOUT 60s' }), 60000)),
  ]));
  const exp1Ms = Date.now() - t0;
  C.check('(A) exportHtml(2 MB doc) resolves', exp1.ok, exp1);
  C.measure('(A) exportHtml 2 MB: wall ms', exp1Ms, '< 30000', exp1Ms < 30000);
  let lt = await longTasks(page);
  C.measure('(A) exportHtml 2 MB: main-thread long tasks (count/max ms)', `${lt.count}/${lt.max}`, 'max < 200', lt.max < 200);
  C.check('(A) exported HTML contains the document', exp1.ok && exp1.len > 1e6, exp1.len);
  // responsiveness right after
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(500, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; });
  await page.keyboard.type('after export', { delay: 0 });
  let lat = await latencyStats(page);
  C.measure('(A) input latency max right after export (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  s = await settle(page, 180000);
  C.check('(A) settles after export + typing', s.ok, s);

  // ---------------------------------------------------------------- B. two concurrent exportHtml requests
  const both = await page.evaluate(() => Promise.race([
    Promise.all([window.__mdr.app.worker.exportHtml(), window.__mdr.app.worker.exportHtml()]).then(([a, b]) => ({ ok: true, a: a.length, b: b.length, same: a === b })),
    new Promise((r) => setTimeout(() => r({ ok: false, reason: 'TIMEOUT 60s' }), 60000)),
  ]));
  C.check('(B) two concurrent exportHtml calls both resolve', both.ok, both);
  C.check('(B) both exports return the same HTML', both.ok && both.same, both);

  // ---------------------------------------------------------------- C. exportHtml on huge.md (6.6 MB)
  await open(page, '?doc=/test-data/huge.md&mode=split');
  await page.waitForFunction(() => window.__mdr.version() >= 1, null, { timeout: 120000 });
  s = await settle(page, 240000);
  C.check('(C) huge.md settles', s.ok, s);
  await page.evaluate(() => { window.__longTasks.length = 0; });
  t0 = Date.now();
  const exp2 = await page.evaluate(() => Promise.race([
    window.__mdr.app.worker.exportHtml().then((h) => ({ ok: true, len: h.length })),
    new Promise((r) => setTimeout(() => r({ ok: false, reason: 'TIMEOUT 120s' }), 120000)),
  ]));
  const exp2Ms = Date.now() - t0;
  C.check('(C) exportHtml(6.6 MB doc) resolves', exp2.ok, exp2);
  C.measure('(C) exportHtml 6.6 MB: wall ms', exp2Ms, '< 60000', exp2Ms < 60000);
  lt = await longTasks(page);
  C.measure('(C) exportHtml 6.6 MB: main-thread long tasks (count/max ms)', `${lt.count}/${lt.max}`, 'max < 200', lt.max < 200);
  C.check('(C) no worker restart caused by the export (silence detector)', log.restarts === 0, `restarts=${log.restarts}`);
  s = await settle(page, 240000);
  C.check('(C) settles after the big export', s.ok, s);

  // ---------------------------------------------------------------- D. draft autosave of a 6.6 MB doc
  await page.evaluate(() => { window.__wmsgs.draftSaved.length = 0; window.__mdr.app.editor.gotoLine(2, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; });
  await page.keyboard.type('DRAFT-BIG ', { delay: 0 });
  lat = await latencyStats(page);
  C.measure('(D) input latency max on a 6.6 MB doc (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  const saved = await page.evaluate(() => new Promise((res) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (window.__wmsgs.draftSaved.length) { clearInterval(iv); res({ ok: true, ms: Math.round(performance.now() - t0), last: window.__wmsgs.draftSaved.at(-1) }); }
      else if (performance.now() - t0 > 30000) { clearInterval(iv); res({ ok: false, ms: 30000 }); }
    }, 100);
  }));
  C.check('(D) draft of the 6.6 MB document is autosaved', saved.ok, saved);
  C.measure('(D) time from last keystroke to draftSaved (ms)', saved.ms, '< 10000 (debounce 1000)', saved.ms < 10000);
  // worker must still answer immediately after the big draft write
  await page.evaluate(() => { window.__lat.length = 0; });
  await page.keyboard.type('AFTER-DRAFT ', { delay: 0 });
  lat = await latencyStats(page);
  C.measure('(D) input latency max right after the big draft write (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  s = await settle(page, 240000);
  C.check('(D) settles after the big draft write', s.ok, s);

  // ---------------------------------------------------------------- E. checkbox write-back at scale
  await page.evaluate(async () => {
    let t = '';
    for (let i = 0; i < 4000; i++) t += `- [ ] task ${i}\n\n`;
    await window.__mdr.loadText(t, 'tasks.md');
  });
  s = await settle(page, 120000);
  C.check('(E) 4000-task document settles', s.ok, s);
  const before = await page.evaluate(() => window.__mdr.app.editor.getText().split('\n')[0]);
  const clicked = await page.evaluate(() => {
    const cb = document.querySelector('.md-block input[type=checkbox]');
    if (!cb) return { ok: false, reason: 'no checkbox rendered' };
    cb.click();
    return { ok: true };
  });
  C.check('(E) a task checkbox is rendered and clickable', clicked.ok, clicked);
  await sleep(400);
  const after = await page.evaluate(() => window.__mdr.app.editor.getText().split('\n')[0]);
  C.check('(E) clicking the checkbox writes back to the source line', before !== after && /\[x\]/i.test(after), { before, after });
  s = await settle(page, 120000);
  C.check('(E) settles after the write-back', s.ok, s);
  let sc = await structureCheck(page);
  C.check('(E) structure tiles after the write-back', sc.problems.length === 0, sc);

  // ---------------------------------------------------------------- F. restart give-up, then recovery after the window
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  const kill = async () => {
    await page.evaluate(() => { const w = window.__workers.at(-1); w.dispatchEvent(new Event('error')); });
    await sleep(900);
  };
  for (let i = 0; i < 5; i++) await kill();
  const gaveUp = await page.evaluate(() => ({ workers: window.__workers.length, toasts: Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent.trim()) }));
  C.check('(F) the app gives up after > 3 restarts/min (toast)', gaveUp.toasts.some((t) => t.includes('停止自动重启') || t.includes('多次')), gaveUp);
  await page.evaluate(() => { window.__lat.length = 0; window.__mdr.app.editor.gotoLine(1, 0); });
  await page.keyboard.type('still editable ', { delay: 0 });
  lat = await latencyStats(page);
  C.measure('(F) input latency max after the renderer gave up (ms)', lat.max ?? 0, '< 100', (lat.max ?? 0) < 100);
  const txt = await page.evaluate(() => window.__mdr.app.editor.getText().slice(0, 20));
  C.check('(F) the editor keeps accepting edits after give-up', txt.startsWith('still editable'), txt);
  const wBefore = await page.evaluate(() => window.__workers.length);
  console.log('(F) waiting 65 s for the restart window to reopen…');
  await sleep(65000);
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type('nudge', { delay: 0 });
  await sleep(15000);
  const wAfter = await page.evaluate(() => ({ workers: window.__workers.length, pendingVisible: (() => { const r = window.__mdr.app.preview.el.getBoundingClientRect(); let t = 0, p = 0; for (const b of document.querySelectorAll('.md-block')) { const br = b.getBoundingClientRect(); if (br.bottom > r.top && br.top < r.bottom) { t++; if (b.classList.contains('is-pending')) p++; } } return { t, p }; })() }));
  C.check('(F) after the 1-minute window the renderer restarts again (self-healing)', wAfter.workers > wBefore, { wBefore, ...wAfter });
  C.check('(F) preview recovers after the renderer comes back', wAfter.pendingVisible.t > 0 && wAfter.pendingVisible.p === 0, wAfter);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s27 export / draft / task / give-up', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
