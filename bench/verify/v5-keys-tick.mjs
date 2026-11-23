// bench/verify/v5-keys-tick.mjs — verify-session-keys: variations of CHA-1 (switch ON): a task checkbox clicked in a
// block a session has just released (its re-render pending under a worker delay), or while a session is live in the
// same or another block. The CLICKED task must be ticked, or nothing with the toast 没有勾选… — never another task.
//   MDR_PORT=5481 node bench/verify/v5-keys-tick.mjs [filter] [--delays 0,300,1000]
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--') && !/^[\d,]+$/.test(a)) ?? '';
const di = args.indexOf('--delays'); const DELAYS = di >= 0 ? args[di + 1].split(',').map(Number) : [0, 300, 1000];
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const DOC = 'intro para\n\n- [ ] alpha one\n- [ ] beta two\n- [ ] gamma three\n\nplain para\n';
const NOT = '没有勾选：该任务项刚被改动，请再点一次';
const boxPoint = (label) => page.evaluate((label) => {
  const li = Array.from(document.querySelectorAll('.mdr-preview li')).find((l) => l.textContent.includes(label));
  const b = li && li.querySelector('input[type=checkbox]'); if (!b) return null;
  const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, label);
const SC = {
  // typing in item alpha, Esc, click beta's box at once
  'esc-then-box': async () => { await K.clickText('alpha', 2); await sleep(250); await page.keyboard.type('X'); return { esc: true, box: 'beta' }; },
  // Enter in alpha makes a new item; Esc; click gamma's box (the ordinals shift by one)
  'enter-esc-box': async () => { await K.clickText('alpha', 2); await sleep(250); await K.caretAfter('alpha one'); await page.keyboard.press('Enter'); await page.keyboard.type('new item'); return { esc: true, box: 'gamma' }; },
  // a live session in the list (no Esc): click beta's box
  'live-same-block': async () => { await K.clickText('alpha', 2); await sleep(250); await page.keyboard.type('X'); return { esc: false, box: 'beta' }; },
  // a live session in another block: click beta's box
  'live-other-block': async () => { await K.clickText('plain', 2); await sleep(250); await page.keyboard.type('X'); return { esc: false, box: 'beta' }; },
  // typing in beta itself, Esc, click beta's box
  'esc-own-item': async () => { await K.clickText('beta', 2); await sleep(250); await page.keyboard.type('X'); return { esc: true, box: 'beta' }; },
  // Backspace-join gamma into beta inside the session, Esc, click alpha's box
  'join-esc-box': async () => { await K.clickText('gamma', 0); await sleep(250); await K.caretAfter('gamma', 'before'); await page.keyboard.press('Backspace'); return { esc: true, box: 'alpha' }; },
};
let bad = 0;
try {
  for (const [name, prep] of Object.entries(SC)) {
    if (filter && !name.includes(filter)) continue;
    for (const d of DELAYS) {
      try {
        await K.load(DOC);
        const { esc, box } = await prep();
        await K.setDelay(d);
        if (esc) await page.keyboard.press('Escape');
        await sleep(15);
        const pt = await boxPoint(box);
        if (!pt) throw new Error('no box ' + box);
        await page.mouse.click(pt.x, pt.y);
        await sleep(d * 4 + 600); await K.idle(500);
        await page.keyboard.press('Escape'); await K.idle(300);
        const after = await K.src();
        const toasts = await K.toasts();
        const ticked = after.split('\n').filter((l) => /^\s*- \[x\]/.test(l));
        const right = ticked.length === 1 && ticked[0].includes(box);
        const none = ticked.length === 0 && toasts.includes(NOT);
        const ok = right || none;
        if (!ok) bad++;
        console.log(`RESULT ${name} d=${d} ${ok ? (right ? 'ok' : 'ok-toast') : 'BAD'} ${J({ ticked, toasts, after })}`);
      } catch (e) { bad++; console.log(`RESULT ${name} d=${d} ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE bad=${bad}`); process.exit(bad ? 1 : 0); }
