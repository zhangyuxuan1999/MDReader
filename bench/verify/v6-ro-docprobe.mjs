// bench/verify/v6-ro-docprobe.mjs — regress-off (stage 2f, round 5): open one Markdown file in a build through the test
// hook (window.__mdr.loadText), switch 预览可编辑 off (stored "0" before start), and print per source block whether the
// preview shows it (its text), plus every page error. For comparing the candidate with 0.1.1 on one document.
//   node bench/verify/v6-ro-docprobe.mjs <file.md> <url> [<url> ...]     (a production build needs ?perf=1 in the url)
// Exit 1 when a page error was thrown on any url. Global timeout 100 s. Writes nothing.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const [file, ...urls] = process.argv.slice(2);
const doc = readFileSync(file, 'utf8');
const browser = await chromium.launch({ headless: true });
let bad = 0;
try {
  for (const url of urls) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e && e.message)));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
    await page.evaluate((t) => window.__mdr.loadText(t, 'probe.md'), doc);
    await page.evaluate(() => window.__mdr.waitIdle());
    await new Promise((r) => setTimeout(r, 1000));
    const r = await page.evaluate(() => {
      const bl = Array.from(document.querySelectorAll('.mdr-preview .md-block'));
      return { n: bl.length, blocks: bl.map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90)), src: window.__mdr.app.getText().length };
    });
    console.log(`${url}\n  blocks ${r.n}: ${JSON.stringify(r.blocks)}\n  pageErrors ${errs.length}: ${JSON.stringify(errs.slice(0, 4))}`);
    if (errs.length) bad++;
    await ctx.close();
  }
} finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
process.exitCode = bad ? 1 : 0;
