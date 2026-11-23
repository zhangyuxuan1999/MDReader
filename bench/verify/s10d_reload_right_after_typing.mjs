// s10d — reload mid-edit BEFORE the 1 s draft debounce has fired: type, wait 3 s (draft A saved),
// type more, reload 150 ms later. The visibilitychange→hidden flush (SPEC §8) should persist the
// last keystrokes; check what the restored draft contains. Also: close the tab (page.close) variant
// using a second page in the same context. Run: node bench/verify/s10d_reload_right_after_typing.mjs
import { BASE, launch, open, settle, toasts, makeChecker, report, sleep } from './_lib.mjs';

const { browser, context, page, log } = await launch();
const C = makeChecker();
async function restoreAndRead(p) {
  await p.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 30000 });
  await sleep(800);
  const t = await p.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).map((x) => x.textContent.trim()));
  const btn = p.locator('.mdr-toast__btn', { hasText: '恢复' });
  if (!(await btn.count())) return { toasts: t, text: null };
  await btn.first().click();
  await sleep(300);
  return { toasts: t, text: await p.evaluate(() => window.__mdr.app.editor.getText()) };
}
try {
  // Variant 1: reload
  await open(page, '?mode=split');
  await settle(page, 30000);
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type('# Draft\n\nfirst part saved ', { delay: 0 });
  await sleep(3000);
  const savedV = await page.evaluate(() => window.__wmsgs.draftSaved.slice(-1)[0]);
  C.check('draft A saved after 3 s', !!savedV, savedV);
  await page.keyboard.type('LAST-WORDS', { delay: 0 });
  const full = await page.evaluate(() => window.__mdr.app.editor.getText());
  await sleep(150);
  await page.reload({ waitUntil: 'load' });
  const r = await restoreAndRead(page);
  C.check('reload 150 ms after typing: draft offered', r.text !== null, r.toasts);
  C.check('reload 150 ms after typing: restored draft includes the last keystrokes (flush on hide)', r.text === full, { restored: r.text, expected: full });

  // Variant 2: close the tab 150 ms after typing, reopen in a new page
  const p2 = await context.newPage();
  await p2.goto(BASE + '?mode=split', { waitUntil: 'load' });
  await p2.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 30000 });
  await sleep(800);
  const discard = p2.locator('.mdr-toast__btn', { hasText: '丢弃' });
  if (await discard.count()) await discard.first().click();
  await sleep(300);
  await p2.evaluate(() => window.__mdr.app.editor.focus());
  await p2.keyboard.type('# Tab close\n\nsaved part ', { delay: 0 });
  await sleep(3000);
  await p2.keyboard.type('CLOSE-WORDS', { delay: 0 });
  const full2 = await p2.evaluate(() => window.__mdr.app.editor.getText());
  await sleep(150);
  await p2.close({ runBeforeUnload: false });
  const p3 = await context.newPage();
  await p3.goto(BASE + '?mode=split', { waitUntil: 'load' });
  const r2 = await restoreAndRead(p3);
  C.check('tab closed 150 ms after typing: draft offered', r2.text !== null, r2.toasts);
  C.check('tab closed 150 ms after typing: restored draft includes the last keystrokes', r2.text === full2, { restored: r2.text, expected: full2 });
  await p3.close();

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s10d reload right after typing', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
