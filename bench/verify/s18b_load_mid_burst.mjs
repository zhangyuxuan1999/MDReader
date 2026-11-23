// s18b — isolate the s18 anomaly: loadText(large.md) fired 600 ms into a keyboard burst on medium.md
// left the editor holding medium.md + keystrokes while the DOM had 13568 empty wrappers vs a 6002-block
// model. Samples editor length / version / model blocks / DOM wrappers every 150 ms, records the
// loadText promise outcome, toasts and dialogs. Run: node bench/verify/s18b_load_mid_burst.mjs
import { launch, open, settle, structureCheck, toasts, makeChecker, report, sleep, fetchTestDoc, loadText } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
page.on('dialog', (d) => { console.log('DIALOG', d.type(), d.message()); d.dismiss().catch(() => {}); });
const snap = () => page.evaluate(() => ({
  t: Math.round(performance.now()), len: window.__mdr.app.editor.getText().length, v: window.__mdr.version(),
  blocks: window.__mdr.app.preview.blockCount(), dom: document.querySelectorAll('.md-block').length,
  structure: window.__wmsgs.structure, idle: window.__wmsgs.idle, load: window.__loadState, file: document.querySelector('[data-stat=file]')?.textContent,
}));
try {
  await open(page, '?mode=split');
  await settle(page, 30000);
  const medium = await fetchTestDoc('medium.md');
  const large = await fetchTestDoc('large.md');
  await loadText(page, medium, 'medium.md');
  await settle(page, 60000);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(500, 0); ed.focus(); });
  await page.evaluate((large) => {
    window.__loadState = 'scheduled';
    let n = 0;
    // fire the load synchronously inside the 100th keydown (Playwright types faster than any timer)
    window.addEventListener('keydown', () => {
      if (++n !== 100) return;
      window.__loadState = 'called len=' + window.__mdr.app.editor.getText().length + ' v=' + window.__mdr.version();
      window.__mdr.loadText(large, 'large-mid-burst.md').then(() => { window.__loadState += ' → resolved len=' + window.__mdr.app.editor.getText().length + ' v=' + window.__mdr.version(); }, (e) => { window.__loadState += ' → REJECTED ' + String(e && e.stack || e); });
    }, true);
  }, large);
  const samples = [];
  const sampler = (async () => { for (let i = 0; i < 30; i++) { samples.push(await snap()); await sleep(150); } })();
  await page.keyboard.type('typing '.repeat(60), { delay: 0 });
  await sampler;
  const s = await settle(page, 120000);
  await sleep(1500);
  const final = await snap();
  for (const x of samples) console.log(JSON.stringify(x));
  console.log('FINAL', JSON.stringify(final));
  console.log('toasts', await toasts(page));
  const sc = await structureCheck(page);
  C.check('loadText resolved', /resolved/.test(final.load || ''), final.load);
  C.check('editor holds large.md (+ keystrokes typed after the load)', final.len >= large.length, { len: final.len, large: large.length, medium: medium.length });
  // Chunks far from the materialization window are dormant and hold no wrapper at all (P13 fix), so
  // wrapper count == block count is no longer an invariant; only the bound is.
  C.check('wrappers exist for the window and never exceed the model', sc.domBlocks > 0 && sc.domBlocks <= sc.blocks, sc);
  const after = await page.evaluate(async () => { await window.__mdr.app.preview.mountAll(); await new Promise((r) => setTimeout(r, 200)); return { blocks: window.__mdr.app.preview.blockCount(), dom: document.querySelectorAll('.md-block').length, empty: Array.from(document.querySelectorAll('.md-block')).filter((b) => b.innerHTML === '').length }; });
  C.check('after mountAll: DOM wrappers == model blocks and none empty', after.dom === after.blocks && after.empty === 0, after);
  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s18b load mid burst', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
