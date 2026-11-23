// bench/verify/v5-chc-hold.mjs — challenge-c: U24 as amended (fix-session-e B1) with a human press duration. A rapid
// series of ticks where each press is HELD (mouse down, hold H ms, mouse up) as a person's click is (50 to 150 ms),
// so the re-render that the previous tick caused can mount between the press and the release and replace the box
// element under the pointer. Per click it records the press target, the click target, whether the pressed box was still
// connected at the click, and afterwards which tasks the source holds ticked, the toasts, and the boxes shown.
// Run: MDR_PORT=5487 node bench/verify/v5-chc-hold.mjs cand [case ...]   |   MDR_BASE_PORT=5497 ... base
// Cases: <doc>-h<hold>-g<gap>-n<count>, doc small (20 plain tasks) or math (20 formula tasks). Switch OFF.
import { openPage, load, sleep, J } from './v5-chc-lib.mjs';

const target = process.argv[2] || 'cand';
const only = process.argv.slice(3);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 15 * 60 * 1000);
const DOCS = {
  small: 'Intro\n\n' + Array.from({ length: 20 }, (_, i) => `- [ ] q${i + 1} word`).join('\n') + '\n\nend\n',
  math: 'Intro\n\n' + Array.from({ length: 20 }, (_, i) => `- [ ] q${i + 1} $a_{${i}}$ $\\frac{${i}}{2}$`).join('\n') + '\n\nend\n',
};
const { browser, page, errs } = await openPage(target);
const results = [];
try {
  for (const doc of ['small', 'math']) for (const hold of [60, 120]) for (const gap of [0, 40, 120]) {
    const n = 6;
    const nm = `${doc}-h${hold}-g${gap}-n${n}`;
    if (only.length && !only.some((o) => nm.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.MDR_RUNS || 2); run++) {
      await load(page, DOCS[doc], `${nm}.md`);
      await page.evaluate(() => {
        const W = window.__hold = { recs: [], toasts: [] };
        if (!window.__holdHooked) {
          window.__holdHooked = true;
          document.addEventListener('pointerdown', (e) => { const t = e.target; window.__hold.recs.push({ down: t instanceof HTMLInputElement ? (t.closest('li')?.textContent || '').trim().split(/\s+/)[0] : t.tagName, el: t }); }, true);
          document.addEventListener('click', (e) => { const r = window.__hold.recs[window.__hold.recs.length - 1]; if (!r) return; const t = e.target; r.click = t instanceof HTMLInputElement ? (t.closest('li')?.textContent || '').trim().split(/\s+/)[0] : t.tagName; r.same = t === r.el; r.pressedConnected = r.el.isConnected; }, true);
          window.__mdr.app.bus?.on?.('toast', (e) => window.__hold.toasts.push(e.text));
        }
        void W;
      });
      const pts = [];
      for (let i = 0; i < n; i++) {
        const tok = `q${3 + i * 2}`;
        const p = await page.evaluate((tok) => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').trim().split(/\s+/)[0] === tok); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, tok);
        pts.push(tok);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await sleep(hold);
        await page.mouse.up();
        if (gap) await sleep(gap);
      }
      await sleep(1500); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(300);
      const W = await page.evaluate(() => { const w = window.__hold; return { recs: w.recs.map((r) => ({ down: r.down, click: r.click, same: r.same, pc: r.pressedConnected })), toasts: w.toasts }; });
      const s = await page.evaluate(() => window.__mdr.app.getText());
      const ticked = (s.match(/^- \[x\] (q\d+)/gm) || []).map((x) => x.slice(6));
      const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).filter((b) => b.checked).map((b) => (b.closest('li')?.textContent || '').trim().split(/\s+/)[0]));
      const lost = pts.filter((t) => !ticked.includes(t));
      const r = { name: nm, run, ticked: ticked.length, want: n, lost, wrong: ticked.filter((t) => !pts.includes(t)), toasts: W.toasts.length, shownMismatch: J(shown.sort()) !== J(ticked.slice().sort()), notSame: W.recs.filter((x) => !x.same).map((x) => `${x.down}->${x.click}${x.pc ? '' : '(pressed box detached)'}`) };
      results.push(r);
      console.log(nm, J(r));
    }
  }
} finally {
  clearTimeout(killer);
  console.log('summary', J({ target, cases: results.length, lostTotal: results.reduce((k, r) => k + r.lost.length, 0), silentLossCases: results.filter((r) => r.lost.length && !r.toasts).map((r) => r.name + '#' + r.run), wrong: results.filter((r) => r.wrong.length).map((r) => r.name), errs: errs.slice(0, 3) }));
  await browser.close();
}
