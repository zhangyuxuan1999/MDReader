// bench/verify/v5-ptr-shift.mjs — verify-session-pointer: a press that ends a session whose block is taller on screen
// than what its source renders to (an emptied element kept on screen by U9, an empty list item made by Enter that has
// no source form, K16) makes the content below move up UNDER THE POINTER between the press and the release; the
// session then starts (U7: on release) in the block that moved there, and a double-click selects a word there, which
// the next typed text replaces. Each case takes the point of a word below, presses / releases with human timing
// (80 ms), types 'X', and checks which word was replaced / where X went. Control: the same click without the earlier
// session.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-shift.mjs [name-substring] [hold-ms]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, pointOf, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const HOLD = Number(process.argv[3] || 80);
const DOC = 'Alpha line one.\n\nBravo para two.\n\nCharlie line three.\n\nDelta line four.\n\nEcho line five.\n\nFoxtrot six.\n';
const LIST = '- aaa item\n- bbb item\n\nCharlie line three.\n\nDelta line four.\n\nEcho line five.\n\nFoxtrot six.\n';
const C = [
  // [name, doc, setup(B), target word, clicks, expected source]
  ['emptied-dblclick-below', DOC, async (B) => { await clickText(B.page, 'Bravo', 2); await sleep(350); await B.page.keyboard.press('Meta+a'); await sleep(80); await B.page.keyboard.press('Backspace'); await sleep(400); }, 'four', 2,
    'Alpha line one.\n\nCharlie line three.\n\nDelta line X.\n\nEcho line five.\n\nFoxtrot six.\n'],
  ['emptied-click-below', DOC, async (B) => { await clickText(B.page, 'Bravo', 2); await sleep(350); await B.page.keyboard.press('Meta+a'); await sleep(80); await B.page.keyboard.press('Backspace'); await sleep(400); }, 'four', 1,
    'Alpha line one.\n\nCharlie line three.\n\nDelta line fXour.\n\nEcho line five.\n\nFoxtrot six.\n'],
  ['emptyitem-dblclick-below', LIST, async (B) => { await clickText(B.page, 'bbb item', 7, { side: 'right' }); await sleep(350); await B.page.keyboard.press('End'); await B.page.keyboard.press('Enter'); await sleep(400); }, 'four', 2,
    null],
  ['emptied-tripleclick-below', DOC, async (B) => { await clickText(B.page, 'Bravo', 2); await sleep(350); await B.page.keyboard.press('Meta+a'); await sleep(80); await B.page.keyboard.press('Backspace'); await sleep(400); }, 'four', 3,
    'Alpha line one.\n\nCharlie line three.\n\nX\n\nEcho line five.\n\nFoxtrot six.\n'],
  ['emptied-esc-dblclick-below', DOC, async (B) => { await clickText(B.page, 'Bravo', 2); await sleep(350); await B.page.keyboard.press('Meta+a'); await sleep(80); await B.page.keyboard.press('Backspace'); await sleep(400); await B.page.keyboard.press('Escape'); await sleep(400); }, 'four', 2,
    'Alpha line one.\n\nCharlie line three.\n\nDelta line X.\n\nEcho line five.\n\nFoxtrot six.\n'],
  ['control-dblclick', DOC, async (B) => { await clickText(B.page, 'Bravo', 2); await sleep(350); await B.page.keyboard.press('Escape'); await sleep(400); }, 'four', 2,
    'Alpha line one.\n\nBravo para two.\n\nCharlie line three.\n\nDelta line X.\n\nEcho line five.\n\nFoxtrot six.\n'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const [name, doc, setup, word, clicks, want] of C) {
    if (filter && !name.includes(filter)) continue;
    for (let run = 1; run <= Number(process.env.RUNS || 1); run++) {
      try {
        await prepare(A, doc);
        await setup(A);
        const p = await pointOf(A.page, word, 1, 'left', false);
        const under = await A.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('section.md-block')?.textContent?.slice(0, 30), p);
        await A.page.mouse.move(p.x, p.y);
        for (let k = 1; k <= clicks; k++) { await A.page.mouse.down({ clickCount: k }); await sleep(HOLD); await A.page.mouse.up({ clickCount: k }); if (k < clicks) await sleep(60); }
        await sleep(300);
        const sel = await A.page.evaluate(() => getSelection().toString());
        const live = await sessionOn(A.page);
        await A.page.keyboard.type('X');
        await sleep(700); await A.settle(150);
        const src = await A.source();
        await A.page.keyboard.press('Escape'); await A.settle(100);
        const expected = want ?? doc.replace('four', 'X');
        const ok = want === null ? src.includes('Delta line X.') || src.includes('Delta line fXour.') : src === expected;
        check(`${name}#${run}`, ok, `underAtPress=${J(under)} selected=${J(sel)} live=${live} src=${show(src)}`);
      } catch (e) { check(`${name}#${run}`, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
