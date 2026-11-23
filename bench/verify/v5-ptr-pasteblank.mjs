// bench/verify/v5-ptr-pasteblank.mjs — verify-session-pointer: U19 as amended / P-A "a paste is written once, where the
// caret is". Pasted texts with leading, trailing and inner blank lines, whitespace-only lines and CRLF, into a
// paragraph, a quote, a list item, a heading and a table cell, at the start / middle / end of the text; then 'TYPED' is
// typed at machine speed right after the paste (fast) or 500 ms later (slow). Checks: every non-blank pasted line is
// in the source exactly once, 'TYPED' exactly once and directly after the last pasted word (ignoring markup and
// whitespace between them), every word of the original document is still there, no invisible character the document
// did not hold, and (slow only) ONE ⌘Z after the typing and one more give the original source back.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-pasteblank.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, invisibleExtra, none, sessionOn, clickText } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const [SH, SN] = (process.env.SHARD || '0/1').split('/').map(Number);
const DOCS = {
  para: ['Alpha first words here.\n\nBravo second words.\n', 'first', 'Alpha', 'here.'],
  quote: ['> Quote first words here.\n\nBravo second words.\n', 'first', 'Quote', 'here.'],
  item: ['- Item first words here\n- Other item\n\nBravo second words.\n', 'first', 'Item', 'here'],
  heading: ['## Head first words here\n\nBravo second words.\n', 'first', 'Head', 'here'],
  cell: ['| Cell first words here | k |\n|---|---|\n| v | w |\n\nBravo second words.\n', 'first', 'Cell', 'here'],
};
const CR = String.fromCharCode(13);
const TEXTS = {
  lead: '\n\nPone ptwo',
  trail: 'Pone ptwo\n\n',
  inner: 'Pone\n\nPtwo',
  inner3: 'Pone\n\n\n\nPtwo\n\nPthree',
  ws: 'Pone\n   \nPtwo',
  crlf: 'Pone' + CR + '\n' + CR + '\nPtwo' + CR + '\nPtri',
  both: '\n\nPone\n\nPtwo\n\n',
  single: 'Pone\nPtwo',
};
const words = (s) => s.match(/[A-Za-z]{3,}/g) ?? [];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
let n = 0;
try {
  A = await openAt(CP, false);
  for (const [dk, [doc, clickNeedle, startWord, endWord]] of Object.entries(DOCS)) {
    for (const [tk, text] of Object.entries(TEXTS)) {
      for (const pos of ['start', 'mid', 'end']) {
        for (const speed of ['fast', 'slow']) {
          const nm = `${dk}-${tk}-${pos}-${speed}`;
          if (filter && !nm.includes(filter)) continue;
          if ((n++ % SN) !== SH) continue;
          try {
            await prepare(A, doc);
            await clickText(A.page, clickNeedle, 2); await sleep(350);
            const key = pos === 'start' ? 'Home' : pos === 'end' ? 'End' : null;
            if (key) { await A.page.keyboard.press(key); await sleep(80); }
            const live = await sessionOn(A.page);
            await A.page.evaluate((t) => navigator.clipboard.writeText(t), text);
            await A.page.keyboard.press('Meta+v');
            if (speed === 'slow') await sleep(500);
            await A.page.keyboard.type('TYPED');
            await sleep(900); await A.settle(200);
            const src = await A.source();
            let undo = null;
            if (speed === 'slow') {
              await A.page.keyboard.press('Meta+z'); await sleep(400); await A.settle(100);
              await A.page.keyboard.press('Meta+z'); await sleep(400); await A.settle(100);
              undo = await A.source();
            }
            await A.page.keyboard.press('Escape'); await A.settle(150);
            const probs = [];
            if (!live) probs.push('no session');
            const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            for (const l of lines) { const k = src.split(l).length - 1; if (k !== 1) probs.push(`"${l}"x${k}`); }
            const kt = src.split('TYPED').length - 1;
            if (kt !== 1) probs.push(`TYPEDx${kt}`);
            const lastWord = lines[lines.length - 1].split(/\s+/).pop();
            const flat = src.replace(/[^A-Za-z]/g, '');
            if (!flat.includes(lastWord + 'TYPED')) probs.push('TYPED-not-after-paste');
            for (const w of words(doc)) if (!src.includes(w)) probs.push('lost ' + w);
            const ix = invisibleExtra(src, doc);
            if (!none(ix)) probs.push('invisible ' + J(ix));
            if (speed === 'slow' && undo !== doc) probs.push('undo2!=orig');
            check(nm, probs.length === 0, `${probs.join(',')} src=${show(src)}${undo !== null && undo !== doc ? ` undo=${show(undo)}` : ''}`);
          } catch (e) { check(nm, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
        }
      }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
