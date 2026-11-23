// bench/verify/v5-sw-narrow.mjs — verify-switch (round 4 verification): the new toolbar button of 预览可编辑 in narrow
// windows. For each width, both production builds (no ?perf=1, nothing stored) are compared: every toolbar button
// that 0.1.1 shows fully inside the window must still be shown fully inside it on the candidate (the new button may not
// push one out), the toolbar's height, the page's horizontal overflow, and whether the new button itself is reachable.
//   MDR_PORT=<candidate production build> MDR_BASE_PORT=<0.1.1 production build> node bench/verify/v5-sw-narrow.mjs
// Exit 0 when no button 0.1.1 shows is lost, 1 otherwise. Global timeout 110 s. Writes nothing.
import { chromium } from '@playwright/test';
const PORT = process.env.MDR_PORT || 5484, BASE = process.env.MDR_BASE_PORT || 5584;
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const measure = async (browser, port, w) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 20000 }); await sleep(500);
  const r = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-cmd]')].filter((b) => b.closest('[class*="toolbar"]'));
    const vw = document.documentElement.clientWidth;
    const shown = (b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.left >= 0 && r.right <= vw + 0.5; };
    const tb = document.querySelector('[class*="toolbar"]');
    return { shown: btns.filter(shown).map((b) => b.dataset.cmd), all: btns.map((b) => b.dataset.cmd), tbH: Math.round(tb.getBoundingClientRect().height), overflowX: document.documentElement.scrollWidth > vw };
  });
  await ctx.close();
  return r;
};
let lost = 0;
const browser = await chromium.launch({ headless: true });
try {
  for (const w of [320, 360, 414, 480, 560, 640, 768, 900]) {
    const c = await measure(browser, PORT, w), b = await measure(browser, BASE, w);
    const gone = b.shown.filter((id) => !c.shown.includes(id));
    if (gone.length) lost++;
    console.log(`${gone.length ? 'LOST' : 'OK  '}  w=${w}  base shows ${b.shown.length}/${b.all.length} tbH ${b.tbH} ovX ${b.overflowX} | cand shows ${c.shown.length}/${c.all.length} tbH ${c.tbH} ovX ${c.overflowX} switch ${c.shown.includes('view.togglePreviewEdit') ? 'shown' : 'NOT shown'}${gone.length ? `  lost: ${gone.join(',')}` : ''}`);
  }
} finally { clearTimeout(KILL); await browser.close(); }
process.exit(lost ? 1 : 0);
