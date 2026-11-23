// bench/verify/r6-fr-hookcheck.mjs — fix-refs (stage 2g): checks that r6-fr-guardhook.mjs sees a guard firing. A block
// whose untouched serialization reveals a character (raw HTML <code>&shy;</code>) is clicked: the session start is
// refused (toast) and the hook must count one. Run: MDR_PORT=5461 node --import ./bench/verify/r6-fr-guardhook.mjs bench/verify/r6-fr-hookcheck.mjs
import { chromium } from '@playwright/test';
const port = process.env.MDR_PORT;
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 60000);
const browser = await chromium.launch({ headless: true });
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.evaluate(() => window.__mdr.loadText('# H\n\nFirst <code>a&shy;b</code> words here\n', 'c.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.waitForTimeout(800);
  const at = await page.evaluate(() => { const tw = document.createTreeWalker(window.__mdr.app.preview.el, 4); for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('words'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } } return null; });
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(500);
  const editing = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
  const stats = await page.evaluate(async () => ({ ...(await import('/src/preview/inlineEdit.ts')).writeGuardStats, fid: (await import('/src/preview/fidelity.ts')).fidelityStats().refusals, toast: Array.from(document.querySelectorAll('[class*=toast]')).map((e) => e.textContent).join('|'), html: document.querySelector('.md-block p code')?.outerHTML }));
  ok = !editing && stats.toast.includes('此块请在源码中编辑');   // (the hook's R6FR-GUARD line must say starts=1: the module the page imports here may be another instance)
  console.log(`editing=${editing} stats=${JSON.stringify(stats)}`);
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
