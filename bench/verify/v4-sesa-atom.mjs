// bench/verify/v4-sesa-atom.mjs — verify-session-a: U21 (H10, H11 variations) and keys around inline atoms in real
// Chromium. Each case: fresh document, a real click into the block, the caret put at a text position (`at`:
// [needle, 'after' | 'before'] in the editing block's text, or a key such as 'Meta+ArrowLeft'), then the steps,
// then the exact expected source; then Esc and ⌘Z until the original is back (byte for byte).
// Steps: ['k', key] ['t', text] ['w', ms] ['fast', ...keys|chars] (no waits: the replayed keys of a resume).
// Run: MDR_PORT=5431 node bench/verify/v4-sesa-atom.mjs [name-filter]   (T_MS = global timeout, default 400 s)
import { openB, sleep, globalTimeout, J, check, summary, view, clickText, undoTo, waitSession, load, caretCtx, caretTo } from './v4-sesa-lib.mjs';

const filter = process.argv[2] || '';
const B = await openB();
const stop = globalTimeout(Number(process.env.T_MS ?? 400_000), B.close);
const { page } = B;
const settle = async (ms = 320) => { await sleep(ms); await B.settle(150); };
const I = '![i](https://e.example/i.png)';
const E = [['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]];
const SE = [['k', 'Shift+Enter'], ['w'], ['t', 'Z'], ['w', 500]];
const cases = [];
const add = (name, doc, click, at, steps, want) => cases.push({ name, doc, click, at, steps, want });

add('math-space', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ$x$ y\n\nz\n');
add('math-nospace', 'abc$x$ y\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ$x$ y\n\nz\n');
add('math-shift', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], SE, 'abc  \nZ$x$ y\n\nz\n');
add('math-2', 'abc $x$ $y$ d\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ$x$ $y$ d\n\nz\n');
add('math-img', `abc ${I}$x$ d\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ${I}$x$ d\n\nz\n`);
add('img-math', `abc $x$${I} d\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ$x$${I} d\n\nz\n`);
add('math-end-enter', 'abc $x$\n\nz\n', 'abc', 'End', E, 'abc $x$\n\nZ\n\nz\n');
add('math-mid-after', 'abc $x$ y\n\nz\n', 'abc', [' y', 'before'], E, 'abc $x$\n\nZy\n\nz\n');
add('math-li', '- abc $x$ y\n- e\n', 'abc', ['abc', 'after'], E, '- abc\n- Z$x$ y\n- e\n');
add('math-li-shift', '- abc $x$ y\n- e\n', 'abc', ['abc', 'after'], SE, '- abc  \n  Z$x$ y\n- e\n');
add('math-task', '- [ ] abc $x$ y\n- [ ] e\n', 'abc', ['abc', 'after'], E, '- [ ] abc\n- [ ] Z$x$ y\n- [ ] e\n');
add('math-ordered', '1. abc $x$ y\n2. e\n', 'abc', ['abc', 'after'], E, '1. abc\n2. Z$x$ y\n3. e\n');
add('math-nested', '- a\n  - abc $x$ y\n', 'abc', ['abc', 'after'], E, '- a\n  - abc\n  - Z$x$ y\n');
add('math-heading', '# abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], E, '# abc\n\nZ$x$ y\n\nz\n');
add('math-quote', '> abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], E, '> abc\n>\n> Z$x$ y\n\nz\n');
add('math-cell-shift', '| h |\n| --- |\n| abc $x$ y |\n', 'abc', ['abc', 'after'], SE, '| h |\n| --- |\n| abc<br>Z$x$ y |\n');
add('math-bold', 'abc **$x$ b** y\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ**$x$ b** y\n\nz\n');
add('math-softbreak', 'abc\n$x$ d\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ$x$ d\n\nz\n');
add('img-space', `abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ${I} y\n\nz\n`);
add('img-shift', `abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], SE, `abc  \nZ${I} y\n\nz\n`);
add('img-li', `- abc ${I} y\n- e\n`, 'abc', ['abc', 'after'], E, `- abc\n- Z${I} y\n- e\n`);
add('img-heading', `## abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], E, `## abc\n\nZ${I} y\n\nz\n`);
add('img-quote', `> abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], E, `> abc\n>\n> Z${I} y\n\nz\n`);
add('img-2', `abc ${I}${I} y\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ${I}${I} y\n\nz\n`);
add('img-link', `abc [${I}](https://e.example/) y\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ[${I}](https://e.example/) y\n\nz\n`);
add('link', 'abc [lk](https://e.example/) y\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ[lk](https://e.example/) y\n\nz\n');
add('fnref', 'abc[^1] y\n\n[^1]: note\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ[^1] y\n\n[^1]: note\n');
add('br', 'abc  \ndef\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ  \ndef\n\nz\n');
add('br-shift', 'abc  \ndef\n\nz\n', 'abc', ['abc', 'after'], SE, 'abc  \nZ  \ndef\n\nz\n');
// replayed keys (the second Enter arrives while the first one's resume waits)
add('math-fast', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['fast', 'Enter', 'Z'], ['w', 900]], 'abc\n\nZ$x$ y\n\nz\n');
add('img-fast', `abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], [['fast', 'Enter', 'Z'], ['w', 900]], `abc\n\nZ${I} y\n\nz\n`);
add('math-fast-enter-shift', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['fast', 'Enter', 'Shift+Enter', 'Z'], ['w', 900]], 'abc\n\n\\\nZ$x$ y\n\nz\n');
add('math-fast-enter-enter', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['fast', 'Enter', 'Enter', 'Z'], ['w', 900]], 'abc\n\nZ$x$ y\n\nz\n');
add('math-enter-enter-slow', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Enter'], ['w'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]], 'abc\n\nZ$x$ y\n\nz\n');
add('math-fast-li', '- abc $x$ y\n- e\n', 'abc', ['abc', 'after'], [['fast', 'Enter', 'Z'], ['w', 900]], '- abc\n- Z$x$ y\n- e\n');
add('math-fast-typed-first', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['fast', 'Q', 'Enter', 'Z', 'Enter', 'W'], ['w', 1200]], 'abcQ\n\nZ\n\nW$x$ y\n\nz\n');
// Backspace / Delete / arrows next to atoms
add('math-enter-bs', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Enter'], ['w'], ['k', 'Backspace'], ['w'], ['t', 'Z'], ['w', 500]], 'abcZ$x$ y\n\nz\n');
add('img-enter-bs', `abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], [['k', 'Enter'], ['w'], ['k', 'Backspace'], ['w'], ['t', 'Z'], ['w', 500]], `abcZ${I} y\n\nz\n`);
add('math-right', 'abc $x$ y\n\nz\n', 'abc', ['abc ', 'after'], [['k', 'ArrowRight'], ['t', 'Z'], ['w', 500]], 'abc $x$Z y\n\nz\n');
add('math-left', 'abc $x$ y\n\nz\n', 'abc', [' y', 'before'], [['k', 'ArrowLeft'], ['t', 'Z'], ['w', 500]], 'abc Z$x$ y\n\nz\n');
add('img-right', `abc ${I} y\n\nz\n`, 'abc', ['abc ', 'after'], [['k', 'ArrowRight'], ['t', 'Z'], ['w', 500]], `abc ${I}Z y\n\nz\n`);
add('img-left', `abc ${I} y\n\nz\n`, 'abc', [' y', 'before'], [['k', 'ArrowLeft'], ['t', 'Z'], ['w', 500]], `abc Z${I} y\n\nz\n`);
add('lead-math-left', '$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'ArrowLeft'], ['t', 'Z'], ['w', 500]], 'Z$x$ d\n\nz\n');
add('lead-math-home', '$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Home'], ['t', 'Z'], ['w', 500]], 'Z$x$ d\n\nz\n');
add('lead-math-br-home', 'abc  \n$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Home'], ['t', 'Z'], ['w', 500]], 'abc  \nZ$x$ d\n\nz\n');
add('lead-math-li-2nd', '- a1\n- $x$ d\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'Z'], ['w', 500]], '- a1\n- Z$x$ d\n');
add('lead-math-cell', '| h |\n| --- |\n| $x$ d |\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'Z'], ['w', 500]], '| h |\n| --- |\n| Z$x$ d |\n');
add('lead-math-quote', '> $x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'Z'], ['w', 500]], '> Z$x$ d\n\nz\n');
add('lead-math-heading', '## $x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'Z'], ['w', 500]], '## Z$x$ d\n\nz\n');
add('lead-math-bs', 'a1 xx\n\n$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['k', 'Backspace'], ['w', 600], ['t', 'Z'], ['w', 500]], 'a1 xxZ$x$ d\n\nz\n');
add('lead-math-enter', '$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]], 'Z$x$ d\n\nz\n');
add('lead-img-home', `${I} d\n\nz\n`, ' d', [' d', 'before'], [['k', 'Home'], ['t', 'Z'], ['w', 500]], `Z${I} d\n\nz\n`);
add('lead-img-enter', `${I} d\n\nz\n`, ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]], `Z${I} d\n\nz\n`);
add('end-math-enter-type', 'abc $x$\n\nz\n', 'abc', ['abc', 'after'], [['k', 'End'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]], 'abc $x$\n\nZ\n\nz\n');
add('math-del', 'abc $x$ y\n\nz\n', 'abc', ['abc ', 'after'], [['k', 'Delete'], ['w'], ['t', 'Z'], ['w', 500]], 'abc Z y\n\nz\n');
add('math-bs-after', 'abc $x$ y\n\nz\n', 'abc', [' y', 'before'], [['k', 'Backspace'], ['w'], ['t', 'Z'], ['w', 500]], 'abc Z y\n\nz\n');
// round 2 of variations: atoms inside inline formatting / links, headings, two atoms, the replayed second Enter
add('math-em', 'abc *$x$ b* y\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ*$x$ b* y\n\nz\n');
add('math-bold-shift', 'abc **$x$ b** y\n\nz\n', 'abc', ['abc', 'after'], SE, 'abc  \nZ**$x$ b** y\n\nz\n');
add('math-bold-li', '- abc **$x$ b** y\n- e\n', 'abc', ['abc', 'after'], E, '- abc\n- Z**$x$ b** y\n- e\n');
add('math-link', 'abc [$x$ b](https://e.example/) y\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZ[$x$ b](https://e.example/) y\n\nz\n');
add('img-bold', `abc **${I} b** y\n\nz\n`, 'abc', ['abc', 'after'], E, `abc\n\nZ**${I} b** y\n\nz\n`);
add('img-h1', `# abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], E, `# abc\n\nZ${I} y\n\nz\n`);
add('img-heading-nospace', `## abc${I} y\n\nz\n`, 'abc', ['abc', 'after'], E, `## abc\n\nZ${I} y\n\nz\n`);
add('math-heading-2', '## abc $x$ $y$ d\n\nz\n', 'abc', ['abc', 'after'], E, '## abc\n\nZ$x$ $y$ d\n\nz\n');
add('img-math-li', `- abc ${I}$x$ d\n- e\n`, 'abc', ['abc', 'after'], E, `- abc\n- Z${I}$x$ d\n- e\n`);
add('img-math-shift', `abc ${I}$x$ d\n\nz\n`, 'abc', ['abc', 'after'], SE, `abc  \nZ${I}$x$ d\n\nz\n`);
add('img-link-li', `- abc [${I}](https://e.example/) y\n- e\n`, 'abc', ['abc', 'after'], E, `- abc\n- Z[${I}](https://e.example/) y\n- e\n`);
add('math-z-enter-slow', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Enter'], ['w'], ['t', 'Z'], ['w'], ['k', 'Enter'], ['w'], ['t', 'W'], ['w', 500]], 'abc\n\nZ\n\nW$x$ y\n\nz\n');
add('math-typed-first-slow', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['t', 'Q'], ['w'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w'], ['k', 'Enter'], ['w'], ['t', 'W'], ['w', 500]], 'abcQ\n\nZ\n\nW$x$ y\n\nz\n');
add('math-z-enter-fast', 'abc $x$ y\n\nz\n', 'abc', ['abc', 'after'], [['fast', 'Enter', 'Z', 'Enter', 'W'], ['w', 1200]], 'abc\n\nZ\n\nW$x$ y\n\nz\n');
add('img-z-enter-fast', `abc ${I} y\n\nz\n`, 'abc', ['abc', 'after'], [['fast', 'Enter', 'Z', 'Enter', 'W'], ['w', 1200]], `abc\n\nZ\n\nW${I} y\n\nz\n`);
// U13 / U14 / U18 (joinsAbove) together with the round-3 code in enterKey / write
const BSQ = [['k', 'Meta+ArrowLeft'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 500]];
add('u1314-lead-enter', '\nabc def\n\nz\n', 'abc', ['abc', 'after'], E, '\nabc\n\nZdef\n\nz\n');
add('u1314-lead-enter-math', '\nabc $x$ y\n\nz\n', 'abc', ['abc', 'after'], E, '\nabc\n\nZ$x$ y\n\nz\n');
add('u1314-lead-lead-math', '\n$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'Z'], ['w', 500]], '\nZ$x$ d\n\nz\n');
add('u1314-lead-lead-math-enter', '\n$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]], '\nZ$x$ d\n\nz\n');
add('u1314-tab', 'abc\tdef\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZdef\n\nz\n');
add('u1314-code', '```\nabc def\n```\n\nz\n', 'abc', ['abc', 'after'], E, '```\nabc\nZ def\n```\n\nz\n');
add('u1314-quote', '> abc def\n\nz\n', 'abc', ['abc', 'after'], E, '> abc\n>\n> Zdef\n\nz\n');
add('u1314-task', '- [ ] abc def\n\nz\n', 'abc', ['abc', 'after'], E, '- [ ] abc\n- [ ] Zdef\n\nz\n');
add('u1314-ordered', '1. abc def\n\nz\n', 'abc', ['abc', 'after'], E, '1. abc\n2. Zdef\n\nz\n');
add('u1314-heading-shift', '## abc def\n\nz\n', 'abc', ['abc', 'after'], SE, (s) => /^## abc(<br>|  \n)Zdef\n\nz\n$/.test(s) || s === '## abc<br>Zdef\n\nz\n');
add('u1314-spacer-type-split', '$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'ab'], ['w'], ['k', 'ArrowLeft'], ['k', 'Enter'], ['w'], ['t', 'Z'], ['w', 500]], 'a\n\nZb$x$ d\n\nz\n');
add('u1314-spacer-type-end-home', '$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'ab'], ['w'], ['k', 'End'], ['t', 'E'], ['k', 'Home'], ['t', 'H'], ['w', 500]], 'Hab$x$ dE\n\nz\n');
add('u1314-spacer-li-tab', '- a1\n- $x$ d\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['k', 'Tab'], ['w'], ['t', 'Z'], ['w', 500]], '- a1\n  - Z$x$ d\n');
add('u1314-spacer-undo-type', '$x$ d\n\nz\n', ' d', [' d', 'before'], [['k', 'Meta+ArrowLeft'], ['t', 'ab'], ['w', 700], ['k', 'Meta+z'], ['w', 700], ['t', 'Z'], ['w', 500]], 'Z$x$ d\n\nz\n');
add('u1314-3spaces', 'abc   def\n\nz\n', 'abc', ['abc', 'after'], E, 'abc\n\nZdef\n\nz\n');
add('u1314-tight-heading-enter', 'aaa\n# abc def\n\nz\n', 'abc', ['abc', 'after'], E, 'aaa\n# abc\n\nZdef\n\nz\n');
add('u1314-tight-item-bs', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], BSQ, 'aaa\n\nQabc\n\nz\n');
add('u1314-tight-item2-bs', 'aaa\n- abc\n- def\n\nz\n', 'abc', ['abc', 'after'], BSQ, 'aaa\n\nQabc\n- def\n\nz\n');
add('u1314-tight-item-bs-type2', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Meta+ArrowLeft'], ['k', 'Backspace'], ['w', 600], ['t', 'Q'], ['w', 400], ['t', 'R'], ['w', 400], ['k', 'Enter'], ['w'], ['t', 'S'], ['w', 500]], 'aaa\n\nQR\n\nSabc\n\nz\n');
add('u1314-tight-item-bs-fast', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Meta+ArrowLeft'], ['fast', 'Backspace', 'Q', 'R'], ['w', 900]], 'aaa\n\nQRabc\n\nz\n');
add('u1314-tight-heading-bs', 'aaa\n## abc\n\nz\n', 'abc', ['abc', 'after'], BSQ, (s) => s === 'aaa\n## Qabc\n\nz\n' || s === 'aaaQabc\n\nz\n');
add('u1314-tight-item-under-heading-bs', '# Hd\n- abc\n\nz\n', 'abc', ['abc', 'after'], BSQ, (s) => s === '# Hd\n\nQabc\n\nz\n' || s === '# Hd\nQabc\n\nz\n');
add('u1314-tight-item-under-fence-bs', '```\nc1\n```\n- abc\n\nz\n', 'abc', ['abc', 'after'], BSQ, (s) => s === '```\nc1\n```\nQabc\n\nz\n' || s === '```\nc1\n```\n\nQabc\n\nz\n');
add('u1314-tight-item-under-list-para', '- a1\n\n  para\n- abc\n\nz\n', 'abc', ['abc', 'after'], BSQ, (s) => /Qabc/.test(s));
// joinsAbove (U18) reached by keys: a top-level item outdented to a paragraph, an Enter on an empty item
const STQ = [['k', 'Shift+Tab'], ['w', 600], ['t', 'Q'], ['w', 500]];
add('u18j-shifttab-only-item', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], STQ, 'aaa\n\nabcQ\n\nz\n');
add('u18j-shifttab-first-of-2', 'aaa\n- abc\n- def\n\nz\n', 'abc', ['abc', 'after'], STQ, 'aaa\n\nabcQ\n- def\n\nz\n');
add('u18j-shifttab-fast', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['fast', 'Shift+Tab', 'Q', 'R'], ['w', 900]], 'aaa\n\nabcQR\n\nz\n');
add('u18j-shifttab-type-enter', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Shift+Tab'], ['w', 600], ['t', 'Q'], ['w', 400], ['k', 'Enter'], ['w'], ['t', 'R'], ['w', 500]], 'aaa\n\nabcQ\n\nR\n\nz\n');
add('u18j-shifttab-undo', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Shift+Tab'], ['w', 600], ['k', 'Meta+z'], ['w', 600], ['t', 'Q'], ['w', 500]], 'aaa\n- abcQ\n\nz\n');
add('u18j-shifttab-under-heading', '# Hd\n- abc\n\nz\n', 'abc', ['abc', 'after'], STQ, '# Hd\nabcQ\n\nz\n');
add('u18j-shifttab-under-quote', '> qq\n- abc\n\nz\n', 'abc', ['abc', 'after'], STQ, (s) => s === '> qq\n\nabcQ\n\nz\n');
add('u18j-shifttab-under-fence', '```\nc1\n```\n- abc\n\nz\n', 'abc', ['abc', 'after'], STQ, (s) => s === '```\nc1\n```\nabcQ\n\nz\n' || s === '```\nc1\n```\n\nabcQ\n\nz\n');
add('u18j-shifttab-under-table', '| h |\n| --- |\n| c |\n- abc\n\nz\n', 'abc', ['abc', 'after'], STQ, (s) => /\| c \|\n\n?abcQ\n\nz\n$/.test(s) && !/\| abcQ/.test(s));
add('u18j-empty-item-enter', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Enter'], ['w'], ['k', 'Enter'], ['w'], ['t', 'Q'], ['w', 500]], 'aaa\n- abc\n\nQ\n\nz\n');
const FIRSTEMPTY = [['k', 'Meta+ArrowLeft'], ['k', 'Enter'], ['w'], ['k', 'ArrowUp'], ['k', 'Enter'], ['w', 600]];
add('u18j-first-item-leave', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [...FIRSTEMPTY, ['t', 'Q'], ['w', 500]], (s) => s === 'aaa\n\nQ\n- abc\n\nz\n' || s === 'aaa\n\nQ\n\n- abc\n\nz\n');
add('u18j-first-item-leave-fast', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [['k', 'Meta+ArrowLeft'], ['fast', 'Enter', 'ArrowUp', 'Enter', 'Q', 'R'], ['w', 1200]], (s) => s === 'aaa\n\nQR\n- abc\n\nz\n' || s === 'aaa\n\nQR\n\n- abc\n\nz\n');
add('u18j-first-item-leave-type2', 'aaa\n- abc\n\nz\n', 'abc', ['abc', 'after'], [...FIRSTEMPTY, ['t', 'Q'], ['w', 500], ['t', 'R'], ['w', 500]], (s) => s === 'aaa\n\nQR\n- abc\n\nz\n' || s === 'aaa\n\nQR\n\n- abc\n\nz\n');
add('u18j-first-item-leave-heading', '# Hd\n- abc\n\nz\n', 'abc', ['abc', 'after'], [...FIRSTEMPTY, ['t', 'Q'], ['w', 500]], (s) => s === '# Hd\nQ\n- abc\n\nz\n' || s === '# Hd\n\nQ\n- abc\n\nz\n' || s === '# Hd\n\nQ\n\n- abc\n\nz\n');
add('u18j-first-item-leave-fence', '```\nc1\n```\n- abc\n\nz\n', 'abc', ['abc', 'after'], [...FIRSTEMPTY, ['t', 'Q'], ['w', 500]], (s) => /^```\nc1\n```\n\n?Q\n\n?- abc\n\nz\n$/.test(s));
// structure keys inside multi-part blocks (tables, quotes, lists): what the browser does must be what is written
const TB = '| h1 | h2 |\n| --- | --- |\n| c1 | d1 |\n\nz\n';
add('st-cell-bs-start', TB, 'd1', ['d1', 'before'], [['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '| h1 | h2 |\n| --- | --- |\n| c1 | Qd1 |\n\nz\n' || s === '| h1 | h2 |\n| --- | --- |\n| c1Q | d1 |\n\nz\n');
add('st-cell-del-end', TB, 'c1', ['c1', 'after'], [['k', 'Delete'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '| h1 | h2 |\n| --- | --- |\n| c1Q | d1 |\n\nz\n');
add('st-cell-enter', TB, 'c1', ['c1', 'after'], [['k', 'Enter'], ['w'], ['t', 'Q'], ['w', 500]], '| h1 | h2 |\n| --- | --- |\n| c1Q | d1 |\n\nz\n');
add('st-cell-tab-last', TB, 'd1', ['d1', 'after'], [['k', 'Tab'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '| h1 | h2 |\n| --- | --- |\n| c1 | d1Q |\n\nz\n');
add('st-cell-shifttab-first', TB, 'h1', ['h1', 'after'], [['k', 'Shift+Tab'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '| h1Q | h2 |\n| --- | --- |\n| c1 | d1 |\n\nz\n');
add('st-cell-shift-enter-end', TB, 'c1', ['c1', 'after'], [['k', 'Shift+Enter'], ['w'], ['t', 'Q'], ['w', 500]], '| h1 | h2 |\n| --- | --- |\n| c1<br>Q | d1 |\n\nz\n');
add('st-cell-sel-bs', TB, 'c1', ['c1', 'select'], [['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], '| h1 | h2 |\n| --- | --- |\n| Q | d1 |\n\nz\n');
add('st-cell-empty-row', TB, 'c1', ['c1', 'select'], [['k', 'Backspace'], ['w'], ['k', 'Tab'], ['k', 'Meta+Shift+ArrowLeft'], ['k', 'Backspace'], ['w', 600], ['k', 'Escape'], ['w']], (s) => /^\| h1 \| h2 \|\n\| --- \| --- \|\n\|  ?\|  ?\|\n\nz\n$/.test(s));
add('st-quote-bs-2nd-para', '> q1\n>\n> q2\n\nz\n', 'q2', ['q2', 'before'], [['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], '> q1Qq2\n\nz\n');
add('st-quote-del-end-1st', '> q1\n>\n> q2\n\nz\n', 'q1', ['q1', 'after'], [['k', 'Delete'], ['w'], ['t', 'Q'], ['w', 500]], '> q1Qq2\n\nz\n');
add('st-li-del-end', '- a1\n- b1\n\nz\n', 'a1', ['a1', 'after'], [['k', 'Delete'], ['w'], ['t', 'Q'], ['w', 500]], '- a1Qb1\n\nz\n');
add('st-li-bs-start-2nd', '- a1\n- b1\n\nz\n', 'b1', ['b1', 'before'], [['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '- a1Qb1\n\nz\n' || s === '- a1\n\nQb1\n\nz\n' || s === '- a1\nQb1\n\nz\n' || s === '- a1\n- Qb1\n\nz\n');
add('st-li-nested-bs-start', '- a1\n  - b1\n\nz\n', 'b1', ['b1', 'before'], [['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '- a1Qb1\n\nz\n' || s === '- a1\n- Qb1\n\nz\n' || s === '- a1\n  Qb1\n\nz\n');
add('st-task-del-end', '- [ ] a1\n- [ ] b1\n\nz\n', 'a1', ['a1', 'after'], [['k', 'Delete'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '- [ ] a1Qb1\n\nz\n' || s === '- [ ] a1Q b1\n\nz\n');
add('st-loose-li-enter-mid', '- a1 x\n\n- b1\n\nz\n', 'a1', ['a1', 'after'], [['k', 'Enter'], ['w'], ['t', 'Q'], ['w', 500]], (s) => s === '- a1\n\n- Qx\n\n- b1\n\nz\n');
add('st-code-bs-start-line2', '```\nc1\nc2\n```\n\nz\n', 'c2', ['c2', 'before'], [['k', 'Backspace'], ['w'], ['t', 'Q'], ['w', 500]], '```\nc1Qc2\n```\n\nz\n');
add('st-code-del-end-last', '```\nc1\n```\n\nz\n', 'c1', ['c1', 'after'], [['k', 'Delete'], ['w'], ['t', 'Q'], ['w', 500]], '```\nc1Q\n```\n\nz\n');
add('st-code-enter-end-last', '```\nc1\n```\n\nz\n', 'c1', ['c1', 'after'], [['k', 'Enter'], ['w'], ['t', 'Q'], ['w', 500]], '```\nc1\nQ\n```\n\nz\n');
add('st-code-enter-enter-end', '```\nc1\n```\n\nz\n', 'c1', ['c1', 'after'], [['k', 'Enter'], ['w'], ['k', 'Enter'], ['w'], ['t', 'Q'], ['w', 500]], '```\nc1\n\nQ\n```\n\nz\n');

let bad = 0;
try {
  await B.boot('mode=split');
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    try {
      await load(B, c.doc);
      await clickText(page, c.click, 1, { side: 'right' });
      const v0 = await waitSession(page);
      if (!v0.editing) throw new Error('no session ' + J(v0));
      await sleep(80);
      if (Array.isArray(c.at)) await caretTo(page, c.at[0], c.at[1]); else await page.keyboard.press(c.at);
      await sleep(80);
      const c0 = await caretCtx(page);
      for (const st of c.steps) {
        const [op, a] = st;
        if (op === 'k') await page.keyboard.press(a);
        else if (op === 't') await page.keyboard.type(a);
        else if (op === 'w') await settle(a ?? 320);
        else if (op === 'fast') { for (const k of st.slice(1)) { if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k); } }
      }
      const v = await view(page);
      const ok = typeof c.want === 'function' ? c.want(v.src) : v.src === c.want;
      const html = v.editing ? v.editing.html.replace(/<span class="katex[\s\S]*?<\/span><\/span><\/span>/g, '[K]').slice(0, 160) : null;
      await page.keyboard.press('Escape'); await settle(200);
      const u = await undoTo(B, c.doc, 10, 150);
      if (!check(c.name, ok && u.ok, `src=${J(v.src)}${ok ? '' : ' want=' + J(c.want)} caret0=${J(c0)} html=${J(html)} undo=${u.ok ? u.n : 'FAIL ' + J(u.now)}`)) bad++;
    } catch (e) { bad++; check(c.name, false, 'threw ' + String(e.message).split('\n')[0]); }
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  console.log('pageErrors', J(B.pageErrors.slice(0, 3)));
} finally {
  summary(); stop(); await B.close();
  process.exitCode = bad ? 1 : 0;
}
