// bench/verify/v7-vf-sneak.mjs — verify-refs (round 6): can a session add a character that is not plainly visible
// without the user putting it in? Gestures that make the BROWSER or the SESSION produce such characters: deleting a word
// between spaces (Chromium keeps the two spaces visible with U+00A0), deleting up to a block end, Shift+Enter, Tab,
// a formula at a line start (the session's zero-width spacer) in an item, a cell and after Enter / Backspace, select-all
// and type, bold / italic / code across a reference, a copy inside the session pasted back (the session's own
// clipboard text, captured with a synthetic copy event: no system clipboard), a cut + paste into another block,
// undo after a refused write. Verdicts: ok (nothing added raw), REFUSED (the guard refused: visible), BYPASS (added raw
// and no refusal: the class rule G closes), and the user's typed text kept or LOST.
// Run: MDR_PORT=<server with hooks> node bench/verify/v7-vf-sneak.mjs [filter]   (T_MS, default 110000)
import { launch, openApp, load, source, toasts, clickAt, caret, paste, esc, editing, rawAdded, strDiff, show, globalTimeout, sleep, C } from './v7-vf-lib.mjs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = new RegExp(process.argv[2] ?? '.');
const T_MS = Number(process.env.T_MS ?? 110000);
const key = (k) => async (A) => { await A.page.keyboard.press(k); await sleep(120); };
const type = (t) => async (A) => { await A.page.keyboard.type(t, { delay: 10 }); await sleep(80); return t; };
const at = (n, o, l) => async (A) => { if (!(await caret(A, n, o, l))) throw new Error('caret ' + n); };
const startOf = async (A) => A.page.evaluate(() => { const s = getSelection(); const n = s.anchorNode; const p = (n.nodeType === 1 ? n : n.parentElement).closest('p, li, td, th, h1, h2, h3, section'); const r = document.createRange(); r.setStart(p, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r); });
/** The session's own copy: a synthetic copy event whose DataTransfer the session's handler fills. */
let clip = null;
const copy = (kind = 'copy') => async (A) => {
  clip = await A.page.evaluate((kind) => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    if (!ev.defaultPrevented) { const t = getSelection().toString(); if (kind === 'cut') document.execCommand('delete'); return { text: t, html: null, handled: false }; }
    return { text: dt.getData('text/plain'), html: dt.getData('text/html'), handled: true };
  }, kind);
  await sleep(150);
};
const pasteClip = async (A) => { await paste(A, clip.text, clip.html || undefined); await sleep(150); return clip.text; };

const P = '# Sneak\n\n';
const CASES = [
  ['del-word-between-spaces', P + 'one two three four words\n', 'three', [at('two', 3), key('Backspace'), key('Backspace'), key('Backspace')]],
  ['del-to-block-end', P + 'one two three\n\nnext\n', 'three', [at('three', 5), key('Backspace'), key('Backspace'), key('Backspace'), key('Backspace'), key('Backspace')]],
  ['del-space-run', P + 'a&nbsp;&nbsp;b and c d words\n', 'words', [at('c d', 2), key('Backspace'), type(' ')]],
  ['shift-enter', P + 'line one words\n', 'one', [at('one'), key('Shift+Enter'), type('two')]],
  ['tab-paragraph', P + 'tab here words\n', 'here', [at('here'), key('Tab'), type('x')]],
  ['tab-list', P + '- item one\n- item two\n', 'two', [at('item two', 0), key('Tab'), type('x')]],
  ['formula-item-start', P + '- $x+1$ after words\n- next\n', 'after', [at('after', 0), startOf, type('Q')]],
  ['formula-cell-start', P + '| a | b |\n| --- | --- |\n| $y$ tail | cell words |\n', 'cell', [at('tail', 0), startOf, type('Q')]],
  ['formula-enter-before', P + 'text $z^2$ more words\n', 'more', [at('text', 5), key('Enter'), type('Q')]],
  ['formula-join-to-start', P + 'first line\n\n$w$ second words\n', 'second', [at('second', 0), startOf, key('Backspace'), type('Q')]],
  ['formula-heading-start', P + '## $h$ heading words\n', 'heading', [at('heading', 0), startOf, type('Q')]],
  ['selectall-type', P + 'a&shy;b c&zwnj;d e&#x3000;f words\n', 'words', [key('Meta+a'), type('new text')]],
  ['bold-across-ref', P + 'Donau&shy;dampf&shy;schiff words\n', 'words', [at('Donau', 0, 9), key('Meta+b')]],
  ['italic-across-ref', P + 'می&zwnj;خواهم here words\n', 'here', [at('here', 0, 4), key('Meta+i'), at('words'), type('X')]],
  ['code-across-ref', P + 'a&emsp;b code words\n', 'code', [at('a', 0, 3), key('Meta+e')]],
  ['copy-paste-same-block', P + 'Donau&shy;dampf and x words\n', 'words', [at('Donau', 0, 9), copy(), at('words'), pasteClip]],
  ['copy-paste-other-block', P + 'Donau&shy;dampf and x words\n\nplain other para\n', 'words', [at('Donau', 0, 9), copy(), key('Escape'), async (A) => { await clickAt(A, 'plain other', 0, 2); }, at('para'), pasteClip]],
  ['cut-paste-other-block', P + 'Kon&shy;sti&shy;tu&shy;tion words\n\nplain other para\n', 'words', [at('Kon', 0, 14), copy('cut'), key('Escape'), async (A) => { await clickAt(A, 'plain other', 0, 2); }, at('para'), pasteClip]],
  ['copy-paste-persian', P + 'نامه&zwnj;ها and x words\n\nplain other para\n', 'words', [at('نامه', 0, 7), copy(), key('Escape'), async (A) => { await clickAt(A, 'plain other', 0, 2); }, at('para'), pasteClip]],
  ['copy-url-text-paste', P + 'See https://e.example/a%E2%80%AEb here words\n\nplain other para\n', 'words', [at('https', 0, 20), copy(), key('Escape'), async (A) => { await clickAt(A, 'plain other', 0, 2); }, at('para'), pasteClip]],
  ['enter-empty-item', P + '- one\n- two\n', 'two', [at('two'), key('Enter'), key('Enter'), type('after')]],
  ['bs-empty-task', P + '- [ ] one\n- [ ] two\n', 'two', [at('two'), key('Enter'), key('Backspace'), type('z')]],
  ['space-at-end', P + 'ends here\n\nnext para\n', 'here', [at('here'), type('  '), key('Escape')]],
  ['spaces-around-ref', P + 'a &shy; b words\n', 'words', [at('a', 1), type('  '), at('words'), type(' ')]],
  ['empty-block-type', P + 'above&emsp;para words\n\nmid a&shy;b c&zwnj;d words\n\nbelow&#x3000;para\n', 'mid', [key('Meta+a'), key('Backspace', 400), type('新文字')]],
  ['empty-block-esc', P + 'above&emsp;para words\n\nmid a&shy;b c&zwnj;d words\n\nbelow&#x3000;para\n', 'mid', [key('Meta+a'), key('Backspace', 400)]],
  ['empty-block-undo', P + 'above&emsp;para words\n\nmid a&shy;b c&zwnj;d words\n\nbelow&#x3000;para\n', 'mid', [key('Meta+a'), key('Backspace', 600), key('Meta+z', 600), at('words'), type('Q')]],
  ['empty-item-type', P + '- one&ensp;x\n- two&shy;y words\n- three&#x200E;z\n', 'two', [at('two', 0, 9), key('Backspace', 400), type('新')]],
  ['ref-then-format-undo', P + 'x&#x2009;y and z words\n', 'words', [at('and', 0, 3), key('Meta+b'), key('Meta+z'), key('Meta+Shift+z'), at('words'), type('Q')]],
];
const FILTERED = CASES.filter((c) => filter.test(c[0]));

let browser;
const stop = globalTimeout(T_MS, async () => browser?.close());
const tally = {};
try {
  browser = await launch();
  const A = await openApp(browser, port, { perf: true });
  for (const [name, doc, needle, steps] of FILTERED) {
    A.guard.length = 0; clip = null;
    await load(A, doc, name + '.md');
    const t0 = await toasts(A);
    const on = await clickAt(A, needle, 0, 1);
    let typed = '', err = null;
    if (on) {
      try { for (const s of steps) { const r = await s(A); if (typeof r === 'string') typed += r; } } catch (e) { err = String(e.message || e); }
    }
    await sleep(300);
    await esc(A);
    const out = await source(A);
    const tt = (await toasts(A)) - t0;
    const added = rawAdded(doc, out, typed);
    const typedKept = [...typed.replace(/\s/g, '')].every((c) => out.includes(c));
    const v = !on ? 'NOSESSION' : err ? 'ERR' : A.guard.length || tt ? (added.length ? 'REFUSED+RAW' : 'REFUSED') : added.length ? 'BYPASS' : 'ok';
    tally[v] = (tally[v] ?? 0) + 1;
    const d = strDiff(doc, out);
    console.log(`${v.padEnd(10)} ${name}: raw+=${added.join(',') || '-'} guard=${A.guard.length} toast=${tt} typedKept=${typedKept}${clip ? ' clip=' + show(clip.text) + (clip.handled ? '(session)' : '(browser)') : ''} del=${show(d.del)} ins=${show(d.ins)}${err ? ' ERR ' + err : ''}`);
    if (A.guard.length) console.log('           ' + A.guard[0]);
  }
  console.log('RESULT ' + JSON.stringify(tally) + ` of ${FILTERED.length}`);
} finally { stop(); await browser?.close(); }
