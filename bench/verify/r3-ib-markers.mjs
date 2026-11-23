// bench/verify/r3-ib-markers.mjs — fix-session-b (round 3): H15, the session side. A paste that leaves the block no
// free internal marker set (every code point of U+E000–U+F8FF and U+FDD0–U+FDEF) must write nothing, end the session
// (the block re-renders from its unchanged source), show the toast 此块请在源码中编辑 and leave nothing behind (no
// uncaught error, no capture element holding the focus, no emptied element); a click on the block afterwards starts
// an ordinary session and typing works. Variants: a paste into a paragraph, into a list item, the glyphs typed into an
// emptied element, and an Enter (split) right after the paste.
//   MDR_PORT=5411 node bench/verify/r3-ib-markers.mjs [name-filter]          (exit code 1 on a failure)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText } from './v3-ses-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
async function waitSession(ms = 1500) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await view(page); if (v.editing && !v.capFocused) return v; await sleep(30); }
  return view(page);
}
/** Pastes the full private-use table at the caret of the session (a synthetic ClipboardEvent: the real clipboard
 *  would take seconds for 6400 characters). */
const pastePua = () => page.evaluate(() => {
  let s = '';
  for (let c = 0xe000; c <= 0xf8ff; c++) s += String.fromCharCode(c);
  for (let c = 0xfdd0; c <= 0xfdef; c++) s += String.fromCharCode(c);
  const el = document.querySelector('.mdr-preview .is-editing');
  const dt = new DataTransfer();
  dt.setData('text/plain', s);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return s.length;
});
const toastText = () => page.evaluate(() => Array.from(document.querySelectorAll('[class*="toast"]')).map((t) => t.textContent).join(' | '));
const puaShown = () => page.evaluate(() => new RegExp('[' + String.fromCharCode(0xe000) + '-' + String.fromCharCode(0xf8ff) + ']').test(document.querySelector('.mdr-preview').textContent));

const CASES = [
  // name, document, needle to click, what to do in the session before the paste, after the paste
  ['paragraph', '# PUA\n\nGlyphs: end\n\nz\n', 'Glyphs', async () => { await B.caretAt('Glyphs', 'after'); }, null],
  ['list-item', '- one\n- Glyphs: end\n\nz\n', 'Glyphs', async () => { await B.caretAt('Glyphs', 'after'); }, null],
  ['emptied-element', 'a\n\nGlyphs: end\n\nz\n', 'Glyphs', async () => { await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await settle(); }, null],
  ['then-enter', '# PUA\n\nGlyphs: end\n\nz\n', 'Glyphs', async () => { await B.caretAt('Glyphs', 'after'); }, async () => { await page.keyboard.press('Enter'); await page.keyboard.type('Q'); }],
];

let bad = 0;
try {
  await B.boot('mode=split');
  for (const [name, doc, needle, before, after] of CASES) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc);
      await B.mountLine(1);
      await sleep(650);
      await clickText(page, needle, 1, { side: 'right' });
      if (!(await waitSession()).editing) throw new Error('no session');
      await before();
      const ref = await B.source();
      const errs0 = B.pageErrors.length;
      await pastePua();
      if (after) await after();
      await settle(500);
      const v = await view(page);
      const toast = await toastText();
      const shown = await puaShown();
      const srcOk = v.src === ref;
      const ended = !v.editing && !v.capFocused && !v.ghost;
      const toastOk = toast.includes('此块请在源码中编辑');
      const noErr = B.pageErrors.length === errs0;
      // afterwards the block is an ordinary block again
      await page.keyboard.press('Escape'); await settle(200);
      await clickText(page, 'z', 0, { side: 'right' });
      const again = await waitSession();
      await page.keyboard.type('K');
      await settle();
      const typed = await B.source();
      const okAfter = !!again.editing && typed === ref.replace(/z\n$/, 'zK\n');
      const ok = srcOk && ended && toastOk && !shown && noErr && okAfter;
      if (!check(name, ok, `src ${srcOk ? 'unchanged' : 'CHANGED ' + J(v.src.slice(0, 60)) + ' len ' + v.src.length} ended=${ended} (editing=${!!v.editing} capFocused=${v.capFocused} ghost=${v.ghost}) toast=${J(toast)} puaShown=${shown} pageErrors=${J(B.pageErrors.slice(errs0, errs0 + 1)).slice(0, 160)} afterwards typed=${J(typed)}`)) bad++;
    } catch (e) { bad++; check(name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('console', J(B.consoleErrors.filter((x) => !/DevTools|Download/.test(x)).slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
