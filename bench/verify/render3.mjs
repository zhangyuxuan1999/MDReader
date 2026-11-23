// bench/verify/render3.mjs — targeted fresh-load reproductions of the differences found by render2/incremental:
// a list that directly follows a heading/paragraph/quote line (no blank line) loses list semantics across blank
// lines; indented heading inside such a list; setext heading inside a Heading-kind block (TOC); escaped `]` in a
// reference label; HTML block (type 6) interrupting a paragraph; multi-line open tag of a container.
// Run: node bench/verify/render3.mjs   (dev server on :5202)
import { openApp2, loadSettled, assertEqualsReference, harness, finish, blocksHtml, tocItems, renderReference } from './lib2.mjs';

const H = harness('render3');
const app = await openApp2();
const { page } = app;

const cases = [
  ['list directly after heading, items separated by blank line', '# Title\n- a\n\n- b\n'],
  ['ordered list directly after paragraph, items separated by blank lines', 'Steps:\n1. one\n\n2. two\n\n3. three\n'],
  ['list directly after heading, continuation paragraph after blank', '## H\n- item\n\n  continuation of item\n- next\n'],
  ['list directly after quote line, items separated by blank line', '> q\n- a\n\n- b\n'],
  ['task list directly after paragraph, blank-separated', 'Todo:\n- [ ] a\n\n- [x] b\n'],
  ['indented heading inside a list that follows a heading (no blank)', '### Mid list\n- item two\n  # continuation\n- item three\n'],
  ['indented heading inside a list that follows a paragraph (no blank)', 'text\n- item two\n  # continuation\n- item three\n'],
  ['html block type 6 interrupts paragraph, # inside', 'text\n<div>\n# inside\n</div>\nafter\n'],
  ['html container with multi-line open tag', '<div\n  class="x"\n  align="center">\n\ncontent **md**\n\n</div>\n'],
  ['reference label with escaped ]', '[a\\]b]\n\n[a\\]b]: https://example.com/ab\n'],
  ['reference label with escaped ] used inline', 'see [x\\]y][k] here\n\n[k]: https://example.com/k\n'],
  ['setext heading inside a heading block (TOC)', '# Title\nSubtitle\n---\n\ntext\n'],
];
for (const [name, text] of cases) {
  await loadSettled(page, text, 'r3.md');
  const ok = await assertEqualsReference(page, H, `fresh: ${name}`);
  if (!ok) {
    const html = await blocksHtml(page);
    console.log(`--- ${name}\nsource: ${JSON.stringify(text)}\nexpected(markdown-it): ${JSON.stringify(renderReference(text))}\nactual(preview):       ${JSON.stringify(html)}`);
  }
}

// TOC for the setext-inside-heading-block case
await loadSettled(page, '# Title\nSubtitle\n---\n\ntext\n\n## Real H2\n', 'toc.md');
const toc = await tocItems(page);
const rendered = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block :is(h1,h2,h3)')).map((h) => `${h.tagName[1]}:${h.textContent.trim()}`));
console.log('toc:', JSON.stringify(toc), 'rendered:', JSON.stringify(rendered));
if (toc.length !== rendered.length) H.fail('toc: setext heading directly under an ATX heading line is rendered as <h2> but missing from the TOC', { toc, rendered });
else H.pass('toc: setext heading under ATX heading line present');

// numbering / loose-tight consequences, stated concretely
await loadSettled(page, 'Steps:\n1. one\n\n2. two\n\n3. three\n', 'ol.md');
const ol = await page.evaluate(() => ({ lists: document.querySelectorAll('.md-block ol').length, starts: Array.from(document.querySelectorAll('.md-block ol')).map((o) => o.getAttribute('start')), pInLi: document.querySelectorAll('.md-block li > p').length }));
console.log('ordered list after paragraph:', JSON.stringify(ol));
if (ol.lists !== 1) H.fail('ordered list after a paragraph line: split into several <ol> (tight) instead of one loose <ol>', { ...ol, expected: { lists: 1, pInLi: 3 } });
else H.pass('ordered list after paragraph is one list');

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
