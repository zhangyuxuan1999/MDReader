// bench/verify/v4-app-task.mjs — verify-app (0.2.0 stage 2d). U16: a preview task checkbox toggles exactly
// its own source line, in many list shapes; measured the same way on the candidate and on 0.1.1.
// Prints RESULT lines (the changed lines after one click and whether a second click restores the source).
//   Candidate:            MDR_PORT=5436 node bench/verify/v4-app-task.mjs [filter]
//   Candidate, edit off:  MDR_EDIT=off MDR_PORT=5436 node bench/verify/v4-app-task.mjs [filter]
//   Baseline 0.1.1 dist:  MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-task.mjs [filter]
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE, lineDiff } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const CR = String.fromCharCode(13);
const FILL = Array.from({ length: 60 }, (_, i) => `填充 ${i} 段。\n`).join('\n');
// [name, doc, index of the checkbox to click (0-based, in document order)]
const CASES = [
  ['plain', '- [ ] a\n- [ ] b\n- [ ] c\n', 1],
  ['nested', '- [ ] p\n  - [ ] child1\n  - [ ] child2\n- [ ] q\n', 2],
  ['nested-deep', '- [ ] p\n  - [ ] c1\n    - [ ] g1\n    - [x] g2\n- [ ] q\n', 3],
  ['after-para', 'Intro line\n- [ ] a\n- [ ] b\n', 1],
  ['after-para-blank', 'Intro line\n\n- [ ] a\n- [ ] b\n', 1],
  ['quote', '> - [ ] qa\n> - [ ] qb\n', 1],
  ['quote-nested', '> quote text\n>\n> - [ ] qa\n>   - [ ] qsub\n', 1],
  ['crlf', `- [ ] a${CR}\n- [ ] b${CR}\n- [ ] c${CR}\n`, 2],
  ['leading-blank', '\n\n- [ ] a\n- [ ] b\n', 1],
  ['leading-blank-first', '\n- [ ] a\n- [ ] b\n', 0],
  ['no-final-newline', 'para\n\n- [ ] a\n- [ ] b', 1],
  ['no-final-newline-single', '- [ ] only', 0],
  ['ordered', '1. [ ] one\n2. [x] two\n3. [ ] three\n', 1],
  ['ordered-paren', '1) [ ] one\n2) [ ] two\n', 1],
  ['loose', '- [ ] a\n\n- [ ] b\n\n- [ ] c\n', 2],
  ['star-plus', '* [ ] s1\n* [ ] s2\n\n+ [ ] p1\n+ [ ] p2\n', 3],
  ['tab-marker', '-\t[ ] tabbed\n- [ ] spaced\n', 0],
  ['upper-x', '- [X] upper\n- [ ] lower\n', 0],
  ['continuation', '- [ ] first line\n  continued\n- [ ] next\n', 1],
  ['lazy', '- [ ] a\nlazy text\n- [ ] b\n', 1],
  ['after-code', '```\n- [ ] fake\n- [ ] fake2\n```\n\n- [ ] real1\n- [ ] real2\n', 1],
  ['far-down', `${FILL}\n- [ ] far1\n- [ ] far2\n`, 1],
  ['in-list-item', '- outer\n  - [ ] inner1\n  - [ ] inner2\n', 1],
  ['sub-para', '- [ ] a\n\n  para under a\n\n  - [ ] sub\n', 1],
  ['heading-tight', '## 待办\n- [ ] h1\n- [ ] h2\n', 1],
  ['indented-1', ' - [ ] one space\n - [ ] two\n', 1],
  ['ordered-big', '9. [ ] nine\n10. [ ] ten\n', 1],
];

try {
  await B.boot('mode=split');
  if (process.env.MDR_EDIT === 'off') {
    await page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
    await sleep(200);
    out('previewEdit', await page.evaluate(() => localStorage.getItem('mdr.previewEdit')));
  }
  for (const [name, doc, idx] of CASES) {
    if (only && !name.startsWith(only)) continue;
    try {
      await page.keyboard.press('Escape');
      await B.loadDoc(doc);
      const loaded = await B.source();
      if (name === 'far-down') { await page.evaluate(() => window.__mdr.app.preview.scrollToLine(window.__mdr.app.editor.view.state.doc.lines, 0, 'instant')); await sleep(900); }
      const boxes = await page.evaluate(() => document.querySelectorAll('.mdr-preview input[type=checkbox]').length);
      const clickBox = async () => {
        await page.evaluate((i) => {
          const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[i];
          window.__mdr.app.preview.el.scrollTop += b.getBoundingClientRect().top - 300;
        }, idx);
        await sleep(300);
        const r = await page.evaluate((i) => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[i].getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, idx);
        await page.mouse.click(r.x, r.y);
        await B.settle(300);
      };
      await clickBox();
      const after1 = await B.source();
      const d = lineDiff(loaded, after1);
      const checked = await page.evaluate((i) => document.querySelectorAll('.mdr-preview input[type=checkbox]')[i]?.checked ?? null, idx);
      await page.keyboard.press('Escape'); await sleep(100);
      await clickBox();
      const after2 = await B.source();
      out(name, {
        boxes, loadedSame: loaded === doc, changed: d.before.length || d.after.length ? { line: d.first, before: d.before, after: d.after } : null,
        checked, restored: after2 === loaded, session: !!(await page.evaluate(() => document.querySelector('.mdr-preview .is-editing'))),
      });
    } catch (e) { out(name, `ERROR ${String(e.message).split('\n')[0]}`); }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
