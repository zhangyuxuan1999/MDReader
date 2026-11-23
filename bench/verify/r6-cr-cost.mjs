// bench/verify/r6-cr-cost.mjs — challenge-refs (0.2.0 stage 2g, fix round 6): the cost of round 6 (sourceHidden at the
// session start, THE GUARD at every write). On a 300-item list and on a 59 KB paragraph (MAX_EDIT_CHARS is 60000: a 60 KB one is refused), each without and with character
// references of invisible characters (&shy; &zwnj; &#x2060; spread through it, so that sourceHidden renders the block):
// (start) from the mouseup that starts the session to the moment the block is editing; (write) from one typed character
// (keyboard.insertText) to the source holding it. Medians of REPS runs, in milliseconds, plus the longest long task.
// Run: MDR_PORT=<dev server> node bench/verify/r6-cr-cost.mjs   (REPS, default 5; T_MS: global timeout, default 110000)
// Compare the tree with a copy of the tree before round 6 on another port. Writes nothing into the tree.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const REPS = Number(process.env.REPS ?? 5);
const T_MS = Number(process.env.T_MS ?? 110000);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (i, refs) => (refs && i % 7 === 0 ? ['a&shy;b', 'c&zwnj;d', 'e&#x2060;f'][i % 3] : 'lorem' + (i % 10));
const list = (refs) => Array.from({ length: 300 }, (_, i) => `- item ${i} ${word(i, refs)} ${word(i + 1, refs)} text`).join('\n') + '\n- end text item';
const para = (refs) => { let s = 'end text '; let i = 0; while (s.length < 59000) s += word(i++, refs) + ' '; return s.trim(); };   // (the target at the start: a click at the end of a 59 KB paragraph lands nowhere)
const CASES = [['list300', list(false)], ['list300-refs', list(true)], ['para59k', para(false)], ['para59k-refs', para(true)]];
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  await page.evaluate(() => {
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch { /* */ }
    window.__up = 0; window.__ed = 0;
    addEventListener('mouseup', () => { window.__up = performance.now(); }, true);
    new MutationObserver(() => { if (!window.__ed && document.querySelector('.md-block.is-editing')) window.__ed = performance.now(); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  for (const [name, block] of CASES) {
    const starts = [], writes = [], longs = [];
    for (let r = 0; r < REPS; r++) {
      await page.keyboard.press('Escape');
      await page.evaluate(([t]) => window.__mdr.loadText(t, 'cost.md'), [`# Cost\n\nfiller\n\n${block}\n\nlast paragraph\n`]);
      await page.evaluate(() => window.__mdr.waitIdle());
      await sleep(900);
      const at = await page.evaluate(() => {
        const root = window.__mdr.app.preview.el;
        const tw = document.createTreeWalker(root, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1); const b = rg.getBoundingClientRect(); window.__mdr.app.preview.el.scrollTop += b.top - 300; return true; } }
        return false;
      });
      if (!at) { console.log(`${name}: no target`); break; }
      await sleep(700);
      const pt = await page.evaluate(() => {
        const root = window.__mdr.app.preview.el;
        const tw = document.createTreeWalker(root, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const rg = document.createRange(); rg.setStart(n, i + 1); rg.setEnd(n, i + 2); const b = rg.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
        return null;
      });
      await page.evaluate(() => { window.__up = 0; window.__ed = 0; window.__lt = []; });
      await page.mouse.click(pt.x, pt.y);
      await page.waitForFunction(() => window.__ed > 0, null, { timeout: 10000 }).catch(() => {});
      const st = await page.evaluate(() => (window.__ed && window.__up ? window.__ed - window.__up : -1));
      await sleep(300);
      const before = await page.evaluate(() => window.__mdr.app.getText().split('X').length);
      const t0 = await page.evaluate(() => performance.now());
      await page.keyboard.insertText('X');
      const dt = await page.evaluate(([b, t]) => new Promise((res) => {
        const tick = () => { if (window.__mdr.app.getText().split('X').length > b) res(performance.now() - t); else if (performance.now() - t > 5000) res(-1); else requestAnimationFrame(tick); };
        tick();
      }), [before, t0]);
      const lt = await page.evaluate(() => Math.max(0, ...window.__lt));
      starts.push(st); writes.push(dt); longs.push(lt);
    }
    console.log(`COST ${name}: start median=${med(starts).toFixed(1)} ms [${starts.map((x) => x.toFixed(0)).join(',')}]  write median=${med(writes).toFixed(1)} ms [${writes.map((x) => x.toFixed(0)).join(',')}]  longest task median=${med(longs).toFixed(0)} ms`);
  }
} finally { await browser.close(); clearTimeout(killer); }
