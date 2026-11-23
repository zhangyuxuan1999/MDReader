// s30 — after 4 renderer crashes inside one minute the client latches `gaveUp` forever:
// it never restarts again (even long after RESTART_WINDOW_MS), so preview + draft autosave stay
// dead for the rest of the session. Repro + user-visible consequences.
// Run: node bench/verify/s30_giveup_permanent.mjs
import { launch, open, settle, structureCheck, toasts, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const crash = async () => { await page.evaluate(() => window.__workers.at(-1).dispatchEvent(new Event('error'))); await sleep(1200); };
const draftOf = () => page.evaluate(async () => {
  const { get } = await import('/node_modules/idb-keyval/dist/index.js');
  try { const d = await get('mdr.draft:' + 'untitled'); return d ? { version: d.version, len: d.text.length } : null; } catch (e) { return 'ERR ' + e.message; }
});
try {
  await open(page, '?doc=/test-data/small.md&mode=split');
  let s = await settle(page, 60000);
  C.check('small.md settles', s.ok, s);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__mdr.app.editor.focus(); });

  // (1) spaced-out crashes: 2 crashes ~40 s apart must NOT give up (rate limit is per minute)
  // — skipped for runtime; we go straight to the burst case the spec describes.
  for (let i = 0; i < 4; i++) await crash();
  let st = await page.evaluate(() => ({ workers: window.__workers.length, toasts: Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent.trim()) }));
  C.check('4 crashes in a minute → give-up toast (spec: ≤ 3 restarts/min)', st.toasts.some((t) => t.includes('停止自动重启')), st);
  C.check('give-up toast offers no recovery action (no 重新加载 / 重试 button)',
    (await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast button')).map((b) => b.textContent.trim()))).filter((t) => t !== '×').length === 0,
    await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast button')).map((b) => b.textContent.trim())));
  const workersAfterGiveUp = st.workers;

  // consequence 1: typing is never reflected in the preview again
  const v0 = await page.evaluate(() => window.__wmsgs.structure);
  await page.keyboard.type('AFTER-GIVEUP-MARKER ', { delay: 0 });
  await sleep(3000);
  const seen = await page.evaluate(() => ({
    structure: window.__wmsgs.structure,
    previewHasIt: Array.from(document.querySelectorAll('.md-block')).some((b) => b.textContent.includes('AFTER-GIVEUP-MARKER')),
    editorHasIt: window.__mdr.app.editor.getText().includes('AFTER-GIVEUP-MARKER'),
    status: document.querySelector('.mdr-statusbar')?.textContent.trim(),
  }));
  C.check('after give-up the editor still accepts edits', seen.editorHasIt, seen);
  C.check('DEFECT: after give-up the preview never shows new edits', seen.previewHasIt === false, seen);
  C.check('DEFECT: no further structure messages arrive after give-up', seen.structure === v0, { v0, now: seen.structure });

  // consequence 2: draft autosave (worker-side) stops — unsaved work has no backup
  await sleep(3000);
  const d = await draftOf();
  C.check('DEFECT: draft autosave stops after give-up (worker writes the draft)', d === null || (d && typeof d === 'object' && !String(d.len).includes('AFTER')), d);

  // (2) the sliding window never reopens: wait past RESTART_WINDOW_MS (60 s) and edit again
  console.log('waiting 70 s past the 60 s restart window…');
  await sleep(70000);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type('nudge-after-window ', { delay: 0 });
  await sleep(20000);      // > SILENCE_MS (10 s): the silence detector would restart a non-latched client
  const st2 = await page.evaluate(() => ({
    workers: window.__workers.length,
    structure: window.__wmsgs.structure,
    previewHasIt: Array.from(document.querySelectorAll('.md-block')).some((b) => b.textContent.includes('nudge-after-window')),
  }));
  C.check('DEFECT: 70 s after give-up (window expired) an edit still does not restart the renderer',
    st2.workers === workersAfterGiveUp, { workersAfterGiveUp, ...st2 });
  C.check('DEFECT: preview is still dead 90 s after give-up', st2.previewHasIt === false, st2);

  // a reload is the only recovery
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 60000 });
  await sleep(1500);
  const after = await page.evaluate(() => ({ workers: window.__workers.length }));
  C.check('only a full page reload brings the renderer back', after.workers >= 1, after);

  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s30 give-up is permanent', log);
  await browser.close();
  process.exit(0);
}
