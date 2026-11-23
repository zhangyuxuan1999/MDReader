// bench/verify/v3-app-large.mjs — verify-app (0.2.0 stage 2c): test-data/large.md (≈102 000 lines). In-preview
// session typing at the top / middle / end (40 keys, 10 ms apart, then Enter + 10 keys): no key lost, the text
// lands in the clicked block, nothing else changes; then ⌘S-equivalent reader (getText) and a TOC-free scroll.
// The document is loaded through window.__mdr.loadText (works on every renderer with hooks).
// Needs a renderer on MDR_PORT (candidate: npx vite --port 5383 --strictPort). Writes nothing into the tree.
// Run: MDR_PORT=5383 node bench/verify/v3-app-large.mjs
import { readFileSync } from 'node:fs';
import { openBrowser, step, assert, finish, sleep, ROOT } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();   // starts vite on MDR_PORT when nothing answers there (stopped at exit)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const B = await openBrowser();
const { page } = B;
const TEXT = readFileSync(`${ROOT}/test-data/large.md`, 'utf8');
let lines = TEXT.split('\n');
/** First plain paragraph line (letters, no markup) at or after `from`. */
const paraAt = (from) => {
  for (let i = from; i < lines.length - 2; i++) {
    const l = lines[i];
    if (l.startsWith('这是一个用于性能测试的段落') && (i === 0 || lines[i - 1] === '') && lines[i + 1] === '') return i + 1;
  }
  return -1;
};

try {
  await B.boot('mode=split');
  await page.evaluate((t) => window.__mdr.loadText(t, 'large.md'), TEXT);
  await page.waitForFunction(() => window.__mdr.app.editor.view.state.doc.lines > 100000, null, { timeout: 60_000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(800);
  for (const [name, from] of [['top', 0], ['middle', Math.floor(lines.length / 2)], ['end', lines.length - 400]]) {
    lines = (await page.evaluate(() => window.__mdr.app.getText())).split('\n');
    const line = paraAt(from);
    await step(`large ${name}: session at line ${line}, 40 keys + Enter + 10 keys: all there, nothing else changed`, async () => {
      assert(line > 0, 'no paragraph found');
      const before = await page.evaluate(() => window.__mdr.app.getText());
      const t0 = Date.now();
      await B.clickLine(line, 'last');
      await sleep(200);
      assert(await B.editing(), 'no session');
      await B.caretEnd();
      const keys = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
      await page.keyboard.type(keys, { delay: 10 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('NEWPARA123', { delay: 10 });
      await B.settle(600);
      await B.esc();
      await page.evaluate(() => window.__mdr.waitIdle());
      const after = await page.evaluate(() => window.__mdr.app.getText());
      const want = before.split('\n');
      want[line - 1] = want[line - 1] + keys + '\n\nNEWPARA123';
      const w = want.join('\n');
      if (after !== w) {
        const a = after.split('\n'); const b = w.split('\n');
        let i = 0; while (i < a.length && a[i] === b[i]) i++;
        throw new Error(`differs at line ${i + 1}: got ${JSON.stringify(a.slice(i, i + 3))} want ${JSON.stringify(b.slice(i, i + 3))}`);
      }
      return `${Date.now() - t0} ms`;
    });
  }
} finally {
  console.log('pageErrors', JSON.stringify(B.pageErrors.slice(0, 5)));
  finish();
  await B.browser.close().catch(() => {});
  clearTimeout(KILL);
}
