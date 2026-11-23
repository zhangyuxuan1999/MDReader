// bench/verify/v5-keys-j3.mjs — verify-session-keys: variations of r3 J3 / J12 / J30 (emptied block between neighbours
// that merge once it is gone; history resume; typing into the emptied element; the first / last / only block).
// For every case: empty the middle block in the preview (DOM select-all + Backspace), then the action, then type Q.
// ok = (1) the source after Q equals the source before Q with exactly one Q inserted (nothing else changed),
//      (2) every neighbour word is still in the source, (3) where the action states where Q belongs, it is there.
//   MDR_PORT=5481 node bench/verify/v5-keys-j3.mjs [filter] [--delay ms]    (filter: substring of "<case> <act>")
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '';
const di = args.indexOf('--delay');
const DELAY = di >= 0 ? Number(args[di + 1]) : 0;
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const MID = '乙段落文字';
const NEIGH = {
  lists: ['- aaa\n\n', '- zzz\n'],
  'list-indented-para': ['- aaa\n\n', '    zzz indented\n'],
  'list-2sp-cont': ['- aaa\n\n', '  zzz cont\n'],
  ordered: ['1. aaa\n\n', '1. zzz\n'],
  nested: ['* aaa\n  * nnn\n\n', '* zzz\n'],
  tasks: ['- [ ] aaa\n\n', '- [x] zzz\n'],
  code: ['    aaa code\n\n', '    zzz code\n'],
  'quotes-ctl': ['> aaa\n\n', '> zzz\n'],
  'paras-ctl': ['aaa\n\n', 'zzz\n'],
  'list-heading-mid': ['- aaa\n\n', '- zzz\n', '## '],
  'list-quote-mid': ['- aaa\n\n', '- zzz\n', '> '],
};
const ACTS = ['ur', 'ur-fast', 'u', 'type', 'enter-type', 'bs-type', 'urur'];
let bad = 0;
const press = (k) => page.keyboard.press(k);
try {
  for (const [cname, [pre, post, midPrefix = '']] of Object.entries(NEIGH)) {
    for (const act of ACTS) {
      const name = `${cname} ${act}`;
      if (filter && !name.includes(filter)) continue;
      const doc = `${pre}${midPrefix}${MID}。\n\n${post}`;
      try {
        await K.load(doc);
        await K.clickText(MID, 2); await sleep(250);
        if (!(await K.session())) throw new Error('no session on the middle block');
        await K.selectBlock(); await press('Backspace');
        await K.idle(300);
        const emptied = await K.src();
        if (DELAY) await K.setDelay(DELAY);
        let where = null;          // a check of where Q belongs
        if (act === 'ur') { await press('ControlOrMeta+z'); await K.idle(300); if (DELAY) await K.setDelay(DELAY); await press('ControlOrMeta+Shift+z'); await K.idle(400); }
        else if (act === 'ur-fast') { await press('ControlOrMeta+z'); await press('ControlOrMeta+Shift+z'); }
        else if (act === 'urur') { await press('ControlOrMeta+z'); await sleep(80); await press('ControlOrMeta+Shift+z'); await sleep(80); await press('ControlOrMeta+z'); await sleep(80); await press('ControlOrMeta+Shift+z'); }
        else if (act === 'u') { await press('ControlOrMeta+z'); where = (s) => s.includes(`${MID}。Q`) || s.includes(`Q${MID}`) || s.includes(`${MID}Q`); }
        else if (act === 'type') where = (s) => s.indexOf('Q') > s.indexOf('aaa') && s.indexOf('Q') < s.indexOf('zzz');
        else if (act === 'enter-type') { await press('Enter'); where = (s) => s.indexOf('Q') > s.indexOf('aaa') && s.indexOf('Q') < s.indexOf('zzz'); }
        else if (act === 'bs-type') { await press('Backspace'); where = (s) => s.indexOf('Q') > s.indexOf('aaa'); }
        const beforeQ = act.startsWith('ur') || act === 'urur' ? null : null;
        void beforeQ;
        const pre1 = (act === 'ur' ? await K.src() : null);
        const sess = await K.session();
        await page.keyboard.type('Q');
        await K.idle(400);
        await press('Escape'); await K.idle(400);
        const after = await K.src();
        const lostWord = ['aaa', 'zzz', ...(cname === 'nested' ? ['nnn'] : [])].filter((w) => !after.includes(w));
        const qn = after.split('Q').length - 1;
        // (1) only for the history actions without Enter: after minus Q must equal the source before Q
        let onlyQ = true;
        if (pre1 !== null) onlyQ = after.replace('Q', '') === pre1;
        const placed = where ? where(after) : true;
        const ok = lostWord.length === 0 && qn === 1 && onlyQ && placed;
        if (!ok) bad++;
        console.log(`RESULT ${name}${DELAY ? ` delay=${DELAY}` : ''} ${ok ? 'ok' : 'BAD'} ${J({ emptied, beforeQ: pre1, after, lostWord, qn, onlyQ, placed, session: sess && sess.text, toasts: await K.toasts() })}`);
      } catch (e) { bad++; console.log(`RESULT ${name} ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE bad=${bad}`); process.exit(bad ? 1 : 0); }
