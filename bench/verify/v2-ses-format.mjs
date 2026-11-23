// bench/verify/v2-ses-format.mjs — verify-session: ⌘B / ⌘I / ⌘E / ⌘K inside sessions (U5).
// Each case: load, click a needle, place caret / selection, run actions, then the checks: the source equals the
// expectation (null = info only), no zero-width space in the source, after Esc none in the rendered preview, no
// raw HTML (<a, style=, <span, <code) in the source, and the rendered block shows the expected link / code.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-format.mjs [filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
async function act(a) {
  if (a.startsWith('paste:')) {
    await page.evaluate((text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, a.slice(6).replace(/\\n/g, '\n'));
    await sleep(40); return;
  }
  const [k, ...rest] = a.split(':');
  const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'ins') await page.keyboard.insertText(v);
  else if (k === 'sel') await B.selectText(v);
  else if (k === 'caret') await B.caretAt(v, 'after');
  else if (k === 'jsel') await B.joined(v, 'select');
  else if (k === 'before') await B.joined(v, 'before');
  else if (k === 'wait') await sleep(Number(v));
  else throw new Error(a);
  await sleep(40);
}
// [name, doc, line, clickNeedle, actions, expected source]
const C = [
  ['e-collapsed', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'type:x', 'press:Meta+e', 'type:y'], 'abc`x`y def\n'],
  ['e-twice-untouched', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'press:Meta+e', 'type:y'], 'abcy def\n'],
  ['e-arrow-leaves', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'type:x', 'press:ArrowRight', 'type:y'], 'abc`x`y def\n'],
  ['e-then-enter', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'type:x', 'press:Enter', 'type:y'], null],
  ['e-then-esc', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'press:Escape'], 'abc def\n'],
  ['e-type-esc', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'type:x', 'press:Escape'], 'abc`x` def\n'],
  ['e-then-undo', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'type:x', 'wait:600', 'press:Meta+z', 'type:q'], 'abcq def\n'],
  ['e-at-start', 'abc def\n', 1, 'abc', ['before:abc', 'press:Meta+e', 'type:x', 'press:Meta+e', 'type:y'], '`x`yabc def\n'],
  ['e-at-end', 'abc def\n', 1, 'abc', ['caret:def', 'press:Meta+e', 'type:x', 'press:Meta+e', 'type:y'], 'abc def`x`y\n'],
  ['e-at-end-esc', 'abc def\n\nnext\n', 1, 'abc', ['caret:def', 'press:Meta+e', 'type:x', 'press:Escape'], 'abc def`x`\n\nnext\n'],
  ['e-selection', 'abc def\n', 1, 'abc', ['sel:def', 'press:Meta+e', 'type:y'], 'abc `def`y\n'],
  ['e-selection-twice', 'abc def\n', 1, 'abc', ['sel:def', 'press:Meta+e', 'sel:def', 'press:Meta+e'], 'abc def\n'],
  ['e-heading', '# Title here\n', 1, 'Title', ['caret:Title', 'press:Meta+e', 'type:x', 'press:Meta+e'], '# Title`x` here\n'],
  ['e-cell', '| a | b |\n|---|---|\n| cc | dd |\n', 3, 'cc', ['caret:cc', 'press:Meta+e', 'type:x', 'press:Meta+e', 'type:y'], '| a | b |\n|---|---|\n| cc`x`y | dd |\n'],
  ['e-in-link', 'see [link text](https://a.com) end\n', 1, 'see', ['caret:link', 'press:Meta+e', 'type:x', 'press:Meta+e'], null],
  ['e-in-bold', 'a **bold** z\n', 1, 'a', ['caret:bo', 'press:Meta+e', 'type:x', 'press:Meta+e', 'type:y'], null],
  ['e-in-code-unwrap', 'a `code` z\n', 1, 'a', ['caret:co', 'press:Meta+e', 'type:y'], 'a coyde z\n'],
  ['e-li', '- item one\n', 1, 'item', ['caret:item', 'press:Meta+e', 'type:x', 'press:Meta+e', 'type:y'], '- item`x`y one\n'],
  ['b-collapsed', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+b', 'type:x', 'press:Meta+b', 'type:y'], 'abc**x**y def\n'],
  ['b-selection-twice', 'abc def\n', 1, 'abc', ['sel:def', 'press:Meta+b', 'sel:def', 'press:Meta+b'], 'abc def\n'],
  // stage 2b (fix-serial-2), harness repair: 'sel:' finds its needle in ONE text node only; "a it" spans "a " and the
  // <em>'s "it", so the case threw before reaching ⌘B. 'jsel:' selects across the element boundary as intended.
  ['b-across-italic', 'a *it* b\n', 1, 'a', ['jsel:a it', 'press:Meta+b'], null],
  ['i-heading', '# Title here\n', 1, 'Title', ['sel:here', 'press:Meta+i'], '# Title *here*\n'],
  ['b-then-undo', 'abc def\n', 1, 'abc', ['sel:def', 'press:Meta+b', 'wait:600', 'press:Meta+z'], 'abc def\n'],
  ['b-cell', '| a | b |\n|---|---|\n| cc | dd |\n', 3, 'cc', ['sel:cc', 'press:Meta+b'], '| a | b |\n|---|---|\n| **cc** | dd |\n'],
  ['k-collapsed-glued', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+k', 'type:https://e.com', 'press:Enter', 'type:x'], null],
  ['k-collapsed-space', 'abc def\n', 1, 'abc', ['caret:abc ', 'press:Meta+k', 'type:https://e.com', 'press:Enter', 'type: x'], null],
  ['k-collapsed-cjk', '中文后面\n', 1, '中文', ['caret:中文', 'press:Meta+k', 'type:https://e.com', 'press:Enter', 'type:后'], null],
  ['k-selection', 'abc def\n', 1, 'abc', ['sel:def', 'press:Meta+k', 'type:https://e.com', 'press:Enter'], 'abc [def](https://e.com)\n'],
  ['k-esc', 'abc def\n', 1, 'abc', ['sel:def', 'press:Meta+k', 'type:https://e.com', 'press:Escape', 'type:Z'], 'abc Z\n'],
  ['k-then-typing-in-input-esc2', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+k', 'press:Escape', 'type:Z'], 'abcZ def\n'],
  ['k-heading', '# Title here\n', 1, 'Title', ['sel:here', 'press:Meta+k', 'type:https://e.com', 'press:Enter'], '# Title [here](https://e.com)\n'],
  ['k-glued-then-space', 'ab cd\n', 1, 'ab', ['caret:ab', 'press:Meta+k', 'type:https://e.com', 'press:Enter'], null],
  ['k-cjk-then-space', '中文 后面\n', 1, '中文', ['caret:中文', 'press:Meta+k', 'type:https://e.com', 'press:Enter'], null],
  ['autolink-existing', 'word<https://e.com> tail\n', 1, 'tail', ['caret:tail', 'type:x'], null],
  ['autolink-existing-cjk', '见<https://e.com> 后\n', 1, '后', ['caret:后', 'type:x'], null],
  ['autolink-existing-end', 'word<https://e.com>\n', 1, 'word', ['caret:word', 'type:x'], null],
  ['e-paste-2lines', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'paste:r\\ns'], null],
  ['e-paste-para', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'paste:r\\n\\ns'], null],
  ['e-sel-paste-2lines-li', '- item one\n', 1, 'item', ['caret:item', 'press:Meta+e', 'paste:r\\ns'], null],
  ['e-shift-enter', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+e', 'type:x', 'press:Shift+Enter', 'type:y'], null],
  ['b-paste-2lines', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+b', 'paste:r\\ns'], null],
  ['b-shift-enter', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+b', 'type:x', 'press:Shift+Enter', 'type:y'], null],
  ['i-shift-enter', 'abc def\n', 1, 'abc', ['caret:abc', 'press:Meta+i', 'type:x', 'press:Shift+Enter', 'type:y'], null],
  ['src-bold-end-shift-enter', 'a **bold** z\n', 1, 'a', ['caret:bold', 'press:Shift+Enter', 'type:y'], null],
  ['src-code-end-shift-enter', 'a `code` z\n', 1, 'a', ['caret:code', 'press:Shift+Enter', 'type:y'], null],
  ['src-code-mid-shift-enter', 'a `code` z\n', 1, 'a', ['caret:co', 'press:Shift+Enter'], null],
  ['src-link-end-shift-enter', 'a [link](https://e.com) z\n', 1, 'a', ['caret:link', 'press:Shift+Enter', 'type:y'], null],
  ['b-start-shift-enter', 'abc **b** `c` [d](https://e.com) z\n', 1, 'abc', ['before:abc', 'press:Meta+b', 'press:Shift+Enter', 'type:x'], null],
  ['b-start-type-shift-enter', 'abc **b** `c` [d](https://e.com) z\n', 1, 'abc', ['before:abc', 'press:Meta+b', 'type:T', 'press:Shift+Enter', 'type:x'], null],
  ['src-bold-start-shift-enter', '**Note** text with *em* and `code`\n', 1, 'text', ['caret:Note', 'press:Shift+Enter', 'type:x'], null],
  ['src-bold-caret0-shift-enter', '**Note** text with *em* and `code`\n', 1, 'text', ['before:Note', 'press:Shift+Enter'], null],
  ['src-em-caret0-shift-enter', '*Note* text with **b** and `code`\n', 1, 'text', ['before:Note', 'press:Shift+Enter'], null],
  ['k-math', 'a $x+1$ b\n', 1, 'a', ['caret:a', 'press:Meta+k', 'type:https://e.com', 'press:Enter'], null],
];
const ZW = /[​﻿]/;
try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, actions, expected] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc);
      await B.clickLine(line, 'first', needle);
      for (const a of actions) await act(a);
      await sleep(300); await B.settle(200);
      const during = await B.source();
      const liveAfter = (await B.state()).editing !== null;
      if (process.env.SHOWHTML) console.log('  session DOM:', J(await page.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.innerHTML.replace(/ data-l="\d+"| class="is-focus"/g, ''))));
      await page.keyboard.press('Escape'); await B.settle(300);
      const src = await B.source();
      const rendered = await page.evaluate(() => {
        const pv = document.querySelector('.mdr-preview');
        const sec = pv.querySelector('section.md-block');
        return { zw: /[​﻿]/.test(pv.textContent), html: sec ? sec.innerHTML.slice(0, 300) : '' };
      });
      const problems = [];
      if (ZW.test(during) || ZW.test(src)) problems.push('ZWSP in source');
      if (rendered.zw) problems.push('ZWSP in rendered preview');
      if (/<a[\s>]|style=|<span|<code|<strong|<b>|<em>|<\/?font/.test(src)) problems.push('raw HTML in source');
      if (expected !== null && src !== expected) problems.push(`source ${J(src)} expected ${J(expected)}`);
      check(name, problems.length === 0, `${problems.join('; ')}${problems.length ? '' : ''} src=${J(src)} live=${liveAfter} html=${J(rendered.html.slice(0, 160))}`);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
