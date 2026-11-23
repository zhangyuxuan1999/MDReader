// bench/verify/v5-keys-giant.mjs — verify-session-keys: P-F / J8 variations on a giant block (a paragraph with 400
// inline formulas, > 256 KB of HTML, so its re-render is deferred): a split (Enter), a history step (Cmd-Z), a click back
// after Esc, each followed AT ONCE by typed keys. Every key must arrive once, in order, at the right place; every
// formula must survive (count of "$x_{" in the source unchanged).
//   MDR_PORT=5481 node bench/verify/v5-keys-giant.mjs [case]
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const want = process.argv[2] ?? '';
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const N = 400;
const para = Array.from({ length: N }, (_, i) => (i === 200 ? 'MIDWORD here ' : '') + `w${i} $x_{${i}}$`).join(' ');
const DOC = `intro words\n\n${para}\n\nend words\n`;
const count = (s) => s.split('$x_{').length - 1;
let bad = 0;
const CASES = {
  'enter-type': async () => {
    await K.caretAfter('MIDWORD', 'before');
    await page.keyboard.press('Enter'); await page.keyboard.type('QRS');
    return (s) => s.includes('\n\nQRSMIDWORD') && s.split('QRS').length === 2;
  },
  'type-undo-type': async () => {
    await K.caretAfter('MIDWORD', 'before');
    await page.keyboard.type('ab'); await sleep(800);
    await page.keyboard.press('ControlOrMeta+z'); await page.keyboard.type('QRS');
    return (s) => s.includes('QRSMIDWORD') && !s.includes('ab') && s.split('QRS').length === 2;
  },
  'esc-clickback-type': async () => {
    await K.caretAfter('MIDWORD', 'before');
    await page.keyboard.type('ab'); await sleep(100);
    await page.keyboard.press('Escape'); await sleep(30);
    await K.clickText('here', 0);
    await page.keyboard.type('QRS');
    return (s) => s.includes('abMIDWORD QRShere') && s.split('QRS').length === 2;
  },
  'enter-enter-type': async () => {
    await K.caretAfter('MIDWORD', 'before');
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('QRS');
    return (s) => s.includes('QRSMIDWORD') && s.split('QRS').length === 2;
  },
  'bs-merge-type': async () => {
    await page.keyboard.press('Escape'); await K.idle(400); await sleep(2500); await K.idle(400);
    await K.clickText('end words', 0); await sleep(500);
    if (!(await K.session())) throw new Error('no session after the click on end words: ' + JSON.stringify(await page.evaluate(() => [document.activeElement?.className, getSelection().anchorNode?.parentElement?.className])));
    await K.caretAfter('end', 'before');
    await page.keyboard.press('Backspace'); await page.keyboard.type('QRS');
    return (s) => s.includes('$x_{399}$QRSend words') && s.split('QRS').length === 2;
  },
};
try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (want && !name.includes(want)) continue;
    try {
      await K.load(DOC);
      await K.clickText('MIDWORD', 2); await sleep(600);
      if (!(await K.session())) throw new Error('no session');
      const check = await fn();
      await sleep(4000);
      await K.idle(800);
      await sleep(1500);
      const sess = await K.session();
      await page.keyboard.press('Escape'); await K.idle(800);
      const after = await K.src();
      const toasts = await K.toasts();
      const ok = check(after) && count(after) === N;
      if (!ok) bad++;
      const i = after.indexOf('QRS');
      console.log(`RESULT ${name} ${ok ? 'ok' : 'BAD'} ${J({ formulas: count(after), around: i >= 0 ? after.slice(Math.max(0, i - 40), i + 40) : null, toasts, session: sess && sess.text.slice(0, 30) })}`);
    } catch (e) { bad++; console.log(`RESULT ${name} ERROR ${String(e.message).split('\n')[0]}`); }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE bad=${bad}`); process.exit(bad ? 1 : 0); }
