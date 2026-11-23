// bench/verify/r4-if-miss.mjs — fix-session-f: v5-ptk-ticks' atk-above-2lines-giant-20 ("nothing, no toast") with the
// pointerdown target logged: two Enters and a letter typed above the 100-task formula list, 20 ms later a real click at
// the centre the preview showed for task5's box a moment before. Reports per run what the press went down on and what
// was ticked. Run: MDR_PORT=<cand> MDR_BASE_PORT=<0.1.1> node bench/verify/r4-if-miss.mjs cand|base [runs]
import { chromium } from '@playwright/test';
const target = process.argv[2] || 'cand';
const runs = Number(process.argv[3] || 6);
const URL = target === 'base' ? `http://localhost:${process.env.MDR_BASE_PORT}/?perf=1&mode=split` : `http://localhost:${process.env.MDR_PORT}/?mode=split`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 110_000);
const giant = 'Intro\n\n' + Array.from({ length: 100 }, (_, i) => `- [ ] task${i} $a_{${i}}$ $b^{${i}}$ $c_${i}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend\n';
const b = await chromium.launch({ headless: true });
try {
  const page = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto(URL); await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('mdr.previewEdit', '0'); });
  await page.reload(); await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 }); await sleep(500);
  for (let run = 0; run < runs; run++) {
    await page.evaluate((t) => window.__mdr.loadText(t, 'v.md'), giant); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(700);
    await page.evaluate(() => {
      window.__pd = null; window.__t = [];
      if (!window.__hk) { window.__hk = true; window.__mdr.app.bus.on('toast', (e) => window.__t.push(e.text)); document.addEventListener('pointerdown', (e) => { const t = e.target; window.__pd = `${t.tagName}${t.className ? '.' + String(t.className).split(' ')[0] : ''}:${(t.closest('li')?.textContent || '').trim().split(/\s+/)[0]}`; }, true); }
      const v = window.__mdr.app.editor.view; const l = v.state.doc.line(1); v.dispatch({ selection: { anchor: l.to } }); v.focus();
    });
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('p');
    await sleep(20);
    const p = await page.evaluate(() => { const bx = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').trim().startsWith('task5 ')); bx.scrollIntoView({ block: 'nearest' }); const r = bx.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(p.x, p.y);
    await sleep(1200); await page.evaluate(() => window.__mdr.waitIdle());
    const out = await page.evaluate(() => ({ pd: window.__pd, toasts: window.__t, ticked: (window.__mdr.app.getText().match(/\[x\] task\d+/g) || []) }));
    console.log(target, run, JSON.stringify(out));
  }
} finally { clearTimeout(timer); await b.close(); }
