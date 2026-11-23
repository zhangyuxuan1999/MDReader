// bench/verify/v5-cha-togglegiant.mjs — challenge-a (round 4): the replayToggle change at NATURAL timing. A task list
// whose items carry many inline formulas (worker HTML > 256 KB: it mounts only after GIANT_SETTLE_MS) is edited in a
// session (X typed into item 0), the session ends with Esc, and `gap` ms later the user clicks the checkbox of item 2.
// That task (and only it) must be ticked, X written.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-togglegiant.mjs   (N items, default 100; RUNS=n)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } from './v4-sesa-lib.mjs';

const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const N = Number(process.env.N || 100);
const items = Array.from({ length: N }, (_, i) => `- [ ] t${i} $a_{${i}}$ $b_{${i}}$ $c_{${i}}$ $d_{${i}}$`);
const doc = 'Top para.\n\n' + items.join('\n') + '\n\nEnd para.\n';
let bad = 0;
try {
  await B.boot('mode=split');
  for (const gap of [0, 100, 250, 400]) {
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `giant-tasks-esc-box-gap${gap}${run ? '#' + run : ''}`;
      try {
        await load(B, doc);
        await sleep(1500);
        await clickText(page, 't0', 1, { side: 'right' });
        const v0 = await waitSession(page, 3000);
        if (!v0.editing) throw new Error('no session');
        await caretTo(page, 't0', 'after');
        await page.keyboard.type('X');
        await sleep(60);
        await page.keyboard.press('Escape');
        if (gap) await sleep(gap);
        const p = await page.evaluate(() => {
          const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[2];
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(p.x, p.y);
        await sleep(2500);
        await B.settle(300);
        const v = await view(page);
        const want = doc.replace('- [ ] t0 ', '- [ ] t0X ').replace('- [ ] t2 ', '- [x] t2 ');
        const ls = v.src.split('\n').slice(2, 5);
        if (!check(nm, v.src === want, `lines=${J(ls.map((l) => l.slice(0, 12)))} toast=${J(v.toast)}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
      try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
