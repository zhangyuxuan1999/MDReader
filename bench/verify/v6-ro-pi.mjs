// bench/verify/v6-ro-pi.mjs — regress-off (stage 2f, round 5): a raw-HTML block holding a processing-instruction-like
// "<?form>" ("<p><?form></p>") makes the preview's sanitizer throw "Illegal invocation" (inside DOMPurify, called by
// src/preview/sanitize.ts sanitizeToFragment); the block is shown empty. Found by bench/verify/v4-tru-diff.mjs seed 1
// (document 10130). Measures the candidate (MDR_PORT, production build or dev server) and 0.1.1 (MDR_BASE_PORT).
//   MDR_PORT=5467 MDR_BASE_PORT=5477 node bench/verify/v6-ro-pi.mjs
// Prints per build: the blocks' text and the page errors. Exit 1 when the candidate shows the block empty or throws.
// Global timeout 100 s. Writes nothing.
import { chromium } from '@playwright/test';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const DOCS = ['before\n\n<p><?form></p>\n\nafter\n', 'before\n\n<p>x <?php echo 1 ?> y</p>\n\nafter\n', 'before\n\n<p>plain raw html</p>\n\nafter\n'];
const builds = [['cand', process.env.MDR_PORT || '5467'], ['base', process.env.MDR_BASE_PORT || '5477']];
const browser = await chromium.launch({ headless: true });
let bad = 0;
try {
  for (const doc of DOCS) {
    for (const [name, port] of builds) {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(String(e && e.message)));
      await page.goto(`http://localhost:${port}/?mode=split&perf=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
      await page.evaluate((t) => window.__mdr.loadText(t, 'pi.md'), doc);
      await page.evaluate(() => window.__mdr.waitIdle());
      await new Promise((r) => setTimeout(r, 600));
      const blocks = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview .md-block')).map((b) => (b.textContent || '').trim()));
      console.log(`${name} ${JSON.stringify(doc)} -> blocks ${JSON.stringify(blocks)} pageErrors ${JSON.stringify(errs)}`);
      if (name === 'cand' && (errs.length || blocks.length !== 3 || blocks[1] === '')) bad++;
      await ctx.close();
    }
  }
} finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
console.log(bad ? `RESULT FAIL ${bad} document(s) not shown on the candidate` : 'RESULT PASS');
process.exitCode = bad ? 1 : 0;
