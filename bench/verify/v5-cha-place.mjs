// bench/verify/v5-cha-place.mjs — challenge-a (round 4): variations of J9 (a resume finds its block by its place, the
// expected text is only a check): blocks with IDENTICAL text; a session on one of them (by line), a split / paste /
// merge / Cmd-Z resume, then typing. The typed text must land in the block at the place of the gesture.
// Run: MDR_PORT=5485 node bench/verify/v5-cha-place.mjs [case-prefix ...]   (MDR_DELAY=ms slow worker; RUNS=n)
// Writes nothing into the tree.
import { openB, sleep, globalTimeout, J, check, summary, view, waitSession, load, caretTo } from './v4-sesa-lib.mjs';

const only = process.argv.slice(2);
const B = await openB({ clipboard: true });
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
const P3 = 'same words\n\nsame words\n\nsame words\n\nend\n';
// [name, doc, line to click, caret after (in the editing block), steps, want]
const C = [
  ['split-2nd-para', P3, 3, 'same', [['k', 'Enter'], ['w', 50], ['t', 'Q']], 'same words\n\nsame\n\nQwords\n\nsame words\n\nend\n'],
  ['split-3rd-para', P3, 5, 'same', [['k', 'Enter'], ['w', 50], ['t', 'Q']], 'same words\n\nsame words\n\nsame\n\nQwords\n\nend\n'],
  ['split-1st-para', P3, 1, 'same', [['k', 'Enter'], ['w', 50], ['t', 'Q']], 'same\n\nQwords\n\nsame words\n\nsame words\n\nend\n'],
  ['split-end-2nd-para', P3, 3, 'words', [['k', 'Enter'], ['w', 50], ['t', 'Q']], 'same words\n\nsame words\n\nQ\n\nsame words\n\nend\n'],
  ['item-2nd-list', '- same\n- same\n\nmid\n\n- same\n- same\n', 6, null, [['k', 'End'], ['k', 'Enter'], ['w', 50], ['t', 'Q']], '- same\n- same\n\nmid\n\n- same\n- same\n- Q\n'],
  ['heading-2nd', '## same\n\n## same\n\nend\n', 3, 'same', [['k', 'Enter'], ['w', 50], ['t', 'Q']], '## same\n\n## same\n\nQ\n\nend\n'],
  ['quote-2nd', '> same\n\nmid\n\n> same\n', 5, null, [['k', 'End'], ['k', 'Enter'], ['w', 50], ['t', 'Q']], (s) => s === '> same\n\nmid\n\n> same\n>\n> Q\n'],
['merge-tight-heading-dup', '## same\n\nsame\n\n## same\n\nsame\n', 7, null, [['home'], ['k', 'Backspace'], ['w', 50], ['t', 'Q']], '## same\n\nsame\n\n## same\n\nQsame\n'],
  ['paste-2nd-para', P3, 3, 'words', [['p', 'P1\n\nP2'], ['w', 50], ['t', 'Q']], 'same words\n\nsame wordsP1\n\nP2Q\n\nsame words\n\nend\n'],
  ['merge-3rd-into-2nd', 'aaa\n\nsame\n\nsame\n\nsame\n', 5, null, [['home'], ['k', 'Backspace'], ['w', 50], ['t', 'Q']], 'aaa\n\nsameQsame\n\nsame\n'],
  ['undo-2nd-para', P3, 3, 'words', [['t', 'XY'], ['w', 700], ['k', 'Meta+z'], ['w', 50], ['t', 'Q']], 'same words\n\nsame wordsQ\n\nsame words\n\nend\n'],
  ['undo-split-2nd', P3, 3, 'same', [['k', 'Enter'], ['w', 700], ['k', 'Meta+z'], ['w', 50], ['t', 'Q']], 'same words\n\nsameQ words\n\nsame words\n\nend\n'],
];
let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, line, at, steps, exp] of C) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (let run = 0; run < Number(process.env.RUNS ?? 1); run++) {
      const nm = `${name}${DELAY ? '-d' + DELAY : ''}${run ? '#' + run : ''}`;
      try {
        await slowWorker(0);
        await load(B, doc);
        await B.clickLine(line, 'last');
        const v0 = await waitSession(page);
        if (!v0.editing) throw new Error('no session');
        const startedAt = await page.evaluate(() => { const pv = window.__mdr.app.preview; const el = document.querySelector('.mdr-preview .is-editing'); const n = window.__mdr.app.editor.view.state.doc.lines; for (let l = 1; l <= n; l++) { const b = pv.blockAtLine(l); if (b && pv.elementOfBlock(b.id) === el) return b.startLine; } return -1; });
        if (process.env.DEBUG) console.log('started on line', startedAt);
        await sleep(80);
        if (at) await caretTo(page, at, 'after');
        await sleep(80);
        await slowWorker(DELAY);
        for (const st of steps) {
          if (st[0] === 'k') await page.keyboard.press(st[1]);
          else if (st[0] === 't') await page.keyboard.type(st[1]);
          else if (st[0] === 'w') await sleep(st[1] + DELAY);
          else if (st[0] === 'home') await page.keyboard.press('Meta+ArrowLeft');
          else if (st[0] === 'p') { await page.evaluate((t) => navigator.clipboard.writeText(t), st[1]); await page.keyboard.press('Meta+v'); }
        }
        await sleep(DELAY * 2 + 300);
        await slowWorker(0);
        await settle(600);
        const v = await view(page);
        const ok = typeof exp === 'function' ? exp(v.src) : v.src === exp;
        if (!check(nm, ok, `observed=${J(v.src)} expected=${typeof exp === 'function' ? '(see script)' : J(exp)}`)) bad++;
      } catch (e) { bad++; check(nm, false, 'threw ' + String(e.message).split('\n')[0]); }
      try { await slowWorker(0); await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
    }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
