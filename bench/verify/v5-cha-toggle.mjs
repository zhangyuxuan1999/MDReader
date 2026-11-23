// bench/verify/v5-cha-toggle.mjs — challenge-a (round 4): the P-B change to replayToggle (a task checkbox clicked
// while a write of ours is on its way is replayed only on a wrapper that shows its block's current source, and
// given up when the box was re-rendered). Each case ends a session with a write, then clicks a checkbox at once
// (or after `gap` ms), and checks that the clicked task (and only it) was ticked.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-toggle.mjs [case ...]   (MDR_DELAY=ms: slow worker for every case)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const DELAY = Number(process.env.MDR_DELAY ?? 0);
async function slowWorker(ms) {
  await page.evaluate((ms) => {
    const pv = window.__mdr.app.preview;
    if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); }
    window.__delayMs = ms;
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), window.__delayMs); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), window.__delayMs); else window.__origHtml(m); };
    window.__delay = ms > 0;
  }, ms);
}
async function clickBox(k) {
  const p = await page.evaluate((k) => {
    const b = document.querySelectorAll('.mdr-preview input[type="checkbox"]')[k];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, k);
  if (!p) throw new Error('no checkbox ' + k);
  await page.mouse.click(p.x, p.y);
}
const TL = '- [ ] one\n- [ ] two\n- [ ] three\n';
// [name, doc, click needle, caret after, keys before the box click ('esc' ends with Esc), box index, gap ms, want]
const C = [
  ['same-list-esc-0', `Intro para\n\n${TL}\nend\n`, 'one', 'one', ['X', 'esc'], 1, 0, `Intro para\n\n- [ ] oneX\n- [x] two\n- [ ] three\n\nend\n`],
  ['same-list-esc-60', `Intro para\n\n${TL}\nend\n`, 'one', 'one', ['X', 'esc'], 1, 60, `Intro para\n\n- [ ] oneX\n- [x] two\n- [ ] three\n\nend\n`],
  ['same-list-esc-150', `Intro para\n\n${TL}\nend\n`, 'one', 'one', ['X', 'esc'], 2, 150, `Intro para\n\n- [ ] oneX\n- [ ] two\n- [x] three\n\nend\n`],
  ['same-list-enter-esc-0', `Intro para\n\n${TL}\nend\n`, 'one', 'one', ['Enter', 'N', 'esc'], 2, 0, (s) => /^Intro para\n\n- \[ \] one\n- (\[ \] )?N\n- \[x\] two\n- \[ \] three\n\nend\n$/.test(s)],
  ['para-above-type-click', `Intro para\n\n${TL}\nend\n`, 'Intro', 'Intro', ['X'], 1, 0, `IntroX para\n\n- [ ] one\n- [x] two\n- [ ] three\n\nend\n`],
  ['para-above-enter-click', `Intro para\n\n${TL}\nend\n`, 'Intro', 'Intro', ['Enter'], 1, 0, (s) => s === `Intro\n\npara\n\n- [ ] one\n- [x] two\n- [ ] three\n\nend\n`],
  ['para-above-enter-esc-click', `Intro para\n\n${TL}\nend\n`, 'Intro', 'Intro', ['Enter', 'esc'], 0, 0, (s) => s === `Intro\n\npara\n\n- [x] one\n- [ ] two\n- [ ] three\n\nend\n`],
  ['other-list-click', `- [ ] aa\n- [ ] bb\n\nmid\n\n${TL}`, 'aa', 'aa', ['X'], 3, 0, `- [ ] aaX\n- [ ] bb\n\nmid\n\n- [ ] one\n- [x] two\n- [ ] three\n`],
  ['other-list-esc-click', `- [ ] aa\n- [ ] bb\n\nmid\n\n${TL}`, 'aa', 'aa', ['X', 'esc'], 4, 0, `- [ ] aaX\n- [ ] bb\n\nmid\n\n- [ ] one\n- [ ] two\n- [x] three\n`],
  ['in-session-own-box', `Intro para\n\n${TL}\nend\n`, 'one', 'one', ['X'], 1, 0, `Intro para\n\n- [ ] oneX\n- [x] two\n- [ ] three\n\nend\n`],
  ['nested-same-esc-0', `- [ ] top\n  - [ ] inner\n  - [ ] inner2\n\nend\n`, 'inner', 'inner', ['X', 'esc'], 2, 0, `- [ ] top\n  - [ ] innerX\n  - [x] inner2\n\nend\n`],
  ['quote-list-esc-0', `> - [ ] q1\n> - [ ] q2\n\nend\n`, 'q1', 'q1', ['X', 'esc'], 1, 0, `> - [ ] q1X\n> - [x] q2\n\nend\n`],
];
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, click, at, keys, box, gap, exp] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${DELAY ? '-delay' + DELAY : ''}${run ? '#' + run : ''}`;
      try {
        await slowWorker(0);
        await load(B, doc);
        await clickText(page, click, Math.min(1, click.length - 1), { side: 'right' });
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no session');
        await sleep(80);
        await caretTo(page, at, 'after');
        await sleep(80);
        await slowWorker(DELAY);
        for (const k of keys) {
          if (k === 'esc') await page.keyboard.press('Escape');
          else if (k.length === 1) await page.keyboard.type(k);
          else await page.keyboard.press(k);
        }
        if (gap) await sleep(gap);
        await clickBox(box);
        await settle(900 + DELAY * 2);
        await slowWorker(0);
        await settle(300);
        const v = await view(page);
        const ok = typeof exp === 'function' ? exp(v.src) : v.src === exp;
        if (!check(nm, ok, `observed=${J(v.src)} expected=${typeof exp === 'function' ? '(see script)' : J(exp)}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
