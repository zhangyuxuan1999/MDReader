// bench/verify/v6-ro-piwait.mjs — regress-off (stage 2f, round 5): extent of the "<?form>" sanitizer throw (see
// bench/verify/v6-ro-pi.mjs). Loads 20 paragraphs with "<div><?form></div>" after the 11th (built here, or the file
// given) into the candidate (MDR_PORT) and 0.1.1 (MDR_BASE_PORT), both opened with ?perf=1 and the switch off, and counts
// the preview blocks shown EMPTY after 4 s, after one edit at the end of the document, and after 全部渲染.
//   MDR_PORT=5467 MDR_BASE_PORT=5477 node bench/verify/v6-ro-piwait.mjs [file.md]
// Global timeout 100 s. Writes nothing.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const built = () => { const a = []; for (let i = 0; i < 20; i++) { a.push('Para ' + i + ' text.'); if (i === 10) a.push('<div><?form></div>'); } return a.join('\n\n') + '\n'; };
const doc = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : built();
const b = await chromium.launch({ headless: true });
try {
  for (const port of [process.env.MDR_PORT || '5467', process.env.MDR_BASE_PORT || '5477']) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e.message)));
    await p.goto(`http://localhost:${port}/?mode=split&perf=1`); await p.waitForFunction(() => !!window.__mdr, null, { timeout: 60_000 });
    await p.evaluate((t) => window.__mdr.loadText(t, 'w.md'), doc); await p.evaluate(() => window.__mdr.waitIdle());
    await new Promise((r) => setTimeout(r, 4000));
    const count = () => p.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview .md-block')).filter((x) => !(x.textContent || '').trim()).length);
    const e1 = await count();
    await p.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: '\nmore typed\n' } }); });
    await p.evaluate(() => window.__mdr.waitIdle()); await new Promise((r) => setTimeout(r, 1500));
    const e2 = await count();
    await p.evaluate(() => window.__mdr.app.registry.run('preview.renderAll')).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const e3 = await count();
    console.log(port, 'empty after 4 s', e1, 'after an edit at the end', e2, 'after renderAll', e3, 'pageErrors', errs.length);
    await ctx.close();
  }
} finally { clearTimeout(KILL); await b.close().catch(() => {}); }
