// bench/verify/v5-offp-u24.mjs — verify-off-preview: U24 (J13) with 预览可编辑 OFF, variations the activation probe did
// not use, the candidate and 0.1.1 side by side:
//   grid-<cfg>: a 9 x 9 grid of fractional points over the task box (its rect grown by 1.5 px), at device scale factor
//     1.5, CSS zoom 0.5 / 3, touch taps (hasTouch, with and without isMobile); per point: is the box under it
//     (elementFromPoint) and did the click toggle the source. Every point with the box under it must toggle in both.
//   focus-space: a click on the text of a label that wraps a task (forwarded: refused, the label focuses the box), then
//     a real click on that box (ticks), then Space on the focused box (0.1.1: a second toggle).
//   MDR_PORT=5485 MDR_BASE_PORT=5495 MDR_CAND_PERF=1 node bench/verify/v5-offp-u24.mjs [grid|focus-space|<cfg>]
// Global timeout 115 s. Writes nothing into the tree.
import { chromium } from '@playwright/test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const only = process.argv.slice(2);
const want = (nm) => !only.length || only.some((o) => nm.startsWith(o));
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115000);
const DOC = [
  'Intro paragraph.', '',
  '- [ ] alpha task', '- [ ] beta task', '',
  '- <label>label words here', '  - [ ] wrapped task', '  </label>', '',
  'End.', '',
].join('\n');
const browsers = [];
async function open(kind, ctxOpts) {
  const port = kind === 'cand' ? process.env.MDR_PORT : process.env.MDR_BASE_PORT;
  const perf = kind === 'base' || process.env.MDR_CAND_PERF;
  const b = await chromium.launch({ headless: true }); browsers.push(b);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: 'light', ...ctxOpts });
  await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/?mode=split${perf ? '&perf=1' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await sleep(300);
  await page.evaluate(() => { for (const h of document.querySelectorAll('.mdr-perf')) h.style.display = 'none'; });
  if (kind === 'cand') {
    const pr = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
    if (pr === 'true') throw new Error('switch on');
  }
  return { b, page };
}
async function load(page, zoom) {
  await page.evaluate((t) => window.__mdr.loadText(t, 'u24.md'), DOC);
  await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
  if (zoom) await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
  await sleep(200);
}
const src = (p) => p.evaluate(() => window.__mdr.app.getText());

async function grid(kind, cfg) {
  const ctxOpts = cfg.dsf ? { deviceScaleFactor: cfg.dsf } : cfg.touch ? { hasTouch: true, isMobile: !!cfg.mobile, deviceScaleFactor: cfg.mobile ? 2 : 1 } : {};
  const { page } = await open(kind, ctxOpts);
  await load(page, cfg.zoom);
  const res = [];
  const N = 9;
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
    const q = await page.evaluate(([ix, iy, N]) => {
      const b = Array.from(document.querySelectorAll('.mdr-preview li input[type=checkbox]')).find((x) => x.closest('li').textContent.includes('beta'));
      const r = b.getBoundingClientRect();
      // CSS zoom: getBoundingClientRect is in zoomed CSS px already in Chromium 128+
      const x = r.left - 1.5 + (r.width + 3) * ix / (N - 1), y = r.top - 1.5 + (r.height + 3) * iy / (N - 1);
      const hit = document.elementFromPoint(x, y) === b;
      return { x, y, hit };
    }, [ix, iy, N]);
    const before = await src(page);
    if (cfg.touch) await page.touchscreen.tap(q.x, q.y); else await page.mouse.click(q.x, q.y);
    await sleep(120); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(60);
    const after = await src(page);
    const beta = (s) => s.split('\n').find((l) => l.includes('beta'));
    res.push((q.hit ? 'H' : '.') + (beta(before) !== beta(after) ? 'T' : (before !== after ? 'W' : '-')));
  }
  return res;
}

async function focusSpace(kind) {
  const { page } = await open(kind, {});
  await load(page);
  const steps = [];
  const line = async () => (await src(page)).split('\n').find((l) => l.includes('wrapped'));
  // 1: click on the label's text (forwarded to the wrapped task's box)
  const lt = await page.evaluate(() => { const l = document.querySelector('.mdr-preview label'); const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3); const q = r.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; });
  await page.mouse.click(lt.x, lt.y); await sleep(400);
  steps.push(['label-click', await line(), await page.evaluate(() => document.activeElement?.tagName)]);
  // 2: a real click on the wrapped task's own box
  const bx = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-preview li input[type=checkbox]')).find((x) => x.closest('li').textContent.includes('wrapped')); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(bx.x, bx.y); await sleep(400);
  steps.push(['box-click', await line(), await page.evaluate(() => document.activeElement?.tagName)]);
  // 3: Space on the focused box
  await page.keyboard.press('Space'); await sleep(500); await page.evaluate(() => window.__mdr.waitIdle());
  steps.push(['space', await line(), await page.evaluate(() => document.activeElement?.tagName)]);
  // 4: Tab away and Shift+Tab back, Space again
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await sleep(100);
  await page.keyboard.press('Space'); await sleep(500); await page.evaluate(() => window.__mdr.waitIdle());
  steps.push(['tab-back-space', await line(), await page.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement?.closest?.('li')?.textContent || '').trim().slice(0, 14))]);
  return steps;
}

// The same with the box focused by the keyboard first (Tab: here focus()), so the refused label click finds it focused.
async function focusSpaceTab(kind) {
  const { page } = await open(kind, {});
  await load(page);
  const steps = [];
  const line = async () => (await src(page)).split('\n').find((l) => l.includes('wrapped'));
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-preview li input[type=checkbox]')).find((x) => x.closest('li').textContent.includes('wrapped')); b.focus(); });
  steps.push(['focused', await page.evaluate(() => document.activeElement?.tagName)]);
  const lt = await page.evaluate(() => { const l = document.querySelector('.mdr-preview label'); const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3); const q = r.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; });
  await page.mouse.click(lt.x, lt.y); await sleep(400);
  steps.push(['label-click', await line(), await page.evaluate(() => document.activeElement?.tagName)]);
  const bx = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.mdr-preview li input[type=checkbox]')).find((x) => x.closest('li').textContent.includes('wrapped')); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(bx.x, bx.y); await sleep(400);
  steps.push(['box-click', await line(), await page.evaluate(() => document.activeElement?.tagName)]);
  await page.keyboard.press('Space'); await sleep(500); await page.evaluate(() => window.__mdr.waitIdle());
  steps.push(['space', await line(), await page.evaluate(() => document.activeElement?.tagName)]);
  await page.keyboard.press('Space'); await sleep(500); await page.evaluate(() => window.__mdr.waitIdle());
  steps.push(['space2', await line()]);
  return steps;
}

const CFGS = { 'dsf1.5': { dsf: 1.5 }, 'zoom0.5': { zoom: 0.5 }, zoom3: { zoom: 3 }, touch: { touch: true }, 'touch-mobile': { touch: true, mobile: true } };
try {
  for (const [nm, cfg] of Object.entries(CFGS)) {
    if (!want('grid-' + nm) && !want(nm) && !(only.includes('grid'))) continue;
    const [c, b] = await Promise.all([grid('cand', cfg), grid('base', cfg)]);
    const hits = c.filter((x) => x[0] === 'H').length;
    const cBad = c.filter((x) => x === 'H-' || x === 'HW' || x === '.T').length, bBad = b.filter((x) => x === 'H-' || x === 'HW' || x === '.T').length;
    const differ = c.map((x, i) => (x !== b[i] ? `${i}:${x}/${b[i]}` : null)).filter(Boolean);
    console.log(`grid-${nm}`, J({ hits, candHitNoTick: c.filter((x) => x === 'H-').length, baseHitNoTick: b.filter((x) => x === 'H-').length, candMissTick: c.filter((x) => x === '.T').length, baseMissTick: b.filter((x) => x === '.T').length, cBad, bBad, differ: differ.slice(0, 12) }));
    for (const x of browsers.splice(0)) await x.close().catch(() => {});
  }
  if (want('focus-tab-space')) {
    const [c, b] = await Promise.all([focusSpaceTab('cand'), focusSpaceTab('base')]);
    console.log('focus-tab-space', J({ same: J(c) === J(b), c, b }));
  }
  if (want('focus-space') && !only.includes('focus-tab-space')) {
    const [c, b] = await Promise.all([focusSpace('cand'), focusSpace('base')]);
    console.log('focus-space', J({ same: J(c) === J(b), c, b }));
  }
} finally {
  clearTimeout(killer);
  for (const x of browsers) await x.close().catch(() => {});
}
