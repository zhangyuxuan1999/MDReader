// bench/verify/r4-ie-zw.mjs — fix-session-e (0.2.0 stage 2e), B3 side question: which zero-width characters (U+200B,
// U+FEFF) the preview body holds for the audit's document DOC_ALL, on the candidate (MDR_PORT, switch off, and again
// after a session typed in a block and the switch turned off by the toolbar button: the after:typed-button gesture) and
// on 0.1.1 (MDR_BASE_PORT). Prints the count and, for each, its parent element's class chain (e.g. KaTeX's vlist-s strut).
//   MDR_PORT=5468 MDR_BASE_PORT=5478 node bench/verify/r4-ie-zw.mjs
// Starts no server, writes nothing into the tree; global timeout 110 s.
import { chromium } from '@playwright/test';
import { DOC_ALL } from './v5-offc-lib.mjs';
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const where = (page) => page.evaluate(() => {
  const zw = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`, 'g');
  const body = document.querySelector('.mdr-preview__body') || document.querySelector('.mdr-preview');
  const out = [];
  const tw = document.createTreeWalker(body, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const k = (n.data.match(zw) || []).length;
    if (!k) continue;
    const chain = [];
    for (let e = n.parentElement; e && e !== body && chain.length < 4; e = e.parentElement) chain.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(/\s+/)[0] : ''));
    out.push(`${k}x in ${chain.join(' < ')}`);
  }
  return out;
});
async function open(port, base) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/?mode=split${base ? '&perf=1' : ''}`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.evaluate((t) => window.__mdr.loadText(t, 'offc.md'), DOC_ALL);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(600);
  return { browser, page };
}
try {
  const B = await open(Number(process.env.MDR_BASE_PORT || 5478), true);
  console.log('base 0.1.1:', JSON.stringify(await where(B.page)));
  await B.browser.close();
  const C = await open(Number(process.env.MDR_PORT || 5468), false);
  console.log('cand, switch off:', JSON.stringify(await where(C.page)));
  const btn = '[data-cmd="view.togglePreviewEdit"]';
  await C.page.click(btn); await sleep(400);
  const p = await C.page.evaluate(() => { const r = document.createRange(); const w = document.createTreeWalker(document.querySelector('.mdr-preview'), 4); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf('Clickhere'); if (i >= 0) { r.setStart(n, i + 3); r.collapse(true); const b = r.getBoundingClientRect(); return { x: b.left, y: (b.top + b.bottom) / 2 }; } } return null; });
  await C.page.mouse.click(p.x, p.y); await sleep(500);
  await C.page.keyboard.type('XYZ'); await sleep(200);
  console.log('cand, in the session:', JSON.stringify(await where(C.page)));
  await C.page.click(btn); await sleep(800);
  console.log('cand, after the session and the switch off:', JSON.stringify(await where(C.page)));
  await C.browser.close();
} catch (e) { console.log('ERROR', String(e).slice(0, 300)); }
clearTimeout(KILL);
process.exit(0);
