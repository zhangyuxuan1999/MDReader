// bench/verify/fix2-int-afterload.mjs — integrator (stage 2b): a click on the preview right after a new
// document was loaded, when the previous document's last preview write happened less than a second before.
// U7: the click is resolved against a structure that describes the CURRENT source; a write of the old
// document is never "on its way" in the new one, so the click must start a session at once.
// Run: MDR_PORT=5320 node bench/verify/fix2-int-afterload.mjs   (own Vite on MDR_PORT, killed at exit)
import { readFileSync } from 'node:fs';
import { startServer, stopServer, openBrowser, check, sleep, finish } from './inline-verify-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
await startServer();
const B = await openBrowser();
const { page } = B;
try {
  await B.boot('mode=split');
  // MDR_DOC=test-data/small.md MDR_LINES=555,568 : edit the block at the first line, click the second.
  const doc = process.env.MDR_DOC ? readFileSync(new URL(`../../${process.env.MDR_DOC}`, import.meta.url), 'utf8')
    : ['# 标题', '', '第一段落文字 alpha。', '', '第二段落文字 beta。', '', '第三段落文字 gamma。', ''].join('\n');
  const [L1, L2] = (process.env.MDR_LINES ?? '3,5').split(',').map(Number);
  for (let round = 0; round < 4; round++) {
    await B.loadDoc(doc, 'a.md');
    await B.clickLine(L1, 'first');
    await B.caretEnd();
    await page.keyboard.type('X');
    await sleep(200);
    await B.esc();
    await sleep(100);
    const vBefore = await page.evaluate(() => window.__mdr.app.preview.structureVersion?.() ?? null);
    await B.loadDoc(doc, 'b.md');
    const vAfter = await page.evaluate(() => window.__mdr.app.preview.structureVersion?.() ?? null);
    const pt = await B.textPoint(L2, 'first');
    await page.mouse.click(pt.x, pt.y);
    let ed = false;
    for (let i = 0; i < 4 && !ed; i++) { await sleep(50); ed = !!(await B.editing()); }
    check(`round ${round}: a click right after the new document loaded starts a session within 200 ms`, ed, `structureVersion before ${vBefore} after ${vAfter}`);
    await B.esc();
  }
} catch (e) {
  check('script', false, e.message);
} finally {
  clearTimeout(KILL);
  finish();
  await B.close?.();
  stopServer();
  process.exit(0);
}
