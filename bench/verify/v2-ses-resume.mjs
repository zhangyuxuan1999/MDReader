// bench/verify/v2-ses-resume.mjs — verify-session: the resume window (U4) and splits in every block kind.
// Each case: load a document, click a needle, run key actions back to back (machine speed, no waits), settle,
// compare the WHOLE source with the text-editor expectation. Also checks: the session is live afterwards on the
// expected text (the user can go on typing), the capture textarea does not keep the focus.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-resume.mjs [filter] [--slow]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const SLOW = process.argv.includes('--slow');
const B = await openB();
const stop = globalTimeout(110_000, B.close);
const { page } = B;

async function act(a) {
  const [k, ...rest] = a.split(':');
  const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'ins') await page.keyboard.insertText(v);
  else if (k === 'ime') { const parts = v.split('|'); await B.ime(parts.slice(0, -1), parts[parts.length - 1]); }
  else if (k === 'wait') await sleep(Number(v));
  else throw new Error('bad action ' + a);
  if (SLOW) await sleep(120);
}

// [name, doc, line, needle, where('after'|'before'), actions, expected source, expected caret check text (optional)]
const C = [
  ['h-tight-enter-wait', '# Head\ntext\n', 1, 'Head', 'after', ['press:Enter', 'wait:500', 'type:Q'], null],
  ['h-tight-enter-wait-quote', '> # Head\n> text\n', 1, 'Head', 'after', ['press:Enter', 'wait:500', 'type:Q'], null],
  ['li-leave-mid-wait', '- aaa\n- bbb\n- ccc\n', 2, 'bbb', 'after', ['press:Enter', 'press:Enter', 'wait:500', 'type:Q'], '- aaa\n- bbb\n\nQ\n\n- ccc\n'],
  ['p-enter-end-wait-then-next-tight', 'abc\n# H\n', 1, 'abc', 'after', ['press:Enter', 'wait:500', 'type:Q'], 'abc\n\nQ\n# H\n'],
  ['empty-caret-at-flush', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:def', 'press:Enter', 'wait:400', 'type:ghi'], 'abc\n\ndef\n\nghi\n\nnext\n'],
  ['empty-caret-at-flush-bs', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:def', 'press:Enter', 'ins:g', 'press:Backspace', 'wait:400', 'type:ghi'], 'abc\n\ndef\n\nghi\n\nnext\n'],
  ['chain-enter', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'type:7o', 'press:Enter', 'type:g8'], 'abc\n\n7o\n\ng8\n\nnext\n'],
  ['chain-enter-ins', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:7o', 'press:Enter', 'ins:g8'], 'abc\n\n7o\n\ng8\n\nnext\n'],
  ['chain-enter-w20', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:7o', 'wait:20', 'press:Enter', 'ins:g8'], 'abc\n\n7o\n\ng8\n\nnext\n'],
  ['chain-enter-w5', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:7o', 'wait:5', 'press:Enter', 'ins:g8'], 'abc\n\n7o\n\ng8\n\nnext\n'],
  ['chain-enter-w10', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:7o', 'wait:10', 'press:Enter', 'ins:g8'], 'abc\n\n7o\n\ng8\n\nnext\n'],
  ['chain-enter-w30', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'ins:7o', 'wait:30', 'press:Enter', 'ins:g8'], 'abc\n\n7o\n\ng8\n\nnext\n'],
  ['nb-type', 'abc def\n', 1, 'abc', 'after', ['press:Enter', 'type:Q'], 'abc\n\nQdef\n'],
  ['nb-type-wait', 'abc def\n', 1, 'abc', 'after', ['press:Enter', 'wait:300', 'type:Q'], 'abc\n\nQdef\n'],
  ['nb-arrow', 'abc def\n', 1, 'abc', 'after', ['press:Enter', 'press:ArrowRight', 'type:Q'], null],
  ['p-mid-cmdright', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'press:Meta+ArrowRight', 'type:Q'], 'abc\n\ndefQ\n'],
  ['p-mid-cmdleft-after-type', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'type:XY', 'press:Meta+ArrowLeft', 'type:Q'], 'abc\n\nQXYdef\n'],
  ['p-mid-type', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'type:XY'], 'abc\n\nXYdef\n'],
  ['p-mid-bs', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'press:Backspace', 'type:Q'], 'abcQdef\n'],
  ['p-mid-enter2', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'press:Enter', 'type:Z'], 'abc\n\nZdef\n'],
  ['p-end-enter-type', 'abc\n\nnext\n', 1, 'abc', 'after', ['press:Enter', 'type:XYZ', 'press:Enter', 'type:UV'], 'abc\n\nXYZ\n\nUV\n\nnext\n'],
  // lead 2026-11-20 (Stage-2b, K16): the empty paragraph Enter makes at a paragraph start has no source form
  ['p-start-enter', 'abc\n', 1, 'abc', 'before', ['press:Enter', 'type:Q'], 'Qabc\n'],
  ['p-shift-arrow', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'press:Shift+ArrowRight', 'type:Q'], 'abc\n\nQef\n'],
  ['p-alt-arrow', 'abc def ghi\n', 1, 'abc', 'after', ['press:Enter', 'press:Alt+ArrowRight', 'type:Q'], 'abc\n\ndefQ ghi\n'],
  ['p-ctrl-e', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'press:Control+e', 'type:Q'], 'abc\n\ndefQ\n'],
  ['p-meta-bs', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'type:XY', 'press:Meta+Backspace', 'type:Q'], 'abc\n\nQdef\n'],
  ['p-ins-cjk', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'ins:中文', 'type:x'], 'abc\n\n中文xdef\n'],
  ['p-ime', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'ime:z|zh|中', 'type:x'], 'abc\n\n中xdef\n'],
  ['p-emoji', 'abcdef\n', 1, 'abc', 'after', ['press:Enter', 'type:😀x'], 'abc\n\n😀xdef\n'],
  ['h-mid', '# Titlehere\n\nnext\n', 1, 'Title', 'after', ['press:Enter', 'type:X'], '# Title\n\nXhere\n\nnext\n'],
  ['h-end', '# Title\n\nnext\n', 1, 'Title', 'after', ['press:Enter', 'type:Body'], '# Title\n\nBody\n\nnext\n'],
  ['h-tight-para', '# Head\ntext\n', 2, 'text', 'after', ['type:XYZ'], '# Head\ntextXYZ\n'],
  // lead 2026-11-20 (Stage-2b): Q stays the paragraph the session showed
  ['h-tight-para-enter', '# Head\ntext\n', 1, 'Head', 'after', ['press:Enter', 'type:Q'], '# Head\nQ\n\ntext\n'],
  ['li-mid', '- aaa\n- bbb\n', 1, 'aa', 'after', ['press:Enter', 'type:X'], '- aa\n- Xa\n- bbb\n'],
  ['li-last-leave', '- aaa\n- bbb\n', 2, 'bbb', 'after', ['press:Enter', 'press:Enter', 'type:X'], '- aaa\n- bbb\n\nX\n'],
  ['li-mid-empty-leave', '- aaa\n- bbb\n', 1, 'aaa', 'after', ['press:Enter', 'press:Enter', 'type:X'], '- aaa\n\nX\n\n- bbb\n'],
  ['li-nested-leave', '- aaa\n  - bbb\n', 2, 'bbb', 'after', ['press:Enter', 'press:Enter', 'type:X'], '- aaa\n  - bbb\n- X\n'],
  ['task-enter', '- [ ] aaa\n', 1, 'aaa', 'after', ['press:Enter', 'type:X'], '- [ ] aaa\n- [ ] X\n'],
  ['quote-enter', '> aaabbb\n', 1, 'aaa', 'after', ['press:Enter', 'type:X'], '> aaa\n>\n> Xbbb\n'],
  ['code-first', '```\nabc\ndef\n```\n', 2, 'abc', 'after', ['press:Enter', 'type:X'], '```\nabc\nX\ndef\n```\n'],
  ['code-last', '```\nabc\ndef\n```\n', 3, 'def', 'after', ['press:Enter', 'type:X'], '```\nabc\ndef\nX\n```\n'],
  ['code-last-2enter', '```\nabc\n```\n', 2, 'abc', 'after', ['press:Enter', 'press:Enter', 'type:X'], '```\nabc\n\nX\n```\n'],
  ['code-last-enter-only', '```\nabc\n```\n\nnext\n', 2, 'abc', 'after', ['press:Enter', 'press:Escape'], '```\nabc\n\n```\n\nnext\n'],
  ['table-enter', '| a | b |\n|---|---|\n| cc | dd |\n', 3, 'cc', 'after', ['press:Enter', 'type:X'], '| a | b |\n|---|---|\n| ccX | dd |\n'],
  ['last-no-nl', 'aaa\n\nbbbccc', 3, 'bbb', 'after', ['press:Enter', 'type:X'], 'aaa\n\nbbb\n\nXccc'],
  ['tight-next', 'abcdef\n# H\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nXdef\n# H\n'],
  ['syn-hash', 'abc# def\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX# def\n'],
  ['syn-hash-noX', 'abc# def\n', 1, 'abc', 'after', ['press:Enter', 'press:Escape'], 'abc\n\n\\# def\n'],
  ['syn-dash', 'abc- def\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX- def\n'],
  ['syn-ol', 'abc1. def\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX1. def\n'],
  ['syn-gt', 'abc> def\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX> def\n'],
  // lead 2026-11-20 (Stage-2b, K5): the escaped backticks (renders as the literal text X```def)
  ['syn-fence', 'abc```def\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX\\`\\`\\`def\n'],
  ['syn-hr', 'abc---\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX---\n'],
  ['syn-pipe', 'abc| x |\n', 1, 'abc', 'after', ['press:Enter', 'type:X'], 'abc\n\nX| x |\n'],
  ['dollar-ctx', 'a $5 and $6 b\n', 1, 'and', 'after', ['press:Enter', 'type:X'], null],
  ['tilde-ctx', 'a ~x and ~y b\n', 1, 'and', 'after', ['press:Enter', 'type:X'], null],
  ['bracket-ctx', 'a [x and y] b\n', 1, 'and', 'after', ['press:Enter', 'type:X'], null],
];

try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, where, actions, expected] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc);
      await B.clickLine(line, 'first', needle);
      await B.caretAt(needle, where);
      for (const a of actions) await act(a);
      await sleep(400);
      await B.settle(200);
      const st = await B.state();
      const src = await B.source();
      const ok = expected === null ? true : src === expected;
      const live = st.editing !== null || actions.includes('press:Escape');
      check(name, ok && live && !st.capFocused, `${expected === null ? 'INFO ' : ''}src=${J(src)}${ok ? '' : ` expected=${J(expected)}`} editing=${J(st.editingText)} active=${st.active}`);
      await B.esc();
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
