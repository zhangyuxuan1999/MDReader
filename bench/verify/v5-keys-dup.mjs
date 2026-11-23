// bench/verify/v5-keys-dup.mjs — verify-session-keys: variations of r3 J9 (the place rule: a resume after a split,
// a merge or a history step lands in the block where the gesture happened, also among identical blocks).
// Every case: a session at a needle (caret set in the DOM), a gesture, a pause of `w` ms (and a worker delay `d`),
// then type QR; the source must equal the expected text exactly.
//   MDR_PORT=5481 node bench/verify/v5-keys-dup.mjs [filter] [--waits 0,150,600] [--delay ms]
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--') && !/^[\d,]+$/.test(a)) ?? '';
const wi = args.indexOf('--waits'); const WAITS = wi >= 0 ? args[wi + 1].split(',').map(Number) : [0, 150, 600];
const di = args.indexOf('--delay'); const DELAY = di >= 0 ? Number(args[di + 1]) : 0;
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const press = (k) => page.keyboard.press(k);
// [name, doc, click needle (k, nth occurrence), caret needle in session (after|before, nth), gesture, expected]
const CASES = [
  ['enter-before-dup', 'a\n\nxdup\n\ndup\n\nz\n', ['xdup', 1, 0], ['x', 'after'], ['Enter'], 'a\n\nx\n\nQRdup\n\ndup\n\nz\n'],
  ['enter-end-of-2nd-of-3', 'a\n\ndup\n\ndup\n\ndup\n\nz\n', ['dup', 1, 1], ['dup', 'after'], ['Enter'], 'a\n\ndup\n\ndup\n\nQR\n\ndup\n\nz\n'],
  ['enter-start-of-2nd-of-3', 'a\n\ndup\n\ndup\n\ndup\n\nz\n', ['dup', 1, 1], ['dup', 'before'], ['Enter'], 'a\n\ndup\n\nQRdup\n\ndup\n\nz\n'],
  ['enter-mid-item', '- dup\n- dup\n- dup\n', ['dup', 1, 1], ['du', 'after', 1], ['Enter'], '- dup\n- du\n- QRp\n- dup\n'],
  ['enter-item-before-same', '- xsame\n- same\n', ['xsame', 1, 0], ['x', 'after'], ['Enter'], '- x\n- QRsame\n- same\n'],
  ['enter-heading-end', '## dup\n\n## dup\n\nz\n', ['dup', 1, 0], ['dup', 'after'], ['Enter'], '## dup\n\nQR\n\n## dup\n\nz\n'],
  ['bs-merge-3rd-into-2nd', 'dup\n\ndup\n\ndup\n\nz\n', ['dup', 1, 2], ['dup', 'before'], ['Backspace'], 'dup\n\ndupQRdup\n\nz\n'],
  ['bs-merge-item', '- dup\n- dup\n- dup\n', ['dup', 1, 2], ['dup', 'before', 2], ['Backspace'], '- dup\n- dupQRdup\n'],
  ['undo-enter', 'a\n\nxdup\n\ndup\n\nz\n', ['xdup', 1, 0], ['x', 'after'], ['Enter', 'wait', 'ControlOrMeta+z'], 'a\n\nxQRdup\n\ndup\n\nz\n'],
  ['redo-enter', 'a\n\nxdup\n\ndup\n\nz\n', ['xdup', 1, 0], ['x', 'after'], ['Enter', 'wait', 'ControlOrMeta+z', 'wait', 'ControlOrMeta+Shift+z'], 'a\n\nx\n\nQRdup\n\ndup\n\nz\n'],
  ['undo-type-2nd-of-3', 'dup\n\ndup\n\ndup\n\nz\n', ['dup', 1, 1], ['dup', 'after'], ['type:ab', 'wait', 'ControlOrMeta+z'], 'dup\n\ndupQR\n\ndup\n\nz\n'],
  ['undo-bs-merge', 'dup\n\ndup\n\ndup\n\nz\n', ['dup', 1, 2], ['dup', 'before'], ['Backspace', 'wait', 'ControlOrMeta+z'], 'dup\n\ndup\n\nQRdup\n\nz\n'],
  ['enter-twice-dup', 'a\n\nxdup\n\ndup\n\nz\n', ['xdup', 1, 0], ['x', 'after'], ['Enter', 'Enter'], 'a\n\nx\n\nQRdup\n\ndup\n\nz\n'],
];
let bad = 0;
try {
  for (const [name, doc, [cn, ck, cnth], [needle, side, cn2 = 0], gesture, expected] of CASES) {
    if (filter && !name.includes(filter)) continue;
    for (const w of WAITS) {
      try {
        await K.load(doc);
        await K.clickText(cn, ck, cnth); await sleep(300);
        if (!(await K.session())) throw new Error('no session');
        // caret: the needle's occurrence inside the session block (the block holds one occurrence or the first)
        await K.caretAfter(needle, side, cn2);
        if (DELAY) await K.setDelay(DELAY);
        for (const g of gesture) {
          if (g === 'wait') await sleep(700);
          else if (g.startsWith('type:')) await page.keyboard.type(g.slice(5));
          else await press(g);
        }
        if (w) await sleep(w);
        await page.keyboard.type('QR');
        await sleep(DELAY * 3 + 300);
        await K.idle(400);
        const sess = await K.session();
        await press('Escape'); await K.idle(300);
        const after = await K.src();
        const ok = after === expected;
        if (!ok) bad++;
        console.log(`RESULT ${name} w=${w}${DELAY ? ` d=${DELAY}` : ''} ${ok ? 'ok' : 'BAD'}${ok ? '' : ' ' + J({ expected, after, session: sess && sess.text, toasts: await K.toasts() })}`);
      } catch (e) { bad++; console.log(`RESULT ${name} w=${w} ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE bad=${bad}`); process.exit(bad ? 1 : 0); }
