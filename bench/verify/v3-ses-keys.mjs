// bench/verify/v3-ses-keys.mjs — verify-session stage 2c: keys in the resume window (r1 G10, editCmdOf) against the
// same key in a live session. For each key K: caret after "abc" in "abc def ghi jkl", Enter, then K and "Q"
// (a) at once — K and Q are queued in the resume window and replayed (Selection.modify / execCommand);
// (b) after 600 ms — the new block's session is live and the browser handles K itself.
// Both must give the same source. Each case runs twice (FAST then WAIT); prints both sources on a mismatch.
// Run: MDR_PORT=5382 node bench/verify/v3-ses-keys.mjs [name-filter] [--block=list|quote|heading]     (exit 1 on a mismatch)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText } from './v3-ses-lib.mjs';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--')) || '';
const kind = (args.find((a) => a.startsWith('--block=')) || '--block=para').slice(8);
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 118_000), B.close);
const { page } = B;
const DOCS = {
  para: ['abc def ghi jkl\n\nzzz\n', 'abc'],
  list: ['- abc def ghi jkl\n- two\n\nzzz\n', 'abc'],
  quote: ['> abc def ghi jkl\n\nzzz\n', 'abc'],
  heading: ['# abc def ghi jkl\n\nzzz\n', 'abc'],
};
const [DOC, NEEDLE] = DOCS[kind];
const KEYS = [
  'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Shift+ArrowRight', 'Shift+ArrowLeft', 'Home', 'End', 'Shift+End',
  'Meta+ArrowRight', 'Meta+ArrowLeft', 'Meta+ArrowUp', 'Meta+ArrowDown', 'Meta+Shift+ArrowRight', 'Meta+Shift+ArrowLeft',
  'Alt+ArrowRight', 'Alt+ArrowLeft', 'Alt+Shift+ArrowRight', 'Alt+ArrowUp', 'Alt+ArrowDown',
  'Backspace', 'Delete', 'Alt+Backspace', 'Alt+Delete', 'Meta+Backspace', 'Meta+Delete',
  'Control+a', 'Control+e', 'Control+f', 'Control+b', 'Control+d', 'Control+h', 'Control+k', 'Control+n', 'Control+p', 'Control+t', 'Control+o',
  'Meta+a', 'Tab', 'Shift+Tab', 'PageDown', 'PageUp', 'Shift+Home',
];
async function once(key, wait) {
  await B.loadDoc(DOC);
  await sleep(650);
  await clickText(page, NEEDLE, 1);
  const t = Date.now();
  while (Date.now() - t < 1500 && !(await view(page)).editing) await sleep(30);
  await B.caretAt(NEEDLE, 'after');
  await page.keyboard.press('Enter');
  if (wait) {
    await sleep(600);
    await page.waitForFunction(() => { const e = document.querySelector('.mdr-preview .is-editing'); return !!e && document.activeElement === e; }, null, { timeout: 3000 }).catch(() => {});
  }
  await page.keyboard.press(key);
  await page.keyboard.type('Q');
  await sleep(500); await B.settle(200);
  const v = await view(page);
  return { src: v.src, live: !!v.editing && !v.capFocused, active: v.active };
}
let bad = 0;
try {
  await B.boot('mode=split');
  for (const key of KEYS) {
    if (filter && !key.includes(filter)) continue;
    try {
      const f = await once(key, false);
      await page.keyboard.press('Escape'); await B.settle(60);
      const w = await once(key, true);
      await page.keyboard.press('Escape'); await B.settle(60);
      const ok = f.src === w.src;
      if (!ok) bad++;
      check(`${kind}:${key}`, ok, ok ? J(w.src) : `FAST=${J(f.src)} (live=${f.live} active=${f.active}) WAIT=${J(w.src)} (live=${w.live})`);
    } catch (e) { bad++; check(`${kind}:${key}`, false, 'threw ' + String(e.message).split('\n')[0]); }
  }
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
