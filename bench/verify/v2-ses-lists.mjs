// bench/verify/v2-ses-lists.mjs — verify-session: list editing inside a session (Enter / Tab / Shift+Tab /
// Backspace in items). Oracle: what the session shows (text + list structure) must equal what the block renders to
// after Esc (from the source), and no list marker may turn into visible text or a heading.
// Run: MDR_PORT=5282 node bench/verify/v2-ses-lists.mjs [filter]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const filter = process.argv[2] ?? '';
const B = await openB();
const stop = globalTimeout(115_000, B.close);
const { page } = B;
async function act(a) {
  const [k, ...rest] = a.split(':');
  const v = rest.join(':');
  if (k === 'type') await page.keyboard.type(v);
  else if (k === 'press') await page.keyboard.press(v);
  else if (k === 'caret') await B.caretAt(v, 'after');
  await sleep(60);
}
/** A structural fingerprint of the first block: list nesting with item texts, headings, paragraphs. `noPlaceholder`:
 *  an item holding nothing but one <br> (the browser's placeholder in an emptied item) counts as empty. */
const shape = (noPlaceholder = false) => page.evaluate((noPlaceholder) => {
  const sec = document.querySelector('.mdr-preview section.md-block');
  const walk = (n) => {
    if (n.nodeType === 3) return n.data.replace(/[\u200b\s]+/g, ' ');
    if (n.nodeType !== 1 || n.hasAttribute('data-mdr-ui')) return '';
    const t = n.tagName;
    const inner = Array.from(n.childNodes).map(walk).join('');
    if (/^(UL|OL)$/.test(t)) return `${t}[${inner}]`;
    if (t === 'LI' && noPlaceholder && inner.trim() === '⏎' && n.querySelectorAll(':scope > br, :scope > p > br').length === 1) return '()';
    if (t === 'LI') return `(${inner.trim()})`;
    if (/^H[1-6]$/.test(t)) return `${t}{${inner.trim()}}`;
    if (t === 'P') return inner.trim() ? ` ${inner.trim()} ` : '';
    if (t === 'INPUT') return '☐';
    if (t === 'BR') return '⏎';
    return inner;
  };
  return walk(sec).replace(/\s+/g, '');
}, noPlaceholder);
const C = [
  ['enter-tab-type', '- on\n- two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab', 'type:child'], '- on\n  - child\n- two\n\nafter\n'],
  ['enter-tab-type-ol', '1. on\n2. two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab', 'type:child'], '1. on\n   1. child\n2. two\n\nafter\n'],
  ['enter-tab-type-task', '- [ ] on\n- [ ] two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab', 'type:child'], '- [ ] on\n  - [ ] child\n- [ ] two\n\nafter\n'],
  ['nested-enter-stab-type', '- on\n  - in\n- two\n', 2, 'in', ['caret:in', 'press:Enter', 'press:Shift+Tab', 'type:out'], '- on\n  - in\n- out\n- two\n\nafter\n'],
  ['para-list-first-emptied', 'Items:\n- x\n- o\n', 2, 'x', ['caret:x', 'press:Backspace']],
  ['para-olist-first-emptied', 'Items:\n1. x\n2. o\n', 2, 'x', ['caret:x', 'press:Backspace']],
  ['ol-nested-first-emptied', '1. on\n   1. x\n   2. o\n', 2, 'x', ['caret:x', 'press:Backspace']],
  ['ul-nested-first-emptied', '- on\n  - x\n  - o\n', 2, 'x', ['caret:x', 'press:Backspace']],
  ['ul-nested-first-emptied-esc-click', '- on\n  - x\n  - o\n', 2, 'x', ['caret:x', 'press:Backspace', 'press:ArrowDown', 'type:Z']],
  ['ul-first-emptied', '- x\n- o\n', 1, 'x', ['caret:x', 'press:Backspace']],
  // lead 2026-11-20 (Stage-2b): the browser's placeholder <br> in an emptied item is not content
  ['ul-middle-emptied', '- a\n- x\n- o\n', 2, 'x', ['caret:x', 'press:Backspace'], undefined, { noPlaceholder: true }],
  ['ol-middle-emptied', 'text\n\n1. a\n2. x\n3. o\n', 4, 'x', ['caret:x', 'press:Backspace']],
  ['ol-empty-nested', '1. on\n2. two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab']],
  ['ul-empty-nested', '- on\n- two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab']],
  ['ul-empty-nested-then-type', '- on\n- two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab', 'type:x']],
  ['ol-empty-nested-two', '1. on\n2. two\n', 1, 'on', ['caret:on', 'press:Enter', 'press:Tab', 'press:Enter', 'type:o']],
  ['ul-tab-first-item', '- a\n- b\n', 1, 'a', ['caret:a', 'press:Tab', 'type:x']],
  ['ul-tab-second', '- a\n- b\n- c\n', 2, 'b', ['caret:b', 'press:Tab', 'type:x']],
  ['ul-tab-twice', '- a\n- b\n- c\n', 3, 'c', ['caret:c', 'press:Tab', 'press:Tab', 'type:x']],
  ['ul-stab-top', '- a\n- b\n', 2, 'b', ['caret:b', 'press:Shift+Tab', 'type:x']],
  ['ul-stab-nested-middle', '- a\n  - b\n  - c\n  - d\n', 3, 'c', ['caret:c', 'press:Shift+Tab', 'type:x']],
  ['ol-tab', '1. a\n2. b\n3. c\n', 2, 'b', ['caret:b', 'press:Tab', 'type:x']],
  ['mixed-tab', '- a\n\n1. b\n', 1, 'a', ['caret:a', 'press:Enter', 'type:n', 'press:Tab']],
  ['task-tab', '- [ ] a\n- [ ] b\n', 2, 'b', ['caret:b', 'press:Tab', 'type:x']],
  ['task-enter-empty-leave', '- [ ] a\n- [ ] b\n', 2, 'b', ['caret:b', 'press:Enter', 'press:Enter', 'type:x']],
  ['bs-item-start', '- a\n- b\n', 2, 'b', ['caret:b', 'press:ArrowLeft', 'press:Backspace']],
  ['bs-item-start-type', '- a\n- b\n', 2, 'b', ['caret:b', 'press:ArrowLeft', 'press:Backspace', 'type:x']],
  ['bs-nested-start', '- a\n  - b\n', 2, 'b', ['caret:b', 'press:ArrowLeft', 'press:Backspace', 'type:x']],
  ['bs-empty-item', '- a\n- b\n', 1, 'a', ['caret:a', 'press:Enter', 'press:Backspace', 'type:x']],
  ['enter-mid-nested', '- a\n  - bc\n- d\n', 2, 'bc', ['caret:b', 'press:Enter', 'type:x']],
  ['enter-empty-in-nested-leave', '- a\n  - b\n- d\n', 2, 'b', ['caret:b', 'press:Enter', 'press:Enter', 'press:Enter', 'type:x']],
  ['senter-in-item', '- a\n- b\n', 1, 'a', ['caret:a', 'press:Shift+Enter', 'type:x']],
  ['item-with-para-tab', '- a\n\n  para\n- b\n', 4, 'b', ['caret:b', 'press:Tab', 'type:x']],
  ['ol-start-5-enter', '5. a\n6. b\n', 2, 'b', ['caret:b', 'press:Enter', 'type:x']],
  ['ol-paren', '1) a\n2) b\n', 2, 'b', ['caret:b', 'press:Enter', 'type:x']],
];
try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, actions, want, opt] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await B.loadDoc(doc + '\nafter\n');
      await B.clickLine(line, 'first', needle);
      for (const a of actions) await act(a);
      await sleep(300); await B.settle(200);
      const live = await shape(!!opt?.noPlaceholder);
      await page.keyboard.press('Escape'); await sleep(200); await B.settle(300);
      const again = await shape(!!opt?.noPlaceholder);
      const src = await B.source();
      const okSrc = want === undefined || src === want;
      check(name, live === again && okSrc, `${live === again ? '' : `session ${J(live)} ≠ rendered ${J(again)}`}${okSrc ? '' : ` expected ${J(want)}`} src=${J(src)}`);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
  console.log('errors', J(B.pageErrors), J(B.consoleErrors.slice(0, 5)));
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
