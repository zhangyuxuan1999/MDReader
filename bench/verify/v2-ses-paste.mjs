// bench/verify/v2-ses-paste.mjs — verify-session: paste / cut / drop inside sessions (CONTRACT §11 paste, U6).
// A paste is dispatched as a ClipboardEvent carrying text/plain (+ optional text/html) on the focused element,
// exactly what the session's paste handler reads. Checks: the source, the rendering after Esc shows the pasted
// text literally (paste is plain text), the block structure the contract promises, no raw HTML in the source.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-paste.mjs [filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
async function paste(text, html) {
  await page.evaluate(({ text, html }) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    if (html) dt.setData('text/html', html);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { text, html });
}
async function act(a) {
  if (typeof a === 'object') { await paste(a.paste, a.html); await sleep(40); return; }
  const [k, ...rest] = a.split(':');
  const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'caret') await B.caretAt(v, 'after');
  else if (k === 'sel') await B.selectText(v);
  else if (k === 'wait') await sleep(Number(v));
  await sleep(40);
}
const CODE = '```js\nlet a = 1;\n```\n';
// lead 2026-11-20 (Stage-2b): a pasted line break in a heading or a table cell is written <br> (the one line break
// the contract allows there); these cases accept exactly that tag and no other markup.
const BR_OK = new Set(['heading-lines', 'heading-paras', 'cell-lines']);
// [name, doc, line, needle, actions, expected source or null, expected visible text of the edited region (regex) or null]
const C = [
  ['code-multiline', CODE, 2, 'let', ['caret:;', { paste: 'x\ny' }], '```js\nlet a = 1;x\ny\n```\n'],
  ['code-trailing-nl', CODE, 2, 'let', ['caret:;', { paste: 'x\ny\n' }], '```js\nlet a = 1;x\ny\n\n```\n'],
  ['code-crlf', CODE, 2, 'let', ['caret:;', { paste: 'x\r\ny\r\nz' }], '```js\nlet a = 1;x\ny\nz\n```\n'],
  ['code-tab', CODE, 2, 'let', ['caret:;', { paste: '\n\tindented' }], '```js\nlet a = 1;\n\tindented\n```\n'],
  ['code-mid', CODE, 2, 'let', ['caret:let', { paste: '1\n2' }], '```js\nlet1\n2 a = 1;\n```\n'],
  ['code-blank-lines', CODE, 2, 'let', ['caret:;', { paste: '\n\n\nq' }], '```js\nlet a = 1;\n\n\nq\n```\n'],
  ['code-fence-inside', CODE, 2, 'let', ['caret:;', { paste: '\n```\nx' }], null],
  ['p-lines', 'abc def\n', 1, 'abc', ['caret:abc', { paste: 'L1\nL2' }], 'abcL1  \nL2 def\n'],
  ['p-paras', 'abc def\n', 1, 'abc', ['caret:abc', { paste: 'P1\n\nP2' }], 'abcP1\n\nP2 def\n'],
  ['p-paras-then-type', 'abc def\n', 1, 'abc', ['caret:abc', { paste: 'P1\n\nP2' }, 'type:Q'], 'abcP1\n\nP2Q def\n'],
  ['p-trailing-blank', 'abc def\n', 1, 'abc', ['caret:abc', { paste: 'P1\n\n' }, 'type:Q'], 'abcP1Q def\n'],
  ['p-markdown-literal', 'abc\n', 1, 'abc', ['caret:abc', { paste: ' # not **bold** [x](y) `c` $m$ <b>h</b> & 1. ' }], null, /abc # not \*\*bold\*\* \[x\]\(y\) `c` \$m\$ <b>h<\/b> & 1\./],
  ['p-line-start-syntax', 'abc\n', 1, 'abc', ['caret:abc', { paste: '\n# h\n- li\n> q\n1. o\n---' }], null, /abc\s*# h\s*- li\s*> q\s*1\. o\s*---/],
  ['p-para-start-syntax', 'abc\n', 1, 'abc', ['caret:abc', { paste: '\n\n# h\n\n- li\n\n```\n\n|a|b|\n|-|-|' }], null, /abc\s*# h\s*- li\s*```\s*\|a\|b\|\s*\|-\|-\|/],
  ['p-html-ignored', 'abc\n', 1, 'abc', ['caret:abc', { paste: 'plain', html: '<b style="color:red">RICH</b>' }], 'abcplain\n'],
  ['li-paras', '- item\n- two\n', 1, 'item', ['caret:item', { paste: 'A\n\nB' }], null, /itemA\s*B/],
  ['li-lines', '- item\n- two\n', 1, 'item', ['caret:item', { paste: 'A\nB' }], '- itemA  \n  B\n- two\n'],
  ['cell-lines', '| a | b |\n|---|---|\n| cc | dd |\n', 3, 'cc', ['caret:cc', { paste: 'X\nY' }], null, /ccX\s*Y/],
  ['cell-pipe', '| a | b |\n|---|---|\n| cc | dd |\n', 3, 'cc', ['caret:cc', { paste: 'X|Y' }], '| a | b |\n|---|---|\n| ccX\\|Y | dd |\n'],
  ['heading-lines', '# Title\n\nnext\n', 1, 'Title', ['caret:Title', { paste: 'A\nB' }], null, /TitleA\s*B/],
  ['heading-paras', '# Title\n\nnext\n', 1, 'Title', ['caret:Title', { paste: 'A\n\nB' }], null, /TitleA\s*B/],
  ['quote-paras', '> quote\n', 1, 'quote', ['caret:quote', { paste: 'A\n\nB' }], '> quoteA\n>\n> B\n'],
  ['tabs-prose', 'abc\n', 1, 'abc', ['caret:abc', { paste: 'a\tb' }], null, /abca\s+b/],
  ['cut', 'abc def ghi\n', 1, 'abc', ['sel:def', 'press:Meta+x', 'type:Z'], 'abc Z ghi\n'],
  ['enter-then-paste', 'abcdef\n', 1, 'abc', ['caret:abc', 'press:Enter', { paste: 'P' }, 'type:Q'], 'abc\n\nPQdef\n'],
  ['selectall-type', 'abc\n\n- x\n- y\n', 3, 'x', ['press:Meta+a', 'type:Z'], null],
  ['selectall-type-p', 'abc def\n\nnext\n', 1, 'abc', ['press:Meta+a', 'type:Z'], 'Z\n\nnext\n'],
  ['selectall-del-quote', '> a\n>\n> b\n\nnext\n', 1, 'a', ['press:Meta+a', 'press:Backspace', 'type:Z'], null],
];
try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, actions, expected, visible] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc);
      await B.clickLine(line, 'first', needle);
      for (const a of actions) await act(a);
      await sleep(300); await B.settle(200);
      const live = (await B.state()).editing !== null;
      await page.keyboard.press('Escape'); await B.settle(300);
      const src = await B.source();
      const text = await page.evaluate(() => document.querySelector('.mdr-preview').innerText);
      const kinds = await B.blocks();
      const problems = [];
      if (/<b[\s>]|style=|<span|<\/?font|<br|[\u200b]/.test(BR_OK.has(name) ? src.replace(/<br>/g, '') : src) && name !== 'p-markdown-literal') problems.push('markup in source');
      if (expected !== null && src !== expected) problems.push(`source ${J(src)} expected ${J(expected)}`);
      if (visible && !visible.test(text)) problems.push(`rendered text ${J(text.slice(0, 200))} !~ ${visible}`);
      check(name, problems.length === 0, `${problems.join('; ')} src=${J(src.slice(0, 200))} live=${live} kinds=${kinds.map((b) => b.kind).join(',')}`);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
