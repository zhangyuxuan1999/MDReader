// bench/verify/v5-cha-pb.mjs — challenge-a (round 4): P-B with a slow worker. A session's write changes the line
// count of the document above a block C (Enter, a paste of two paragraphs, an emptied block); the structure update
// is delayed by `delay` ms (the slow-worker hook of v3-ses-preview.mjs: structure deltas and HTML both held); `wait`
// ms after the write the user clicks into C and types Z. P-B: the session on C may start only on a wrapper that
// shows C's CURRENT source, so Z must land where it was clicked and nothing else may change.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-pb.mjs [case ...]   (RUNS=n repeats every case)
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
const D1 = 'Alpha beta\n\nGamma delta\n\nOmega words\n';
const D2 = 'Alpha beta\n\n- item one\n- item two\n\n## Omega head\n';
const D3 = 'Alpha beta\n\nGamma delta\n\n| h | k |\n| --- | --- |\n| Omega | cell |\n';
// [name, doc, start needle, caret after, keys ('esc' = Escape), delay, wait, click needle, k, want]
const C = [
  ['enter-esc-d400-w0', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 400, 0, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n'],
  ['enter-esc-d1500-w0', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 1500, 0, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n'],
  ['enter-esc-d1800-w1200', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n'],
  ['enter-esc-d3000-w1300', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 3000, 1300, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n'],
  ['enter-esc-d3000-w0', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 3000, 0, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n'],
  ['enter-click-d1800-w1200', D1, 'Alpha', 'Alpha', ['Enter'], 1800, 1200, 'Gamma', 1, 'Alpha\n\nbeta\n\nGZamma delta\n\nOmega words\n'],
  ['enter-esc-list-d1800-w1200', D2, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'item two', 1, 'Alpha\n\nbeta\n\n- item one\n- iZtem two\n\n## Omega head\n'],
  ['enter-esc-head-d1800-w1200', D2, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 1, 'Alpha\n\nbeta\n\n- item one\n- item two\n\n## OZmega head\n'],
  ['enter-esc-cell-d1800-w1200', D3, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\n| h | k |\n| --- | --- |\n| OZmega | cell |\n'],
  ['empty-esc-d1800-w1200', D1, 'Alpha', 'Alpha', ['Meta+a', 'Backspace', 'esc'], 1800, 1200, 'Omega', 1, 'Gamma delta\n\nOZmega words\n'],
  ['enter-esc-d1200-w1100', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 1200, 1100, 'Omega', 1, 'Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n'],
];
let bad = 0;
import { readFileSync } from 'node:fs';
const TAIL = process.env.MDR_BIG ? '\n' + readFileSync(new URL('../../test-data/' + process.env.MDR_BIG, import.meta.url), 'utf8') : '';
try {
  await B.boot('mode=split');
  for (const [name, doc0, start, at, keys, delay0, wait, click, k, exp0] of C) {
    const doc = doc0 + TAIL, exp = exp0 + TAIL, delay = TAIL ? 0 : delay0;
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${run ? '#' + run : ''}`;
      try {
        await slowWorker(0);
        await load(B, doc);
        await clickText(page, start, Math.min(1, start.length - 1), { side: 'right' });
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no session');
        await sleep(80);
        await caretTo(page, at, 'after');
        await sleep(80);
        await slowWorker(delay);
        for (const key of keys) {
          if (key === 'esc') await page.keyboard.press('Escape');
          else if (key.length === 1) await page.keyboard.type(key);
          else await page.keyboard.press(key);
          await sleep(30);
        }
        if (wait) await sleep(wait);
        await clickText(page, click, k, { side: 'left' });
        await sleep(60);
        await page.keyboard.type('Z');
        await sleep(delay + 600);
        await slowWorker(0);
        await settle(600);
        const v = await view(page);
        const ok = v.src === exp;
        if (!check(nm, ok, `observed=${J(v.src)} expected=${J(exp)} editing=${J(v.editing && v.editing.text.slice(0, 30))}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
