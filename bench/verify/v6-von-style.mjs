// bench/verify/v6-von-style.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): P-G (c) "presentation the
// browser invents is never written; a document's own is written as recorded" against Chromium's TYPING STYLE: when the
// whole text of a document's styled element is replaced, Chromium re-creates the style for the typed text on a new
// element that carries no stamp. Cases: select all the text of <span style="color:red"> / <font color="blue"> /
// <span style="font-weight:bold"> and type; Enter in the middle of a styled span then typing; Backspace that empties a
// styled span then typing. Prints the source and the screen (computed colour of the typed text) before and after Esc.
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-style.mjs      (5493 = the pre-r5 copy)
// Global timeout T_MS (default 100 s). Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const CASES = [
  ['replace-span-color', 'Text <span style="color:red">red words</span> end here\n', 'red words', 'NEW', 'select'],
  ['replace-font-color', 'Text <font color="blue">blue words</font> end here\n', 'blue words', 'NEW', 'select'],
  ['replace-span-bold', 'Text <span style="font-weight:bold">heavy words</span> end here\n', 'heavy words', 'NEW', 'select'],
  ['enter-in-span', 'Text <span style="color:red">red words</span> end here\n', 'red words', 'NEW', 'enter'],
  ['empty-by-bs', 'Text <span style="color:red">rw</span> end here\n', 'rw', 'NEW', 'bs'],
];
const colorOf = (page, needle) => page.evaluate((needle) => {
  const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) if (t.data.includes(needle)) { const cs = getComputedStyle(t.parentElement); return `${cs.color}|${cs.fontWeight}`; }
  return null;
}, needle);
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 100_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const { page } = A;
  for (const [n, doc, target, typed, how] of CASES) {
    try {
      await prepare(A, doc);
      await clickText(page, 'end here', 2); await sleep(400);
      const live = await sessionOn(page);
      await page.evaluate(({ target, how }) => {
        const el = document.querySelector('.mdr-preview .is-editing');
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) {
          const i = t.data.indexOf(target);
          if (i < 0) continue;
          if (how === 'select') getSelection().setBaseAndExtent(t, i, t, i + target.length);
          else if (how === 'enter') getSelection().setBaseAndExtent(t, i + 3, t, i + 3);
          else getSelection().setBaseAndExtent(t, i + target.length, t, i + target.length);
          return;
        }
      }, { target, how });
      if (how === 'enter') { await page.keyboard.press('Enter'); await sleep(300); }
      if (how === 'bs') { await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await sleep(200); }
      await page.keyboard.type(typed); await A.settle(350);
      const c1 = await colorOf(page, typed);
      await page.keyboard.press('Escape'); await A.settle(350);
      const src = await A.source();
      const c2 = await colorOf(page, typed);
      check(n, live && c1 === c2 && !src.includes('style="color: '), `live=${live} screen ${c1} -> ${c2} src=${show(src)}`);
    } catch (e) { check(n, false, 'threw ' + String(e?.message ?? e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
