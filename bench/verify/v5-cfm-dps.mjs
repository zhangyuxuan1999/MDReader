// bench/verify/v5-cfm-dps.mjs — confirm (0.2.0 r4): SW-1 on a PRODUCTION build without test hooks.
// The candidate page (no ?perf=1, nothing stored = switch off) gets a paragraph typed into the editor, the switch is
// turned on by Cmd-Shift-E, a click in the preview starts a session, Esc ends it, Cmd-Shift-E turns the switch off.
// Prints document.queryCommandValue('defaultParagraphSeparator') before and after, and the same for 0.1.1 after the
// same typing and click. MDR_PORT = candidate dist (vite preview), MDR_BASE_PORT = 0.1.1 dist. Global timeout 90 s.
import { chromium } from '@playwright/test';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 90_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const out = {};
try {
  for (const [nm, port] of [['cand', process.env.MDR_PORT], ['base', process.env.MDR_BASE_PORT]]) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}/?mode=split`);
    await page.waitForSelector('.cm-content');
    await sleep(500);
    await page.click('.cm-content');
    await page.keyboard.type('Clickhere paragraph words for the session.');
    await sleep(800);
    const before = await page.evaluate(() => document.queryCommandValue('defaultParagraphSeparator'));
    const pressed0 = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
    if (nm === 'cand') { await page.keyboard.press('Meta+Shift+KeyE'); await sleep(300); }
    const pressed1 = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
    const r = await page.evaluate(() => { const p = document.querySelector('.mdr-preview p'); const b = p.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; });
    await page.mouse.click(r.x, r.y); await sleep(500);
    const session = await page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
    const during = await page.evaluate(() => document.queryCommandValue('defaultParagraphSeparator'));
    await page.keyboard.press('Escape'); await sleep(300);
    if (nm === 'cand') { await page.keyboard.press('Meta+Shift+KeyE'); await sleep(400); }
    const pressed2 = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
    const after = await page.evaluate(() => document.queryCommandValue('defaultParagraphSeparator'));
    out[nm] = { before, pressed0, pressed1, session, during, pressed2, after };
    await ctx.close();
  }
  console.log(JSON.stringify(out));
  console.log(out.cand.after === out.base.after ? 'SAME' : `DIFF cand.after=${out.cand.after} base.after=${out.base.after}`);
} finally {
  clearTimeout(KILL);
  await browser.close();
}
