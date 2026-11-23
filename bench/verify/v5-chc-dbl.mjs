// bench/verify/v5-chc-dbl.mjs — challenge-c: a real double and triple click on a task's own checkbox (switch OFF), and a
// press with a modifier held, a press of two seconds, a press followed by Shift / Escape / a letter before the release:
// how many times the source line flipped (counted at every change event), the toasts, the final source and box.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-dbl.mjs cand | MDR_BASE_PORT=5497 ... base
import { openPage, load, sleep, J } from './v5-chc-lib.mjs';
const target = process.argv[2] || 'cand';
const killer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 110000);
const DOC = 'Intro\n\n- [ ] q1 one\n- [ ] q2 two\n- [ ] q3 three\n\nend\n';
const { browser, page } = await openPage(target);
const CASES = {
  dbl: async (p) => { await page.mouse.dblclick(p.x, p.y); },
  triple: async (p) => { await page.mouse.click(p.x, p.y, { clickCount: 3, delay: 30 }); },
  'shift-click': async (p) => { await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift'); },
  'meta-click': async (p) => { await page.keyboard.down('Meta'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Meta'); },
  'ctrl-click': async (p) => { await page.keyboard.down('Control'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Control'); },
  'slow-2s': async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await sleep(2000); await page.mouse.up(); },
  'press-letter-release': async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await sleep(80); await page.keyboard.press('a'); await sleep(50); await page.mouse.up(); },
  'press-tab-release': async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await sleep(80); await page.keyboard.press('Tab'); await sleep(50); await page.mouse.up(); },
  'press-space-release': async (p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await sleep(80); await page.keyboard.press('Space'); await sleep(50); await page.mouse.up(); },
  'edge-left-top': async (p) => { await page.mouse.click(p.l + 0.2, p.t + 0.2); },
  'edge-right-bottom': async (p) => { await page.mouse.click(p.r - 0.3, p.b - 0.3); },
};
try {
  for (const [name, fn] of Object.entries(CASES)) {
    await load(page, DOC);
    await page.evaluate(() => { window.__ch = []; window.__ts = []; if (!window.__dh) { window.__dh = true; window.addEventListener('change', () => window.__ch.push(window.__mdr.app.getText().includes('[x] q2'))); window.__mdr.app.bus?.on?.('toast', (e) => window.__ts.push(e.text)); } });
    const p = await page.evaluate(() => { const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[1]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, r: r.right, b: r.bottom }; });
    await fn(p);
    await sleep(700);
    const o = await page.evaluate(() => ({ changes: window.__ch, toasts: window.__ts || [], q2: window.__mdr.app.getText().match(/\[.\] q2/)[0], box: document.querySelectorAll('.mdr-preview input[type="checkbox"]')[1].checked, others: (window.__mdr.app.getText().match(/\[x\] q[13]/g) || []) }));
    console.log(name, J(o));
  }
} finally { clearTimeout(killer); await browser.close(); }
