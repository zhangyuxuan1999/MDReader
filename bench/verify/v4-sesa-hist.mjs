// bench/verify/v4-sesa-hist.mjs — verify-session-a: U22 (H13 and P1 variations): where the caret is after ⌘Z / ⇧⌘Z in
// a session, at block boundaries and in blocks that the step creates or removes, and undo into / out of an empty
// document. Each case: fresh document, real click on `click` (right half of its 2nd character), caret put by `at`
// ([needle, 'after'|'before'] or a key), steps, exact expected source; then Esc, ⌘Z to the original and ⇧⌘Z
// back to the final source (byte for byte both ways).
// Steps: ['k', key] ['t', text] ['w', ms] ['fast', ...keys|chars].
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-hist.mjs [name-filter]   (T_MS = global timeout, default 400 s)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, undoTo, redoTo, waitSession, load, caretCtx, caretTo } from './v4-sesa-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 400_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const W = ['w', 700];
const cases = [];
const add = (name, doc, click, at, steps, want, opt = {}) => cases.push({ name, doc, click, at, steps, want, ...opt });
const NEWPARA = [['k', 'Enter'], ['w'], ['t', 'def'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]];

add('para-newpara-undo', 'abc\n\nzzz\n', 'abc', 'End', NEWPARA, 'abcQ\n\nzzz\n');
// integrate (round 4): J6's Expected ('- one⏎- two⏎- Q', P-D) when Enter and the typed word are two history steps; the
// grouped outcome stays accepted, as v4-sesa-repro SESA-2 undo-to-empty-item does.
add('list-newitem-undo', '- one\n- two\n\nz\n', 'two', 'End', NEWPARA, (s) => s === '- one\n- twoQ\n\nz\n' || s === '- one\n- two\n- Q\n\nz\n');
add('task-newitem-undo', '- [ ] one\n- [ ] two\n\nz\n', 'two', 'End', NEWPARA, (s) => s === '- [ ] one\n- [ ] twoQ\n\nz\n' || s === '- [ ] one\n- [ ] two\n- [ ] Q\n\nz\n');
add('heading-newpara-undo', '# Head\n\nzzz\n', 'Head', 'End', NEWPARA, '# HeadQ\n\nzzz\n');
add('quote-newpara-undo', '> qqq\n\nzzz\n', 'qqq', 'End', NEWPARA, '> qqqQ\n\nzzz\n');
add('code-newline-undo', '```\ncode\n```\n\nzzz\n', 'code', 'End', NEWPARA, (s) => s === '```\ncodeQ\n```\n\nzzz\n' || s === '```\ncode\nQ\n```\n\nzzz\n');
add('last-newpara-undo', 'aaa\n\nabc\n', 'abc', 'End', NEWPARA, 'aaa\n\nabcQ\n');
add('last-nonl-newpara-undo', 'aaa\n\nabc', 'abc', 'End', NEWPARA, 'aaa\n\nabcQ');
add('lead-newpara-undo', '\nabc\n\nzzz\n', 'abc', 'End', NEWPARA, '\nabcQ\n\nzzz\n');
add('twoblank-newpara-undo', 'abc\n\n\n\nzzz\n', 'abc', 'End', NEWPARA, 'abcQ\n\n\n\nzzz\n');
add('para-newpara-redo', 'abc\n\nzzz\n', 'abc', 'End', [['k', 'Enter'], ['w'], ['t', 'def'], W, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 500]], 'abc\n\ndefQ\n\nzzz\n');
add('list-newitem-redo', '- one\n- two\n\nz\n', 'two', 'End', [['k', 'Enter'], ['w'], ['t', 'def'], W, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 500]], '- one\n- two\n- defQ\n\nz\n');
add('mid-type-undo', 'abc def ghi\n\nzzz\n', 'abc', ['def', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'abc defQ ghi\n\nzzz\n');
add('mid-type-undo-math', 'a1 $x^2$ b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'a1 $x^2$ b1Q yy\n\nzzz\n');
add('mid-type-redo-math', 'a1 $x^2$ b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 500]], 'a1 $x^2$ b1XYQ yy\n\nzzz\n');
add('mid-type-undo-img', 'see ![i](https://e.example/i.png) b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'see ![i](https://e.example/i.png) b1Q yy\n\nzzz\n');
add('mid-type-undo-link', 'see [link text](https://e.example/a/b/c) b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'see [link text](https://e.example/a/b/c) b1Q yy\n\nzzz\n');
add('mid-type-undo-html', 'see <b>bold</b> b1 yy\n\nzzz\n', 'yy', ['b1', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'see <b>bold</b> b1Q yy\n\nzzz\n');
add('mid-type-undo-fnref', 'see[^1] b1 yy\n\n[^1]: note\n', 'yy', ['b1', 'after'], [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'see[^1] b1Q yy\n\n[^1]: note\n');
add('empty-block-undo', 'aaa\n\nxx para\n\nzz\n', 'para', 'End', [['k', 'Meta+a'], ['k', 'Backspace'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === 'aaa\n\nxx paraQ\n\nzz\n' || s === 'aaa\n\nQxx para\n\nzz\n', { note: 'Q in the restored block' });
add('empty-block-undo-redo', 'aaa\n\nxx para\n\nzz\n', 'para', 'End', [['k', 'Meta+a'], ['k', 'Backspace'], W, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === 'aaa\n\nQ\n\nzz\n' || s === 'aaaQ\n\nzz\n');
add('merge-undo', 'a1 xx\n\nb1 yy\n\nzz\n', 'yy', 'Meta+ArrowLeft', [['k', 'Backspace'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === 'a1 xx\n\nQb1 yy\n\nzz\n' || s === 'a1 xxQ\n\nb1 yy\n\nzz\n');
add('merge-undo-redo', 'a1 xx\n\nb1 yy\n\nzz\n', 'yy', 'Meta+ArrowLeft', [['k', 'Backspace'], W, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 500]], 'a1 xxQb1 yy\n\nzz\n');
add('item-merge-undo', '- a1\n- b1\n\nzz\n', 'b1', 'Meta+ArrowLeft', [['k', 'Backspace'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === '- a1\n- Qb1\n\nzz\n' || s === '- a1Q\n- b1\n\nzz\n');
add('first-newpara-undo', 'abc\n\nzzz\n', 'abc', 'Meta+ArrowLeft', [['k', 'Enter'], ['w'], ['k', 'ArrowUp'], ['t', 'N'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === 'Qabc\n\nzzz\n');
// U22 'before': the first block with a leading blank line (U14)
add('lead-first-newpara-undo', '\nabc\n\nzzz\n', 'abc', 'Meta+ArrowLeft', [['k', 'Enter'], ['w'], ['k', 'ArrowUp'], ['t', 'N'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === '\nQabc\n\nzzz\n');
add('lead-type-start-undo', '\nabc\n\nzzz\n', 'abc', 'Meta+ArrowLeft', [['t', 'XY'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], '\nQabc\n\nzzz\n');
add('lead-type-start-redo', '\nabc\n\nzzz\n', 'abc', 'Meta+ArrowLeft', [['t', 'XY'], W, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 500]], '\nXYQabc\n\nzzz\n');
add('code-trailing-blank-undo', '```\ncode\n```\n\nzzz\n', 'code', 'End', [['k', 'Escape'], ['w'], ['click', 'zzz'], ['k', 'Meta+ArrowLeft'], ['k', 'Backspace'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === '```\ncode\n```\n\nQzzz\n' || s === '```\ncodeQ\n```\n\nzzz\n');
add('newpara-after-img-undo', 'see ![i](https://e.example/i.png)\n\nzzz\n', 'see', 'End', [['k', 'Enter'], ['w'], ['t', 'new'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], 'see ![i](https://e.example/i.png)Q\n\nzzz\n');
add('newpara-after-code-undo', 'see `cd`\n\nzzz\n', 'see', 'End', [['k', 'Enter'], ['w'], ['t', 'new'], W, ['k', 'Meta+z'], W, ['t', 'Q'], ['w', 500]], (s) => s === 'see `cd`Q\n\nzzz\n' || s === 'see `cdQ`\n\nzzz\n');
// P1 class: undo / redo into and out of an empty document
const EMPTY_ONLY = [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['t', 'N'], W];
add('p1-undo2-fast', 'x\n', 'x', 'End', [...EMPTY_ONLY, ['fast', 'Meta+z', 'Meta+z'], ['w', 900], ['t', 'Q'], ['w', 600]], (s) => s === 'xQ\n' || s === 'Qx\n');
add('p1-undo2-nonl', 'xy', 'xy', 'End', [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['t', 'N'], W, ['fast', 'Meta+z', 'Meta+z'], ['w', 900], ['t', 'Q'], ['w', 600]], (s) => s === 'xyQ' || s === 'Qxy');
add('p1-heading', '# x\n', 'x', 'End', [...EMPTY_ONLY, ['fast', 'Meta+z', 'Meta+z'], ['w', 900], ['t', 'Q'], ['w', 600]], (s) => s === '# xQ\n' || s === '# Qx\n');
add('p1-lead', '\nxy\n', 'xy', 'End', [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['t', 'N'], W, ['fast', 'Meta+z', 'Meta+z'], ['w', 900], ['t', 'Q'], ['w', 600]], (s) => s === '\nxyQ\n' || s === '\nQxy\n');
add('p1-redo-chain', 'x\n', 'x', 'End', [...EMPTY_ONLY, ['fast', 'Meta+z', 'Meta+z', 'Meta+Shift+z', 'Meta+Shift+z'], ['w', 1200], ['t', 'Q'], ['w', 600]], (s) => s === 'NQ\n');
add('p1-undo-slow-then-redo', 'x\n', 'x', 'End', [...EMPTY_ONLY, ['k', 'Meta+z'], W, ['k', 'Meta+Shift+z'], W, ['t', 'Q'], ['w', 600]], (s) => s === 'NQ\n' || s === 'N\n', { note: 'after the empty-document resume ends typing needs a click (fixer-stated)' });
add('p1-undo-fast-type', 'x\n', 'x', 'End', [...EMPTY_ONLY, ['fast', 'Meta+z', 'Q'], ['w', 900]], (s) => s === '' || s === '\n' || s === 'Q\n', { note: 'Q after undo to empty' });
add('p1-two-blocks', 'x\n\nyy\n', 'x', 'End', [['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['k', 'Escape'], ['w'], ['k', 'Escape'], ['w'], ['click', 'yy'], ['k', 'Meta+a'], ['k', 'Backspace'], ['w'], ['t', 'N'], W, ['fast', 'Meta+z', 'Meta+z', 'Meta+z'], ['w', 1200], ['t', 'Q'], ['w', 600]], (s) => /^(xQ\n\nyy|x\n\nQ?yyQ?|Qx\n\nyy)\n$/.test(s));

let bad = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await load(B, c.doc);
      await clickText(page, c.click, Math.min(1, c.click.length - 1), { side: 'right' });
      const v0 = await waitSession(page);
      if (!v0.editing) throw new Error('no session ' + J(v0));
      await sleep(80);
      if (Array.isArray(c.at)) await caretTo(page, c.at[0], c.at[1]); else await page.keyboard.press(c.at);
      await sleep(80);
      let cAfter = null;
      for (const st of c.steps) {
        const [op, a] = st;
        if (op === 'k') { await page.keyboard.press(a); if (/Meta\+(Shift\+)?z/.test(a)) cAfter = null; }
        else if (op === 't') { if (cAfter === null) cAfter = await caretCtx(page); await page.keyboard.type(a); }
        else if (op === 'w') await settle(a ?? 320);
        else if (op === 'click') { await clickText(page, a, 1, { side: 'right' }); await waitSession(page); }
        else if (op === 'fast') { for (const k of st.slice(1)) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); } }
      }
      const v = await view(page);
      const ok = typeof c.want === 'function' ? c.want(v.src) : v.src === c.want;
      await page.keyboard.press('Escape'); await settle(200);
      const fin = await B.source();
      const u = await undoTo(B, c.doc, 14, 150);
      const r = u.ok ? await redoTo(B, fin, 14, 150) : { ok: false, now: '' };
      if (!check(c.name, ok && u.ok && r.ok, `src=${J(v.src)}${ok ? '' : ' want=' + (typeof c.want === 'function' ? '(pred)' : J(c.want))} caretAtLastType=${J(cAfter)} editing=${J(v.editing && v.editing.text.slice(0, 30))} active=${v.active} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)} redo=${r.ok ? r.n : 'FAIL ' + J(r.now)}${c.note ? ' (' + c.note + ')' : ''}`)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
