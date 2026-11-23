// bench/verify/v5-keys-pf.mjs — verify-session-keys: variations of r3 J8 (P-F: a click on a block whose re-render is
// pending waits, then the keys typed meanwhile land at the clicked place, in order, exactly once) and of CHA-2 /
// CHA-5 (a wait never takes the focus back; currentness by document versions). Switch ON, dev server on MDR_PORT.
// Worker messages are delayed by a FIFO (order kept) of `d` ms.
//   MDR_PORT=5481 node bench/verify/v5-keys-pf.mjs [scenario-filter] [--delays 0,100,400,1000,3000]
// ok = the source is the source before the click with QRS inserted right before the clicked character (nothing
// else changed), or (only when the wait is over its bound) QRS absent and the P-G toast shown.
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--') && !/^[\d,]+$/.test(a)) ?? '';
const di = args.indexOf('--delays');
const DELAYS = di >= 0 ? args[di + 1].split(',').map(Number) : [0, 100, 400, 1000, 3000];
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const DOC = 'intro para words\n\npara with MARKER inside and $x$ more\n\n- item one\n- item KEYTWO two\n\nend para\n';
const P_G = '预览尚未更新完，刚才的输入没有写入';
// each scenario: prepare (ends with the worker delay set), then the click target [needle, k], expectation
const SC = {
  // a session in the paragraph, Esc, click back into the same paragraph (its re-render pending)
  'esc-back': async (d) => { await K.clickText('words', 0); await sleep(250); await page.keyboard.type('ab'); await sleep(50); await K.setDelay(d); await page.keyboard.press('Escape'); return ['MARKER', 0]; },
  // typing in the paragraph, then a click into ANOTHER block releases it; then straight back into the paragraph
  'other-back': async (d) => { await K.clickText('with', 0); await sleep(250); await page.keyboard.type('ab'); await K.setDelay(d); await K.clickText('item one', 0); await sleep(30); return ['MARKER', 0]; },
  // typing in a list item, Esc, click back into the other item of the same list block
  'list-esc-back': async (d) => { await K.clickText('item one', 5); await sleep(250); await page.keyboard.type('ab'); await K.setDelay(d); await page.keyboard.press('Escape'); return ['KEYTWO', 0]; },
  // an editor-pane change of the paragraph (CHA-5: versions), then a click into it while the structure is behind
  'editor-then-click': async (d) => { await K.setDelay(d); await page.evaluate(() => { const v = window.__mdr.app.editor.view; const t = v.state.doc.toString(); const i = t.indexOf('inside'); v.dispatch({ changes: { from: i + 6, insert: ' ed' } }); }); await sleep(10); return ['MARKER', 0]; },
  // an editor-pane change ABOVE the paragraph (lines shift), then a click into the paragraph
  'editor-above-click': async (d) => { await K.setDelay(d); await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'new top\n\n' } }); }); await sleep(10); return ['MARKER', 0]; },
  // Cmd-Z inside the session (history resume pending) and a click into another block right away, then keys
  'undo-then-click': async (d) => { await K.clickText('words', 0); await sleep(250); await page.keyboard.type('ab'); await sleep(700); await K.setDelay(d); await page.keyboard.press('ControlOrMeta+z'); await sleep(20); return ['MARKER', 0]; },
  // Enter in the paragraph above (split resume pending), click into the next paragraph right away
  'split-then-click': async (d) => { await K.clickText('words', 0); await sleep(250); await K.setDelay(d); await page.keyboard.press('Enter'); await sleep(20); return ['MARKER', 0]; },
};
let bad = 0;
try {
  for (const [name, prep] of Object.entries(SC)) {
    if (filter && !name.includes(filter)) continue;
    for (const d of DELAYS) {
      try {
        await K.load(DOC);
        const [needle, k] = await prep(d);
        // the source the click is made on, as far as the user's gestures go (wait until everything arrived)
        await K.clickText(needle, k);
        const t0 = Date.now();
        await page.keyboard.type('QRS');
        const tgt = await page.evaluate(() => document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''));
        await sleep(Math.min(12000, d * 4 + 600));
        await K.idle(500);
        const sess = await K.session();
        await page.keyboard.press('Escape'); await K.idle(400);
        const after = await K.src();
        const toasts = await K.toasts();
        const qn = after.split('QRS').length - 1;
        const placed = after.includes('QRS' + needle.slice(k));
        // nothing else changed: remove QRS and compare with the text without the typed part of the scenario
        const others = ['intro', 'para', 'item one', 'two', 'end para', 'inside', '$x$', 'more'].filter((w) => !after.includes(w));
        const dropped = qn === 0 && toasts.includes(P_G);
        const ok = (qn === 1 && placed && others.length === 0) || (dropped && d >= 2500);
        if (!ok) bad++;
        console.log(`RESULT ${name} d=${d} ${ok ? 'ok' : 'BAD'} ${J({ qn, placed, others, after, toasts, keysTo: tgt, sessionAfter: sess && sess.text.slice(0, 60), ms: Date.now() - t0 })}`);
      } catch (e) { bad++; console.log(`RESULT ${name} d=${d} ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE bad=${bad}`); process.exit(bad ? 1 : 0); }
