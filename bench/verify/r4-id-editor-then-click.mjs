// bench/verify/r4-id-editor-then-click.mjs — fix-session-d (round 4, item 1, CHA-5 / P-B amended). The document is
// changed in the EDITOR pane (a CodeMirror transaction, what typing there produces): a line inserted above the clicked
// block, a line removed above it, text typed into the clicked block itself (after and before the click point); then a
// preview block is clicked in the same frame or 20 / 60 / 150 ms later and Z is typed. P-B: the session starts only on
// a wrapper that shows the block's CURRENT source (structure version >= the editor's version), so Z lands where the
// user clicked and no other line changes; if the bound passed, Z is discarded with the P-G toast.
// The "-before" edit (text typed before the click point in the clicked block) is CHA-6's class (fix-session-e).
// Run: MDR_PORT=5466 [MDR_DELAY=0|400|1800] node bench/verify/r4-id-editor-then-click.mjs [case-prefix ...]
// MDR_DELAY: the slow-worker hook of v3-ses-preview.mjs (structure deltas and HTML held that long). Writes nothing
// into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, pointOf, load } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const DELAY = Number(process.env.MDR_DELAY ?? 0);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), B.close);
const { page } = B;
const TOAST = '预览尚未更新完，刚才的输入没有写入';
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
const D = 'Alpha beta\n\nGamma delta\n\nOmega words\n\nzz end\n';
// [name, editor change (CodeMirror changes spec, by offsets of D), expected source after the click on 'Omega' (between O
// and m) and Z]
const at = (s) => D.indexOf(s);
const E = [
  ['insert-above', { from: 0, insert: 'New line\n\n' }, 'New line\n\nAlpha beta\n\nGamma delta\n\nOZmega words\n\nzz end\n'],
  ['insert-mid', { from: at('Gamma'), insert: 'Inserted para\n\n' }, 'Alpha beta\n\nInserted para\n\nGamma delta\n\nOZmega words\n\nzz end\n'],
  ['remove-above', { from: at('Gamma'), to: at('Omega') }, 'Alpha beta\n\nOZmega words\n\nzz end\n'],
  ['split-above', { from: at(' delta'), to: at(' delta') + 1, insert: '\n\n' }, 'Alpha beta\n\nGamma\n\ndelta\n\nOZmega words\n\nzz end\n'],
  ['type-in-block-after', { from: at(' words') + 6, insert: ' more' }, 'Alpha beta\n\nGamma delta\n\nOZmega words more\n\nzz end\n'],
  ['type-in-block-before', { from: at('Omega'), insert: 'XX' }, 'Alpha beta\n\nGamma delta\n\nXXOZmega words\n\nzz end\n'],
];
const GAPS = (process.env.MDR_GAPS ?? '0,20,60,150').split(',').map(Number);
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, change, exp] of E) {
    for (const gap of GAPS) {
      const nm = `${name}-g${gap}${DELAY ? '-d' + DELAY : ''}`;
      if (only.length && !only.some((o) => nm.startsWith(o))) continue;
      try {
        await slowWorker(0);
        await page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(true));
        await load(B, D);
        await page.evaluate(() => { for (const t of document.querySelectorAll('[class*="toast"]')) t.remove(); });
        await slowWorker(DELAY);
        const p0 = await pointOf(page, 'Omega', 1, 'left');
        if (!p0) throw new Error('Omega not shown');
        await page.mouse.move(p0.x, p0.y);
        if (gap === 0) {
          // same frame: the change is made in the click's own release (a window capture listener runs before the
          // session's document listener), so no worker answer can come between them
          await page.evaluate((c) => {
            window.addEventListener('mouseup', () => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: c, userEvent: 'input.type' }); }, { capture: true, once: true });
          }, change);
          await page.mouse.down();
          await page.mouse.up();
        } else {
          // the change in the editor pane, then the click `gap` ms later where the block is shown then
          await page.evaluate((c) => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: c, userEvent: 'input.type' }); }, change);
          await sleep(gap);
          const p = (await pointOf(page, 'Omega', 1, 'left', false)) ?? p0;
          await page.mouse.move(p.x, p.y);
          await page.mouse.down();
          await page.mouse.up();
        }
        await sleep(60);
        await page.keyboard.type('Z');
        await sleep(DELAY + 700);
        await slowWorker(0);
        await B.settle(500);
        const v = await view(page);
        const toast = v.toast.includes(TOAST);
        const dropped = v.src === exp.replace('OZmega', 'Omega');
        const ok = v.src === exp || (dropped && toast);
        const tag = name.endsWith('-before') ? ' (CHA-6 class: fix-session-e)' : '';
        if (!check(nm, ok, `observed=${J(v.src)} expected=${J(exp)}${dropped ? ' (Z discarded, toast ' + toast + ')' : ''}${tag}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
