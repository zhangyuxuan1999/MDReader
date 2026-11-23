// bench/verify/v4-tru-null.mjs — verify-trust: blocks whose HTML DOMPurify cannot sanitize into a fragment (it returns
// null for `<!div>` alone, `<frameset>`): what the preview shows for them, and whether a click on one (预览可编辑 on)
// throws. Runs against the candidate (dev server) or the 0.1.1 dist.
//   MDR_URL=http://localhost:5433/?mode=split node bench/verify/v4-tru-null.mjs
//   MDR_URL='http://localhost:5443/?mode=split&perf=1' node bench/verify/v4-tru-null.mjs
// Writes nothing. Global timeout 100 s.
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL || 'http://localhost:5433/?mode=split';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;
const killer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await browser?.close(); } catch { /* */ } process.exit(3); }, 100_000);
const DOCS = [
  ['bogus-comment-div', 'first paragraph\n\n<!div>\n\nlast paragraph\n'],
  ['frameset', 'first paragraph\n\n<frameset>\n\nlast paragraph\n'],
];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().split('\n')[0]); });
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
  for (const [name, doc] of DOCS) {
    errs.length = 0;
    await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
    await page.evaluate(({ t }) => window.__mdr.loadText(t, 'null.md'), { t: doc });
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(500);
    const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => s.textContent));
    const pt = await page.evaluate(() => {
      for (const s of document.querySelectorAll('.mdr-preview section.md-block')) {
        if (s.textContent !== 'null') continue;
        const b = s.getBoundingClientRect();
        return { x: b.left + 8, y: b.top + b.height / 2 };
      }
      return null;
    });
    let after = null;
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      await sleep(400);
      await page.keyboard.type('Z');
      await sleep(300);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__mdr.waitIdle());
      after = await page.evaluate(() => window.__mdr.app.getText());
    }
    console.log(`${name}: blocks shown ${JSON.stringify(shown)}; after click+Z+Esc source ${JSON.stringify(after)}; errors ${JSON.stringify(errs.slice(0, 3))}`);
  }
} catch (e) {
  console.log('ERROR', e?.stack ?? e);
  process.exitCode = 2;
} finally {
  clearTimeout(killer);
  try { await browser?.close(); } catch { /* */ }
}
