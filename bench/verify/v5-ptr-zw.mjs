// bench/verify/v5-ptr-zw.mjs — verify-session-pointer: P-A (J2 class) by variation. In a session, put the block into a
// state with helper characters (a line-leading formula, Enter before an atom inside formatting, a paste over a
// selection, ⌘E inline code, an undo resume, an emptied element, an opened formula), in blocks whose OWN rendering
// holds zero-width characters (KaTeX subscripts / fractions put U+200B into their vlist: the session then trusts only
// its registry) and in blocks that hold none. Then copy (or cut) the selection, end the session with Esc, and check:
//   clip   : the clipboard (text/plain and text/html) holds no more U+200B / U+FEFF than KaTeX's own markup inside the
//            selection, and no other invisible code point the document does not hold;
//   dom    : after Esc no zero-width character is left in the preview outside KaTeX's markup;
//   src    : the source after Esc, and after the clipboard is pasted into the editor pane, holds no invisible character
//            the document did not hold.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-zw.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, prepare, results, CP, show, invisibleExtra, none, readClip, copyKey, domZw, pasteIntoEditor, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const R = (n) => Array(n).fill(['key', 'ArrowRight', { after: 30 }]);
const C = [
  ['sub-lead-selall', '$x_1$ starts here and $a_2$ end\n\nnext\n', [['click', ['starts', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['sub-lead-cut', '$x_1$ starts here and $a_2$ end\n\nnext\n', [['click', ['starts', 2]], ['key', 'Meta+a', { after: 150 }]], 'Meta+x'],
  ['sub-lead-shifthome', '$x_1$ starts here and $a_2$ end\n\nnext\n', [['click', ['end', 2, 'right']], ['key', 'Shift+Home', { after: 150 }]]],
  ['sub-item-selall', '- $x_1$ item one\n- two $b_2$\n\nnext\n', [['click', ['item one', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['sub-item2-shiftup', '- plain zero\n- $x_1$ item one\n- two $b_2$\n\nnext\n', [['click', ['item one', 2]], ['key', 'Shift+ArrowUp', { after: 100 }], ['key', 'Shift+ArrowUp', { after: 150 }]]],
  ['sub-cell-selall', '| h | k |\n|---|---|\n| $x_1$ cell | $y$ c2 |\n\nnext\n', [['click', ['cell', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['sub-heading-selall', '# $x_1$ heading text\n\nnext\n', [['click', ['heading', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['sub-quote-selall', '> $x_1$ quoted text\n> $z$ second line\n\nnext\n', [['click', ['quoted', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['sub-hardbreak-selall', 'first line $q_1$  \n$z$ after break\n\nnext\n', [['click', ['after', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['plain-hardbreak-shiftup', 'first line  \n$z$ after break\n\nnext\n', [['click', ['break', 2]], ['key', 'Shift+ArrowUp', { after: 150 }]]],
  ['enter-bold-formula', '**bold $x$ tail** end\n\nnext\n', [['click', ['bold', 0]], ...R(5), ['key', 'Enter', { after: 400 }], ['key', 'Meta+a', { after: 150 }]]],
  ['enter-bold-formula-sub', '**bold $x$ tail** end $y_2$\n\nnext\n', [['click', ['bold', 0]], ...R(5), ['key', 'Enter', { after: 400 }], ['key', 'Meta+a', { after: 150 }]]],
  ['enter-bold-formula-sub-shift', '**bold $x$ tail** end $y_2$\n\nnext\n', [['click', ['bold', 0]], ...R(5), ['key', 'Shift+Enter', { after: 300 }], ['key', 'Meta+a', { after: 150 }]]],
  ['enter-em-two-atoms-sub', '*lead $x$$y$ more* end $y_2$\n\nnext\n', [['click', ['lead', 0]], ...R(5), ['key', 'Enter', { after: 400 }], ['key', 'Meta+a', { after: 150 }]]],
  ['enter-link-image-sub', '[see ![im](x.png) more](http://e.x/) end $y_2$\n\nnext\n', [['click', ['see', 0]], ...R(4), ['key', 'Enter', { after: 400 }], ['key', 'Meta+a', { after: 150 }]]],
  ['enter-then-type-sub', '**bold $x$ tail** end $y_2$\n\nnext\n', [['click', ['bold', 0]], ...R(5), ['key', 'Enter', { after: 400 }], ['type', 'Q'], ['key', 'Home', { after: 80 }], ['key', 'Shift+End', { after: 150 }]]],
  ['paste-over-bold-sub', 'Lead **bold** tail $y_2$\n\nnext\n', [['click', ['tail', 2]], ['click', ['bold', 1], { clickCount: 2, after: 250 }], ['paste', 'X'], ['key', 'Meta+a', { after: 150 }]]],
  ['paste-over-link-sub', 'Lead [link](http://e.x/) tail $y_2$\n\nnext\n', [['click', ['tail', 2]], ['click', ['link', 1], { clickCount: 2, after: 250 }], ['paste', 'X Y'], ['key', 'Meta+a', { after: 150 }]]],
  ['paste-over-code-sub', 'Lead `code` tail $y_2$\n\nnext\n', [['click', ['tail', 2]], ['click', ['code', 1], { clickCount: 2, after: 250 }], ['paste', 'X'], ['key', 'Meta+a', { after: 150 }]]],
  ['paste-over-formula-sel-sub', 'Lead a $x$ b tail $y_2$\n\nnext\n', [['click', ['tail', 2]], ['drag', ['Lead', 5], ['b tail', 1], { steps: 8 }], ['paste', 'Z'], ['key', 'Meta+a', { after: 150 }]]],
  ['code-toggle-sub', 'Lead text here $y_2$\n\nnext\n', [['click', ['here', 0]], ['key', 'Meta+e', { after: 150 }], ['type', 'abc'], ['key', 'ArrowRight', { after: 80 }], ['type', 'Z'], ['key', 'Meta+a', { after: 150 }]]],
  ['code-toggle-empty-sub', '$y_2$ Lead here\n\nnext\n', [['click', ['here', 0]], ['key', 'Meta+e', { after: 150 }], ['key', 'Shift+Home', { after: 150 }]]],
  ['code-toggle-twice-sub', '$y_2$ Lead here\n\nnext\n', [['click', ['here', 0]], ['key', 'Meta+e', { after: 150 }], ['key', 'Meta+e', { after: 150 }], ['type', 'W'], ['key', 'Shift+Home', { after: 150 }]]],
  ['undo-resume-sub', '$x_1$ starts here\n\nnext\n', [['click', ['here', 3, 'right']], ['type', 'QQ', { after: 500 }], ['key', 'Meta+z', { after: 500 }], ['key', 'Meta+a', { after: 150 }]]],
  ['emptied-then-type-sub', 'Para one $a_1$\n\n$x$ second para\n\nthird\n', [['click', ['second', 2]], ['key', 'Meta+a', { after: 100 }], ['key', 'Backspace', { after: 300 }], ['type', 'N $q$', { after: 300 }], ['key', 'Meta+a', { after: 150 }]]],
  ['opened-formula-sub', '$x_1$ starts here\n\nnext\n', [['click', { css: '.md-math', fx: 0.5 }, { after: 300 }], ['key', 'End', { after: 80 }], ['type', 'y'], ['key', 'Meta+a', { after: 150 }]]],
  ['paste-paras-sub', 'Lead text here $y_2$\n\nnext\n', [['click', ['text', 4]], ['paste', '$m$ one\n\n$n$ two', { after: 700 }], ['key', 'Meta+a', { after: 150 }]]],
  ['drag-cell-sub', '| h | k |\n|---|---|\n| $x_1$ cell | $y$ c2 |\n\nnext\n', [['click', ['cell', 2]], ['drag', { css: 'td .md-math', fx: 0.05 }, ['cell', 3, 'right'], { steps: 8 }]]],
  ['frac-lead-selall', '$\\frac{a}{b}$ lead text\n\nnext\n', [['click', ['lead', 2]], ['key', 'Meta+a', { after: 150 }]]],
  ['frac-lead-cut', '$\\frac{a}{b}$ lead text\n\nnext\n', [['click', ['lead', 2]], ['key', 'Meta+a', { after: 150 }]], 'Meta+x'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  for (const [name, doc, steps, key] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await prepare(A, doc);
      await runSteps(A.page, steps);
      const live = await sessionOn(A.page);
      const kz = await A.page.evaluate(() => {
        const s = getSelection(); if (!s.rangeCount) return 0;
        const r = s.getRangeAt(0); let n = 0;
        for (const k of document.querySelectorAll('.mdr-preview .katex-html')) {
          const tw = document.createTreeWalker(k, 4);
          for (let t = tw.nextNode(); t; t = tw.nextNode()) if (r.intersectsNode(t)) for (const c of t.data) if (c.charCodeAt(0) === 0x200b) n++;
        }
        return n;
      });
      const clip = await copyKey(A.page, key || 'Meta+c');
      await sleep(150);
      const srcLive = await A.source();
      await A.page.keyboard.press('Escape'); await A.settle(250);
      const dz = await domZw(A.page);
      const src = await A.source();
      await pasteIntoEditor(A.page, clip.plain);
      const src2 = await A.source();
      const zwPlain = [...clip.plain].filter((c) => c.charCodeAt(0) === 0x200b || c.charCodeAt(0) === 0xfeff).length;
      const plainOther = invisibleExtra(clip.plain.split(String.fromCharCode(0x200b)).join(''), doc);
      const srcX = invisibleExtra(src, doc);
      const src2X = invisibleExtra(src2.slice(src.length), doc + (zwPlain <= kz ? clip.plain : ''));
      const ok = live && zwPlain <= kz && none(plainOther) && dz.length === 0 && none(srcX) && none(src2X);
      check(name, ok, `live=${live} katexZwInSel=${kz} clipZw=${zwPlain} clipOther=${J(plainOther)} domZwAfterEsc=${J(dz)} srcExtra=${J(srcX)} pastedExtra=${J(src2X)} src=${show(src)} srcLive=${show(srcLive)} clip=${show(clip.plain.slice(0, 120))}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
