// bench/verify/v5-ptr-splitbr.mjs — verify-session-pointer: after a paste of paragraphs into a paragraph (the session
// splits the block and resumes in the last pasted paragraph), the caret must be at the end of the pasted text. When the
// last pasted paragraph holds line breaks (hard breaks), the text typed next lands that many characters early, inside
// the pasted text. Cases vary the number of line breaks in the last pasted paragraph, CRLF vs LF, the block (paragraph,
// quote), and the wait before typing.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-splitbr.mjs [name-substring]
import { sleep, globalTimeout, check, summary, openAt, prepare, results, CP, show, sessionOn, clickText } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const CR = String.fromCharCode(13);
const C = [
  ['para-lf-1br', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Pone\n\nPtwo\nPtri', 'PtriTYPED'],
  ['para-lf-2br', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Pone\n\nPtwo\nPtri\nPfour', 'PfourTYPED'],
  ['para-crlf-1br', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Pone' + CR + '\n' + CR + '\nPtwo' + CR + '\nPtri', 'PtriTYPED'],
  ['para-lf-0br-control', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Pone\n\nPtwo Ptri', 'PtriTYPED'],
  ['para-lf-1br-no-split-control', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Ptwo\nPtri', 'PtriTYPED'],
  ['para-lf-1br-wait1500', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Pone\n\nPtwo\nPtri', 'PtriTYPED', 1500],
  ['para-lf-first-has-br', 'Alpha first words here.\n\nBravo second words.\n', 'here', 'Pone\nPuno\n\nPtwo', 'PtwoTYPED'],
  ['para-lf-1br-mid', 'Alpha first words here.\n\nBravo second words.\n', 'words', 'Pone\n\nPtwo\nPtri', 'PtriTYPED'],
  ['quote-lf-1br', '> Quote first words here.\n\nBravo second words.\n', 'here', 'Pone\n\nPtwo\nPtri', 'PtriTYPED'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const [name, doc, needle, text, want, wait] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await prepare(A, doc);
      await clickText(A.page, needle, 1); await sleep(350);
      await A.page.keyboard.press(needle === 'here' ? 'End' : 'ArrowLeft'); await sleep(80);
      const live = await sessionOn(A.page);
      await A.page.evaluate((t) => navigator.clipboard.writeText(t), text);
      await A.page.keyboard.press('Meta+v');
      await sleep(wait ?? 500);
      await A.page.keyboard.type('TYPED');
      await sleep(900); await A.settle(200);
      const src = await A.source();
      await A.page.keyboard.press('Escape'); await A.settle(150);
      const flat = src.replace(/[^A-Za-z]/g, '');
      check(name, live && flat.includes(want), `want ...${want} src=${show(src)}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
