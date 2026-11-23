// s08 — IndexedDB unavailable / broken on the main thread. Variant 1: window.indexedDB undefined.
// Variant 2: indexedDB.open throws. The app must start, load, edit, open the recent-files menu and
// save-state UI without page errors.
// Run: node bench/verify/s08_no_idb.mjs
import { launch, open, settle, structureCheck, latencyStats, toasts, makeChecker, report, sleep } from './_lib.mjs';

const C = makeChecker();
const variants = [
  { name: 'indexedDB undefined', script: `Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });` },
  { name: 'indexedDB.open throws', script: `Object.defineProperty(window, 'indexedDB', { value: { open() { throw new DOMException('IDB down', 'InvalidStateError'); }, deleteDatabase() { throw new Error('IDB down'); } }, configurable: true });` },
];
for (const v of variants) {
  const { browser, page, log } = await launch({ initScript: v.script });
  try {
    await open(page, '?doc=/test-data/small.md&mode=split');
    let s = await settle(page, 60000);
    C.check(`[${v.name}] app loads and settles`, s.ok, s);
    const sc = await structureCheck(page);
    C.check(`[${v.name}] structure tiles`, sc.problems.length === 0, sc);
    await page.evaluate(() => { window.__mdr.app.editor.gotoLine(5, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; });
    await page.keyboard.type('no idb typing ', { delay: 0 });
    const lat = await latencyStats(page);
    C.measure(`[${v.name}] input latency p95 (ms)`, lat.p95, '< 100', lat.p95 < 100);
    s = await settle(page, 60000);
    C.check(`[${v.name}] settles after typing`, s.ok, s);
    // recent-files menu
    await page.click('.mdr-toolbar__file');
    await sleep(300);
    const menu = await page.evaluate(() => document.querySelector('.mdr-recent')?.textContent || '');
    C.check(`[${v.name}] recent menu opens (no crash)`, menu.includes('打开文件') , menu);
    await page.keyboard.press('Escape');
    // new file flow + loadText
    await page.evaluate(async () => { await window.__mdr.loadText('# x\n\ntext', 'x.md'); });
    s = await settle(page, 30000);
    C.check(`[${v.name}] loadText works`, s.ok, s);
    // visibility flush must not throw
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(300);
    const t = await toasts(page);
    C.check(`[${v.name}] no error toasts`, !t.some((x) => /失败|错误/.test(x)), t);
    C.check(`[${v.name}] no console errors`, log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
    C.check(`[${v.name}] no page errors`, log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
    C.check(`[${v.name}] no worker restart`, log.restarts === 0, `restarts=${log.restarts}`);
  } catch (e) {
    C.check(`[${v.name}] script completed`, false, String(e && e.stack || e));
  } finally {
    report(`s08 ${v.name}`, log);
    await browser.close();
  }
}
process.exit(C.failures() ? 1 : 0);
