// bench/verify/v4-flow-probe-filestype.mjs — verify-flows (round-3 re-verification), print-only probe: a TEXT drag
// whose DataTransfer also advertises the type "Files" with an empty file list (CDP item mimeType 'Files').
// Prints what the candidate (5434) and the 0.1.1 baseline (5444) do with it. No assertion.
//   node bench/verify/v4-flow-probe-filestype.mjs      (both servers running; writes nothing; 60 s timeout)
import { chromium } from '@playwright/test';
const timer = setTimeout(() => { console.log('timeout'); process.exit(2); }, 60000);
const b = await chromium.launch({ headless: true });
try {
  for (const url of [process.env.MDR_URL || 'http://localhost:5434/', process.env.MDR_BASE_URL || 'http://localhost:5444/?perf=1']) {
    const p = await b.newPage();
    await p.goto(url);
    await p.waitForFunction(() => !!window.__mdr?.app, null, { timeout: 20000 });
    await p.evaluate(() => window.__mdr.app.loadText('first line\n', 'x.md'));
    await p.waitForTimeout(600);
    await p.evaluate(() => { window.__types = []; window.addEventListener('drop', (e) => window.__types.push([...e.dataTransfer.types], e.dataTransfer.files.length), true); });
    const pt = await p.evaluate(() => { const c = window.__mdr.app.editor.view.coordsAtPos(3); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; });
    const cdp = await p.context().newCDPSession(p);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data: { items: [{ mimeType: 'Files', data: '' }, { mimeType: 'text/plain', data: 'MAILTEXT' }], dragOperationsMask: 1 | 2 | 16 } });
    await p.waitForTimeout(800);
    console.log(url, JSON.stringify(await p.evaluate(() => ({ types: window.__types, text: window.__mdr.app.getText(), toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent) }))));
  }
} finally {
  clearTimeout(timer);
  await b.close();
}
