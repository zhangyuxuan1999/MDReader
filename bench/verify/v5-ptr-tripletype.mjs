// bench/verify/v5-ptr-tripletype.mjs — verify-session-pointer: a triple-click (whole line / block selected) in a
// session, then ArrowRight (collapse to the end) or End, then typing: the typed text must be in the source, at the end
// of the clicked line. Found by v5-ptr-fuzz seed 26: after a triple-click on a heading and ArrowRight x2 the typed
// tokens never reach the source although a session is live. Prints where the typed text is in the session DOM, the
// source while the session is live, and after Esc.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-tripletype.mjs [name-substring]  (RUNS=n)
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const C = [
  ['heading-formula-right2', '# Head Aaa with $x^2$ formula\n\nPara Bbb end.\n', 'with', ['ArrowRight', 'ArrowRight']],
  ['heading-formula-right1', '# Head Aaa with $x^2$ formula\n\nPara Bbb end.\n', 'with', ['ArrowRight']],
  ['heading-plain-right1', '# Head Aaa with plain words\n\nPara Bbb end.\n', 'with', ['ArrowRight']],
  ['heading-plain-right2', '# Head Aaa with plain words\n\nPara Bbb end.\n', 'with', ['ArrowRight', 'ArrowRight']],
  ['para-right1', 'Para Aaa with plain words\n\nNext Bbb end.\n', 'with', ['ArrowRight']],
  ['para-right2', 'Para Aaa with plain words\n\nNext Bbb end.\n', 'with', ['ArrowRight', 'ArrowRight']],
  ['item-right1', '- item Aaa with words\n- other\n\nNext Bbb end.\n', 'with', ['ArrowRight']],
  ['item-right2', '- item Aaa with words\n- other\n\nNext Bbb end.\n', 'with', ['ArrowRight', 'ArrowRight']],
  ['last-item-right2', '- other\n- item Aaa with words\n\nNext Bbb end.\n', 'with', ['ArrowRight', 'ArrowRight']],
  ['quote-right2', '> quote Aaa with words\n\nNext Bbb end.\n', 'with', ['ArrowRight', 'ArrowRight']],
  ['heading-end', '# Head Aaa with plain words\n\nPara Bbb end.\n', 'with', ['End']],
  ['para-down', 'Para Aaa with plain words\n\nNext Bbb end.\n', 'with', ['ArrowDown']],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const [name, doc, needle, keys] of C) {
    if (filter && !name.includes(filter)) continue;
    for (let run = 1; run <= Number(process.env.RUNS || 1); run++) {
      try {
        await prepare(A, doc);
        await clickText(A.page, needle, 1, { clickCount: 1 }); await sleep(350);   // a session first (as the fuzz had)
        const p = await A.page.evaluate(() => 0);
        await clickText(A.page, needle, 1, { clickCount: 1 }); await sleep(30);
        await clickText(A.page, needle, 1, { clickCount: 2 }); await sleep(30);
        await clickText(A.page, needle, 1, { clickCount: 3 }); await sleep(300);
        const selText = await A.page.evaluate(() => getSelection().toString());
        for (const k of keys) { await A.page.keyboard.press(k); await sleep(80); }
        const where = await A.page.evaluate(() => { const s = getSelection(); const n = s.focusNode; const e = n?.nodeType === 1 ? n : n?.parentElement; return { in: e ? e.tagName + '.' + (e.className || '') : null, block: e?.closest('section.md-block')?.dataset.id ?? null, editingBlock: document.querySelector('.mdr-preview .is-editing')?.dataset.id ?? null, inEditing: !!e?.closest('.is-editing') }; });
        const live = await sessionOn(A.page);
        await A.page.keyboard.type('TYPED'); await sleep(700); await A.settle(150);
        const shown = await A.page.evaluate(() => document.querySelector('.mdr-preview')?.textContent.includes('TYPED'));
        const srcLive = await A.source();
        await A.page.keyboard.press('Escape'); await A.settle(300);
        const src = await A.source();
        const k = src.split('TYPED').length - 1;
        check(`${name}#${run}`, k === 1, `sel=${J(selText)} caret=${J(where)} live=${live} shownInPreview=${shown} inSourceLive=${srcLive.includes('TYPED')} src=${show(src)}`);
      } catch (e) { check(`${name}#${run}`, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
