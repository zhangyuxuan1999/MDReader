// s20 — under 6× CPU throttling (CDP), does the 10 s "no structure" silence detector fire spuriously
// (restart loop → give-up) while the worker is legitimately busy? Cases: open huge.md (6.6 MB),
// 6 MB paste into medium.md, select-all + delete + undo on huge.md. Also measures time-to-structure.
// Run: node bench/verify/s20_throttled_silence.mjs
import { launch, open, settle, structureCheck, toasts, makeChecker, report, sleep, fetchTestDoc } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const cdp = await page.context().newCDPSession(page);
const RATE = 6;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
try {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  const t0 = Date.now();
  await open(page, '?doc=/test-data/huge.md&mode=split');
  await page.waitForFunction(() => window.__wmsgs.structure >= 1, null, { timeout: 60000 }).catch(() => {});
  const tStruct = Date.now() - t0;
  C.measure(`${RATE}× throttle: open huge.md → first structure (ms)`, tStruct, '< 10000 (silence limit)', tStruct < 10000);
  let s = await settle(page, 300000);
  C.check(`${RATE}× throttle: huge.md settles`, s.ok, s);
  C.check(`${RATE}× throttle: no spurious restart on open`, log.restarts === 0, { restarts: log.restarts, warnings: log.warnings.slice(0, 3) });

  // 6 MB paste
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1000, 0); window.__mdr.app.editor.focus(); });
  const vBefore = await page.evaluate(() => window.__mdr.version());
  const t1 = Date.now();
  await page.evaluate(() => {
    const unit = '## Pasted\n\nparagraph **bold** 中文 `code`\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n';
    let text = ''; while (text.length < 6 * 1024 * 1024) text += unit;
    const view = window.__mdr.app.editor.view;
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, userEvent: 'input.paste' });
  });
  await page.waitForFunction((v) => window.__wmsgs.structure > v, vBefore, { timeout: 60000 }).catch(() => {});
  const tPaste = Date.now() - t1;
  C.measure(`${RATE}× throttle: 6 MB paste → structure (ms)`, tPaste, '< 10000 (silence limit)', tPaste < 10000);
  s = await settle(page, 300000);
  C.check(`${RATE}× throttle: settles after paste`, s.ok, s);
  C.check(`${RATE}× throttle: no spurious restart on paste`, log.restarts === 0, { restarts: log.restarts, warnings: log.warnings.slice(0, 3) });
  let sc = await structureCheck(page);
  C.check('structure tiles after throttled paste', sc.problems.length === 0, sc);

  // select all + delete + undo (13 MB undo under throttle)
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press('Delete');
  await settle(page, 60000);
  const v2 = await page.evaluate(() => window.__mdr.version());
  const t2 = Date.now();
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForFunction((v) => window.__wmsgs.structure > v, v2, { timeout: 60000 }).catch(() => {});
  const tUndo = Date.now() - t2;
  C.measure(`${RATE}× throttle: undo of 13 MB delete → structure (ms)`, tUndo, '< 10000 (silence limit)', tUndo < 10000);
  s = await settle(page, 300000);
  C.check(`${RATE}× throttle: settles after undo`, s.ok, s);
  C.check(`${RATE}× throttle: no spurious restart on undo`, log.restarts === 0, { restarts: log.restarts, warnings: log.warnings.slice(0, 3) });
  sc = await structureCheck(page);
  C.check('structure tiles after throttled undo', sc.problems.length === 0, sc);
  const t = await toasts(page);
  C.check('no restart / give-up toasts', !t.some((x) => /渲染器/.test(x)), t);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
  report('s20 throttled silence', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
