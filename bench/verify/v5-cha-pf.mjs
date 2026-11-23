// bench/verify/v5-cha-pf.mjs — challenge-a (round 4): variations of J8 / P-F (a click, and the keys after it, on a
// block whose re-render is on its way wait for it; nothing typed is dropped at CLICK_WAIT_MS). A session writes
// (typing, Enter), ends (Esc or the click itself), and the user clicks at once into the SAME block (its re-render is
// pending) or the one below, then types; with a slow worker (`delay` ms, v3-ses-preview.mjs's hook).
// Run: MDR_PORT=5485 node bench/verify/v5-cha-pf.mjs [case-prefix ...]   (RUNS=n)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
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
const D = 'Alpha beta\n\nOmega words\n\n- item one\n- item two\n';
// [name, keys in the first session, delay, steps after: ['c', needle, k] click (left side of char k), ['t', s] type,
//  ['p', ms] pause, ['k', key]], want
const C = [];
for (const d of [0, 400, 900]) {
  C.push([`same-type-esc-d${d}`, ['X', 'esc'], d, [['c', 'beta', 1], ['t', 'Z']], 'AlphaX bZeta\n\nOmega words\n\n- item one\n- item two\n']);
  C.push([`same-type-noesc-below-d${d}`, ['X'], d, [['c', 'Omega', 1], ['t', 'Z']], 'AlphaX beta\n\nOZmega words\n\n- item one\n- item two\n']);
  C.push([`same-enter-esc-d${d}`, ['Enter', 'esc'], d, [['c', 'beta', 1], ['t', 'Z']], 'Alpha\n\nbZeta\n\nOmega words\n\n- item one\n- item two\n']);
  C.push([`same-type-esc-human-d${d}`, ['X', 'esc'], d, [['c', 'beta', 1], ['t', 'Z'], ['p', 300], ['t', 'W'], ['p', 300], ['t', 'V']], 'AlphaX bZWVeta\n\nOmega words\n\n- item one\n- item two\n']);
  C.push([`list-type-esc-d${d}`, ['X', 'esc'], d, [['c', 'item two', 1], ['t', 'Z']], 'AlphaX beta\n\nOmega words\n\n- item one\n- iZtem two\n']);
  C.push([`same-type-esc-arrow-d${d}`, ['X', 'esc'], d, [['c', 'beta', 1], ['k', 'ArrowRight'], ['t', 'Z']], 'AlphaX beZta\n\nOmega words\n\n- item one\n- item two\n']);
  C.push([`two-clicks-d${d}`, ['X', 'esc'], d, [['c', 'beta', 1], ['t', 'Z'], ['c', 'Omega', 1], ['t', 'W']], 'AlphaX bZeta\n\nOWmega words\n\n- item one\n- item two\n']);
  C.push([`editor-after-click-d${d}`, ['X', 'esc'], d, [['c', 'beta', 1], ['p', 120], ['ed'], ['th', 'EDIT', 350]], 'AlphaX beta\n\nOmega words\n\n- item one\n- item two\nEDIT']);
}
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, keys, delay, steps, exp] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${run ? '#' + run : ''}`;
      try {
        await slowWorker(0);
        await load(B, D);
        await clickText(page, 'Alpha', 1, { side: 'right' });
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no session');
        await sleep(80);
        await caretTo(page, 'Alpha', 'after');
        await sleep(80);
        await slowWorker(delay);
        for (const k of keys) {
          if (k === 'esc') await page.keyboard.press('Escape');
          else if (k.length === 1) await page.keyboard.type(k);
          else await page.keyboard.press(k);
        }
        for (const st of steps) {
          if (st[0] === 'c') await clickText(page, st[1], st[2], { side: 'left' });
          else if (st[0] === 't') await page.keyboard.type(st[1]);
          else if (st[0] === 'k') await page.keyboard.press(st[1]);
          else if (st[0] === 'p') await sleep(st[1]);
          else if (st[0] === 'ed') { const p = await page.evaluate(() => { const v = window.__mdr.app.editor.view; const c = v.coordsAtPos(v.state.doc.length); return { x: c.left + 2, y: (c.top + c.bottom) / 2 }; }); await page.mouse.click(p.x, p.y); }
          else if (st[0] === 'th') { for (const ch of st[1]) { await page.keyboard.type(ch); await sleep(st[2]); } }
        }
        await sleep(delay * 2 + 500);
        await slowWorker(0);
        await settle(500);
        const v = await view(page);
        if (!check(nm, v.src === exp, `observed=${J(v.src)} expected=${J(exp)} toast=${J(v.toast)}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
