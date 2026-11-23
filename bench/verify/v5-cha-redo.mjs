// bench/verify/v5-cha-redo.mjs — challenge-a (round 4): variations of J3 / P-B (a history resume starts only on a
// wrapper that shows its block's current source). A block between two neighbours that merge once it is gone (or a
// control) is emptied; then a key sequence of Cmd-Z / Shift-Cmd-Z (`seq`), then Q. Q must be written, and both
// neighbour texts must still be in the source; then Cmd-Z until the original (byte for byte).
// Run: MDR_PORT=5485 node bench/verify/v5-cha-redo.mjs [case-prefix ...]   (MDR_DELAY=ms slow worker)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load } from './v4-sesa-lib.mjs';

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
const K = [
  ['tasks-around', '- [ ] aaa\n\n乙段落\n\n- [ ] zzz\n', 'aaa', 'zzz'],
  ['star-lists-around-heading', '* aaa\n\n## 乙题\n\n* zzz\n', 'aaa', 'zzz'],
  ['nested-lists-around', '- aaa\n  - a2\n\n乙段落\n\n- zzz\n  - z2\n', 'a2', 'zzz'],
  ['code-around-quote', '    aaa code\n\n> 乙引\n\n    zzz code\n', 'aaa', 'zzz'],
  ['ordered-around-fence', '1. aaa\n\n```\n乙码\n```\n\n2. zzz\n', 'aaa', 'zzz'],
  ['quote-lazy-after', '> aaa\n\n乙段落\n\nzzz lazy\n', 'aaa', 'zzz'],
  ['lists-around-table', '- aaa\n\n| 乙 | b |\n| --- | --- |\n| c | d |\n\n- zzz\n', 'aaa', 'zzz'],
  ['first-before-list', '乙段落\n\n- zzz\n- yyy\n', null, 'zzz'],
  ['control-paras', 'aaa\n\n乙段落\n\nzzz\n', 'aaa', 'zzz'],
];
const SEQ = { ur: ['Meta+z', 'Meta+Shift+z'], urur: ['Meta+z', 'Meta+Shift+z', 'Meta+z', 'Meta+Shift+z'], u: ['Meta+z'], uru: ['Meta+z', 'Meta+Shift+z', 'Meta+z'] };
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, above, below] of K) {
    for (const [sq, keys] of Object.entries(SEQ)) {
      for (const fast of [false, true]) {
        const nm = `${name}-${sq}${fast ? '-fast' : ''}${DELAY ? '-d' + DELAY : ''}`;
        if (only.length && !only.some((o) => nm.startsWith(o))) continue;
        try {
          await slowWorker(0);
          await load(B, doc);
          await clickText(page, '乙', 0, { side: 'right' });
          const v0 = await waitSession(page);
          if (!v0.editing) throw new Error('no session');
          await sleep(80);
          await slowWorker(DELAY);
          await page.evaluate(() => {
            const el = document.querySelector('.mdr-preview .is-editing');
            const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          });
          await page.keyboard.press('Backspace');
          await settle(fast ? 30 : 400 + DELAY);
          for (const k of keys) { await page.keyboard.press(k); await (fast ? sleep(30) : settle(500 + DELAY)); }
          await page.keyboard.type('Q');
          await settle(700 + DELAY * 2);
          await slowWorker(0);
          await settle(300);
          const v = await view(page);
          const s = v.src;
          const ok = s.includes('Q') && (above === null || s.includes(above)) && s.includes(below);
          await page.keyboard.press('Escape'); await settle(200);
          for (let i = 0; i < 8 && (await B.source()) !== doc; i++) { await page.keyboard.press('Meta+z'); await settle(300); }
          const back = (await B.source()) === doc;
          if (!check(nm, ok && back, `afterQ=${J(s)} undoBack=${back ? 'ok' : J(await B.source())}`)) bad++;
        } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
        try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
      }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
