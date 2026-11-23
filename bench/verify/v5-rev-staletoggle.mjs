// bench/verify/v5-rev-staletoggle.mjs — verify-review (0.2.0 round 4): inlineEdit's `toggle` (set by a press on a
// checkbox INSIDE a session, consumed only by a click on that same box) outlives the gesture when the press is
// released elsewhere, and outlives the session. A later click on that box element (after Esc, before the released
// block's re-render mounts) is then taken by the stale branch of onClick: preventDefault, the box set to the remembered
// state by a timer, no write, no wait, no toast. Switch ON (dev server default).
// Expected (U16 as amended): the click ticks the task, or waits and ticks it, or nothing changes and the toast
// 没有勾选：该任务项刚被改动，请再点一次 is shown. Run: MDR_PORT=5487 node bench/verify/v5-rev-staletoggle.mjs [runs=3] [holdMs=1500]
// (holdMs 0: no slow-worker hook, the click follows Esc at once; MDR_CONTROL=1: the same without the press on the box.) Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const RUNS = Number(process.argv[2] || 3);
const HOLD = Number(process.argv[3] ?? 1500);
const CONTROL = process.env.MDR_CONTROL === '1';   // no press on the box before Esc: the stale state is never made
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOC = 'Intro\n\n- [ ] one task\n- [ ] two task\n- [ ] three task\n\nend\n';
let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.evaluate(() => { window.__toasts = []; window.__mdr.app.bus.on('toast', (e) => window.__toasts.push(e.text)); });
  const pt = (sel) => page.evaluate((sel) => {
    const pv = window.__mdr.app.preview.el;
    if (sel.startsWith('box:')) {
      const want = sel.slice(4);
      const b = Array.from(pv.querySelectorAll('input[type="checkbox"]')).find((x) => x.closest('li')?.textContent.includes(want));
      if (!b) return null;
      const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const tw = document.createTreeWalker(pv, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(sel);
      if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; }
    }
    return null;
  }, sel);
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(() => { const pv = window.__mdr.app.preview; if (window.__origHtml) pv.applyHtml = window.__origHtml; });
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'st.md'), [DOC]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(600);
    const two = await pt('two');
    await page.mouse.click(two.x, two.y);                      // session in the list block
    await sleep(250);
    const live = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
    const b1 = await pt('box:one');
    const three = await pt('three');
    if (!CONTROL) {
      await page.mouse.move(b1.x, b1.y);
      await page.mouse.down();                                 // press on the box inside the session
      await page.mouse.move(three.x, three.y, { steps: 4 });
      await page.mouse.up();                                   // released on the text of another item: no click on the box
    }
    await sleep(150);
    if (HOLD) await page.evaluate((ms) => {
      const pv = window.__mdr.app.preview;
      window.__origHtml = window.__origHtml || pv.applyHtml.bind(pv);
      pv.applyHtml = (m) => setTimeout(() => window.__origHtml(m), ms);
    }, HOLD);
    // the session ends (Esc; MDR_END=switch: the switch is turned off with Shift+Cmd+E); its block's re-render is on its way
    if (process.env.MDR_END === 'switch') await page.keyboard.press('Meta+Shift+e'); else await page.keyboard.press('Escape');
    await sleep(Number(process.env.MDR_DELAY ?? (HOLD ? 100 : 0)));   // MDR_DELAY: ms between Esc and the click
    const before = await page.evaluate(() => { window.__toasts = []; return window.__mdr.app.getText(); });
    const b1b = await pt('box:one');
    await page.mouse.click(b1b.x, b1b.y);                      // a real click on box "one"
    await sleep(60);
    const shown = await page.evaluate(() => Array.from(window.__mdr.app.preview.el.querySelectorAll('input[type="checkbox"]')).map((b) => b.checked));
    await sleep(HOLD + 1500);
    await page.evaluate(() => window.__mdr.waitIdle());
    const after = await page.evaluate(() => window.__mdr.app.getText());
    const toasts = await page.evaluate(() => window.__toasts.slice());
    const shownAfter = await page.evaluate(() => Array.from(window.__mdr.app.preview.el.querySelectorAll('input[type="checkbox"]')).map((b) => b.checked));
    const ticked = after.includes('- [x] one task');
    const told = toasts.some((t) => /没有勾选/.test(t));
    const ok = ticked !== told;
    if (!ok) bad++;
    const sw = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
    if (process.env.MDR_END === 'switch') await page.keyboard.press('Meta+Shift+e');   // back on for the next run
    console.log(`${ok ? 'ok  ' : 'FAIL'} run${run} end=${process.env.MDR_END || 'esc'} switchPressedAfter=${sw} control=${CONTROL} hold=${HOLD} sessionStarted=${live} sourceBefore=${JSON.stringify(before.split('\n')[2])} ticked=${ticked} toast=${told} toasts=${JSON.stringify(toasts)} shown60ms=${JSON.stringify(shown)} shownAfter=${JSON.stringify(shownAfter)}`);
  }
  console.log(`${bad} of ${RUNS} lost silently (or both ticked and told)`);
} finally {
  clearTimeout(killer);
  await browser.close();
}
