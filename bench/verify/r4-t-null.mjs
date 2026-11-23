// bench/verify/r4-t-null.mjs — fix-trust r4, J23: the block DOMPurify cannot turn into a fragment shows nothing; a click
// on its place (预览可编辑 on) and a typed Z change no source and throw nothing.
//   MDR_URL='http://localhost:5463/?mode=split' node bench/verify/r4-t-null.mjs
// Writes nothing into the tree. Global timeout 90 s.
import { chromium } from '@playwright/test';
const URL0 = process.env.MDR_URL || 'http://localhost:5463/?mode=split';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 90_000);
const DOCS = [
  ['bogus-comment-div', 'first paragraph\n\n<!div>\n\nlast paragraph\n'],
  ['frameset', 'first paragraph\n\n<frameset>\n\nlast paragraph\n'],
];
let fails = 0;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]));
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  for (const [name, doc] of DOCS) {
    errs.length = 0;
    await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
    await page.evaluate(({ t }) => window.__mdr.loadText(t, 'null.md'), { t: doc });
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(400);
    const info = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('.mdr-preview section.md-block'))[1];
      const b = s.getBoundingClientRect();
      return { text: s.textContent, h: b.height, x: b.left + 8, y: b.top + Math.max(1, b.height / 2), html: s.innerHTML };
    });
    // a block of height 0 has no place to click (a click there would land on the paragraph below it)
    if (info.h > 0) {
      await page.mouse.click(info.x, info.y);
      await sleep(300);
      await page.keyboard.type('Z');
      await sleep(300);
      await page.keyboard.press('Escape');
    }
    await page.evaluate(() => window.__mdr.waitIdle());
    const after = await page.evaluate(() => window.__mdr.app.getText());
    const ok = info.text === '' && after === doc && errs.length === 0;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: block text ${JSON.stringify(info.text)} (height ${info.h}); after ${info.h > 0 ? 'click+Z' : 'no click (nothing to click)'} source ${after === doc ? 'unchanged' : JSON.stringify(after)}; errors ${JSON.stringify(errs.slice(0, 2))}`);
  }
  process.exitCode = fails ? 1 : 0;
} catch (e) { console.log('ERROR', e?.stack ?? e); process.exitCode = 2; } finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
