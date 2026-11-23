// bench/verify/v5-chb-pb.mjs — challenge-b (round 4): variations of CHA-5 (P-B amended: currentness by document
// versions) built on challenger A's v5-cha-pb.mjs. Other block kinds (code, nested list, quote, raw HTML, display formula),
// an editor-pane change instead of a session write, the history / paste / merge resumes, click at the line start and end,
// keys at human speed during the wait, and a delay beyond the 10 s bound (P-G: one toast, nothing written). After each
// case: Esc, then the editor's undo back to the original byte for byte.
// (Header of the original:) P-B with a slow worker. A session's write changes the line
// count of the document above a block C (Enter, a paste of two paragraphs, an emptied block); the structure update
// is delayed by `delay` ms (the slow-worker hook of v3-ses-preview.mjs: structure deltas and HTML both held); `wait`
// ms after the write the user clicks into C and types Z. P-B: the session on C may start only on a wrapper that
// shows C's CURRENT source, so Z must land where it was clicked and nothing else may change.
// Run: MDR_PORT=5486 node bench/verify/v5-chb-pb.mjs [case ...]   (RUNS=n repeats every case)
// Writes nothing into the tree.
process.env.MDR_SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v5-chb/lib';
const { openB, sleep, globalTimeout, J, check, summary, view, clickText, waitSession, load, caretTo } = await import('./v4-sesa-lib.mjs');

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
const TOAST = '预览尚未更新完，刚才的输入没有写入';
// [name, doc, start needle, caret after, keys ('esc' = Escape; 'editor:<text>' types <text> at the editor's start
//  instead of a session; 'paste:<text>'), delay, wait, click needle, k (-1: end of needle), typed, want, want toast]
const C = [
  ['code-nb', 'Alpha beta\n\n```\ncode line\n```\n\nOmega words\n', 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 1, 'Z', 'Alpha\n\nbeta\n\n```\ncode line\n```\n\nOZmega words\n'],
  ['code-click', 'Alpha beta\n\n```\ncode line\n```\n\nOmega words\n', 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'code line', 2, 'Z', 'Alpha\n\nbeta\n\n```\ncoZde line\n```\n\nOmega words\n'],
  ['nested', 'Alpha beta\n\n- a\n  - inner two\n', 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'inner', 1, 'Z', 'Alpha\n\nbeta\n\n- a\n  - iZnner two\n'],
  ['quote', 'Alpha beta\n\n> quote line\n', 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'quote', 1, 'Z', 'Alpha\n\nbeta\n\n> qZuote line\n'],
  ['rawhtml-nb', 'Alpha beta\n\n<div>raw</div>\n\nOmega words\n', 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 1, 'Z', 'Alpha\n\nbeta\n\n<div>raw</div>\n\nOZmega words\n'],
  ['math-nb', 'Alpha beta\n\n$$\nx^2\n$$\n\nOmega words\n', 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 1, 'Z', 'Alpha\n\nbeta\n\n$$\nx^2\n$$\n\nOZmega words\n'],
  ['line-start', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'Omega', 0, 'Z', 'Alpha\n\nbeta\n\nGamma delta\n\nZOmega words\n'],
  ['line-end', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 1200, 'words', -1, 'Z', 'Alpha\n\nbeta\n\nGamma delta\n\nOmega wordsZ\n'],
  ['human-keys', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 1800, 300, 'Omega', 1, 'ZYX', 'Alpha\n\nbeta\n\nGamma delta\n\nOZYXmega words\n'],
  ['editor-top', D1, null, null, ['editor:New\n\n'], 1800, 300, 'Omega', 1, 'Z', 'New\n\nAlpha beta\n\nGamma delta\n\nOZmega words\n'],
  ['editor-top-same', D1, null, null, ['editor:New\n\n'], 1800, 300, 'Alpha', 1, 'Z', 'New\n\nAZlpha beta\n\nGamma delta\n\nOmega words\n'],
  ['editor-del-line', 'Top\n\n' + D1, null, null, ['editor-del'], 1800, 300, 'Gamma', 1, 'Z', 'Alpha beta\n\nGZamma delta\n\nOmega words\n'],
  ['paste-paras', D1, 'Alpha', 'Alpha', ['paste:P1\n\nP2', 'esc'], 1800, 1200, 'Omega', 1, 'Z', 'AlphaP1\n\nP2 beta\n\nGamma delta\n\nOZmega words\n'],
  ['undo-then-type', D1, 'Alpha', 'Alpha', ['X', 'wait:700', 'Meta+z'], 1800, 0, null, 0, 'Q', 'AlphaQ beta\n\nGamma delta\n\nOmega words\n'],
  ['merge-then-type', D1, 'Gamma', 'Gamma', ['Home', 'Backspace'], 1800, 0, null, 0, 'Q', 'Alpha betaQGamma delta\n\nOmega words\n'],
  ['split-then-type', D1, 'Alpha', 'Alpha', ['Enter'], 1800, 0, null, 0, 'Q', 'Alpha\n\nQbeta\n\nGamma delta\n\nOmega words\n'],
  ['beyond-bound', D1, 'Alpha', 'Alpha', ['Enter', 'esc'], 11500, 300, 'Omega', 1, 'Z', 'Alpha\n\nbeta\n\nGamma delta\n\nOmega words\n', true],
];
let bad = 0;
import { readFileSync } from 'node:fs';
const TAIL = process.env.MDR_BIG ? '\n' + readFileSync(new URL('../../test-data/' + process.env.MDR_BIG, import.meta.url), 'utf8') : '';
try {
  await B.boot('mode=split');
  for (const [name, doc0, start, at, keys, delay0, wait, click, k, typed, exp0, wantToast] of C) {
    const doc = doc0 + TAIL, exp = exp0 + TAIL, delay = TAIL ? 0 : delay0;
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${run ? '#' + run : ''}`;
      try {
        await slowWorker(0);
        await load(B, doc);
        await page.evaluate(() => { window.__chbT = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.textContent) window.__chbT.push(n.textContent); }).observe(document.querySelector('.mdr-toasts') || document.body, { childList: true, subtree: true }); });
        if (start) {
          await clickText(page, start, Math.min(1, start.length - 1), { side: 'right' });
          const v0 = await waitSession(page);
          if (!v0.editing) throw new Error('no session');
          await sleep(80);
          await caretTo(page, at, 'after');
          await sleep(80);
        }
        await slowWorker(delay);
        for (const key of keys) {
          if (key.startsWith('editor:')) { await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: 0 } }); }); await page.keyboard.type(key.slice(7)); }
          else if (key === 'editor-del') { await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: 0, head: 5 } }); }); await page.keyboard.press('Backspace'); }
          else if (key.startsWith('paste:')) { await page.evaluate((t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, key.slice(6)); }
          else if (key.startsWith('wait:')) await sleep(Number(key.slice(5)));
          else if (key === 'esc') await page.keyboard.press('Escape');
          else if (key.length === 1) await page.keyboard.type(key);
          else await page.keyboard.press(key);
          await sleep(30);
        }
        if (wait) await sleep(wait);
        if (click) {
          if (k === -1) await clickText(page, click, click.length - 1, { side: 'right' });
          else await clickText(page, click, k, { side: 'left' });
          await sleep(60);
        }
        for (const ch of typed) { await page.keyboard.type(ch); if (name.startsWith('human')) await sleep(300); }
        await sleep(delay + 600);
        await slowWorker(0);
        await settle(600);
        const v = await view(page);
        const ts = await page.evaluate(() => (window.__chbT || []).filter((t) => t.includes('预览尚未更新完')).length);
        const ok = v.src === exp && (wantToast ? ts >= 1 : ts === 0);
        if (!check(nm, ok, `observed=${J(v.src)} expected=${J(exp)} dropToasts=${ts} editing=${J(v.editing && v.editing.text.slice(0, 30))}`)) bad++;
        await page.keyboard.press('Escape'); await settle(300);
        for (let u = 0; u < 10 && (await B.source()) !== doc; u++) { await page.evaluate(() => window.__mdr.app.editor.view.focus()); await page.keyboard.press('Meta+z'); await sleep(150); }
        const back = await B.source();
        if (!check(nm + ':undo', back === doc, `after undo=${J(back)}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
