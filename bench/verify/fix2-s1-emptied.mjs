// bench/verify/fix2-s1-emptied.mjs — fix-serial-1 (0.2.0 stage 2b): emptied items in Chromium, the cases the
// v2-ses-lists oracle does not see. (1) The first item of a list block right under a paragraph line of the
// previous block ("Items:\n- x"): emptied, it must not turn "Items:" into a setext heading. (2) A task item
// whose text is deleted (checkbox kept): it must stay a task item, not show the literal text "[x]".
// Run: MDR_PORT=5301 node bench/verify/fix2-s1-emptied.mjs   (needs a Vite on MDR_PORT; global timeout 100 s)
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const B = await openB();
const stop = globalTimeout(100_000, B.close);
const { page } = B;
const blocks = () => page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview section.md-block')).map((s) => s.innerHTML));
const back = async (n) => { for (let i = 0; i < n; i++) await page.keyboard.press('Backspace'); };
// [name, doc, line, needle, backspaces, check(blocks after Esc, source)]
const C = [
  ['para-then-list-first-emptied', 'Items:\n- x\n- o\n', 2, 'x', 1, (b) => !/<h2/.test(b[0]) && /<li/.test(b[1])],
  ['para-then-olist-first-emptied', 'Items:\n1. x\n2. o\n', 2, 'x', 1, (b) => !/<h2/.test(b[0]) && /<ol/.test(b[1])],
  ['task-text-deleted', '- [x] done\n- [ ] todo\n', 1, 'done', 4, (b, src) => (b[0].match(/type="checkbox"/g) ?? []).length === 2 && !/\[x\]/.test(b[0]) && src.startsWith('- [x] ')],
  ['task-text-deleted-middle', '- [ ] a\n- [x] done\n- [ ] todo\n', 2, 'done', 4, (b) => (b[0].match(/type="checkbox"/g) ?? []).length === 3 && !/\[x\]/.test(b[0])],
];
try {
  await B.boot('mode=split');
  for (const [name, doc, line, needle, n, ok] of C) {
    try {
      await B.loadDoc(doc + '\nafter\n');
      await B.clickLine(line, 'first', needle);
      await B.caretAt(needle, 'after');
      await back(n);
      await sleep(300); await B.settle(200);
      await page.keyboard.press('Escape'); await sleep(200); await B.settle(300);
      const b = await blocks();
      const src = await B.source();
      check(name, ok(b, src), `src=${J(src)} blocks=${J(b.slice(0, 2).map((h) => h.replace(/ data-l="\d+"/g, '').slice(0, 200)))}`);
    } catch (e) { check(name, false, 'threw ' + e.message.split('\n')[0]); }
  }
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' ')}`); stop(); await B.close(); }
