// bench/verify/r5-fl-probe-palette.mjs — fix-lazy: a probe of review-lazy's older observation (no session after the
// palette was used to toggle 预览可编辑 three times). Real user, production build, stored '0', no route.
//   MDR_URL=http://localhost:5474/ node bench/verify/r5-fl-probe-palette.mjs [n-palette]
import { chromium } from '@playwright/test';
const BASE = (process.env.MDR_URL || 'http://localhost:5474/').replace(/\/?$/, '/');
const N = Number(process.argv[2] || 3);
const HOLD = process.argv.includes('hold');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 60_000);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(() => { try { if (!sessionStorage.getItem('p')) { sessionStorage.setItem('p', '1'); localStorage.setItem('mdr.previewEdit', '0'); } } catch { /* */ } });
  const page = await context.newPage();
  let release = () => {}; const gate = new Promise((r) => { release = r; });
  if (HOLD) await page.route('**/assets/inlineEdit-*.js', async (r) => { await gate; await r.continue(); });
  await page.goto(BASE);
  await page.waitForSelector('.cm-content');
  await page.click('.cm-content');
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(['# P', '', ...Array.from({ length: Number(process.env.PARAS || 20) }, (_, i) => `Para ${i + 1} text of the probe, long enough to wrap a little.` + NL)].join(NL));
  await sleep(900);
  for (let i = 0; i < N; i++) {
    await page.click('.cm-content');
    await page.keyboard.press('Meta+Shift+P');
    await page.waitForSelector('.mdr-palette__input', { timeout: 3000 });
    await page.keyboard.insertText('预览可编辑');
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(200);
  }
  release();
  await page.waitForFunction(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 8000 }).catch(() => {});
  if (!process.env.NORESET) await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(400);
  console.log('preview scrollTop', await page.evaluate(() => document.querySelector('.mdr-preview').scrollTop), 'editor scrollTop', await page.evaluate(() => document.querySelector('.cm-scroller').scrollTop));
  const st = await page.evaluate(() => ({ pressed: document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'), active: document.activeElement?.className, palette: !!document.querySelector('.mdr-palette__input'), paletteVisible: document.querySelector('.mdr-palette') ? getComputedStyle(document.querySelector('.mdr-palette')).display : null }));
  console.log('after palette', JSON.stringify(st));
  const pt = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('Para 9 text'));
    const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3); const b = r.getBoundingClientRect();
    const x = b.left + 1, y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit?.tagName + '.' + (hit?.className || ''), hitInPara: p.contains(hit) };
  });
  console.log('click point', JSON.stringify(pt));
  const events = [];
  await page.exposeFunction('logEv', (s) => events.push(s));
  await page.evaluate(() => { for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click', 'focusin', 'focusout']) document.addEventListener(t, (e) => window.logEv(`${t}:${e.target?.tagName}.${(e.target?.className || '').toString().slice(0, 30)}`), true); });
  for (let k = 0; k < 2; k++) {
    await page.mouse.click(pt.x, pt.y);
    await sleep(500);
    const s = await page.evaluate(() => ({ editing: document.querySelectorAll('.mdr-preview .is-editing').length, active: document.activeElement?.tagName + '.' + document.activeElement?.className, sel: String(getSelection()?.anchorNode?.textContent ?? '').slice(0, 20) }));
    console.log(`click ${k + 1}`, JSON.stringify(s));
  }
  console.log('events', events.join(' | '));
  await context.close();
} finally { clearTimeout(KILL); await browser.close(); }
