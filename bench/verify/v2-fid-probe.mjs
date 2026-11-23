// bench/verify/v2-fid-probe.mjs — verify-fidelity: click one block of a project document and report
// whether a session starts (and the toast if not). Run: MDR_PORT=5281 MDR_NOSERVER=1 node bench/verify/v2-fid-probe.mjs <doc> <line> [runs]
import { startServer, stopServer, openBrowser, readRoot, sleep } from './inline-verify-lib.mjs';

const T = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 90_000);
const [doc, lineArg, runsArg] = process.argv.slice(2);
const line = Number(lineArg), runs = Number(runsArg ?? 3);
if (process.env.MDR_NOSERVER === '1') process.removeListener('exit', stopServer); else await startServer();
const B = await openBrowser();
const { page } = B;
try {
  await B.boot('mode=split');
  await B.loadDoc(readRoot(doc), 'probe.md');
  const info = await page.evaluate((l) => { const b = window.__mdr.app.preview.blockAtLine(l); return b && { startLine: b.startLine, lineCount: b.lineCount, kind: b.kind }; }, line);
  console.log('block', JSON.stringify(info));
  for (let i = 0; i < runs; i++) {
    await page.evaluate(() => getSelection().removeAllRanges());
    await B.clickLine(line, 'first');
    let ed = null;
    for (let k = 0; k < 20 && !ed; k++) { await sleep(100); ed = await B.editing(); }
    const toast = await page.evaluate(() => document.querySelector('.mdr-toast, [class*="toast"]')?.textContent ?? '');
    const len = await page.evaluate((l) => { const pv = window.__mdr.app.preview; const el = pv.elementOfBlock(pv.blockAtLine(l).id); return el ? el.textContent.length : -1; }, line);
    console.log(`run ${i + 1}: session=${!!ed} toast=${JSON.stringify(toast.trim().slice(0, 40))} blockTextLen=${len}`);
    await B.esc();
  }
} finally {
  await B.browser.close().catch(() => {});
  if (process.env.MDR_NOSERVER !== '1') stopServer();
  clearTimeout(T);
}
