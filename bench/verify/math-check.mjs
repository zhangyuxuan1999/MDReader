// bench/verify/math-check.mjs — semantics of the app's own `$` rules (no markdown-it reference exists):
// currency, suffix currency ("5$ each"), math in quotes/lists/tables, html-ish TeX, entities, unclosed `$$`,
// `$$` mid-paragraph, escaped dollars; the per-block result must also equal the whole-document result.
// Run: node bench/verify/math-check.mjs   (dev server on :5202)
import { openApp2, loadSettled, assertEqualsReference, harness, finish } from './lib2.mjs';

const H = harness('math');
const app = await openApp2();
const { page } = app;

const dump = () => page.evaluate(() => Array.from(document.querySelectorAll('.md-block')).map((b) => ({
  text: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 300),
  katex: b.querySelectorAll('.katex').length,
  errors: Array.from(b.querySelectorAll('.katex-error')).map((e) => e.getAttribute('title')?.slice(0, 120)),
  mathSpans: b.querySelectorAll('.md-math').length,
  blockMath: b.querySelectorAll('.md-math--block').length,
  // KaTeX 0.18 inserts a zero-width space (U+200B) inside sub/superscript vlists; it is invisible
  // layout scaffolding, not content, so it is stripped before comparing the recovered TeX text.
  tex: Array.from(b.querySelectorAll('.katex-html')).map((a) => a.textContent.replace(/\u200b/g, '').replace(/\s+/g, '')),
  annotations: b.querySelectorAll('annotation').length, semantics: b.querySelectorAll('semantics').length, mathml: b.querySelectorAll('math').length,
  html: b.innerHTML.replace(/<span class="katex">[\s\S]*?<\/span><\/span><\/span>/g, '[K]').replace(/\s+/g, ' ').slice(0, 400),
})));

const cases = [
  ['currency prefix only', 'Costs $5 and $10 today; $5.00 to $10.50; US$3-$4.\n', (b) => b[0].mathSpans === 0],
  ['suffix currency "5$ each" after a "$5"', 'Price $5, then 5$ each.\n', (b) => b[0].mathSpans === 0],
  ['suffix currency alone', 'It costs 5$ each and 10$ total.\n', (b) => b[0].mathSpans === 0],
  ['dollar alone / double dollar words', 'A $ sign, $$ two, a$b$c and end.\n', (b) => b[0].mathSpans === 0 || b[0].errors.length === 0],
  ['escaped dollars', 'Escaped \\$x\\$ and \\$5.\n', (b) => b[0].text.includes('$x$') && b[0].mathSpans === 0],
  ['inline math basic', 'Let $x^2 + y_1$ hold.\n', (b) => b[0].mathSpans === 1 && b[0].tex[0] === 'x2+y1' && b[0].errors.length === 0],
  ['inline math with < > & and \\text', '$a < b > c$ and $\\text{a\\&b}$.\n', (b) => b[0].mathSpans === 2 && b[0].errors.length === 0],
  ['inline display $$..$$', 'See $$x < y$$ here.\n', (b) => b[0].mathSpans === 1 && b[0].text.includes('See') && b[0].text.includes('here')],
  ['block math aligned', '$$\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n$$\n', (b) => b[0].blockMath === 1 && b[0].errors.length === 0],
  ['block math in blockquote', '> $$\n> a = b\n> $$\n', (b) => b[0].blockMath === 1 && b[0].tex[0] === 'a=b'],
  ['inline math in list + block math in list item', '- $x$ item\n- $$\n  y\n  $$\n', (b) => b[0].mathSpans === 2 && b[0].blockMath === 1],
  ['math in table cells', '| $a$ | $$b$$ |\n|---|---|\n| $c_1$ | d |\n', (b) => b[0].mathSpans === 3 && b[0].errors.length === 0],
  ['unclosed $$ block runs to end (no crash, text kept)', '$$\na = b\n\nnext para\n', (b) => b.some((x) => x.text.includes('next para') || x.tex.some((t) => t.includes('next para')))],
  ['$$ at line start followed by prose ("$$ is the price")', '$$ is the price\n\nnext para\n', (b) => b.some((x) => x.text.includes('next para')) && b.some((x) => x.text.includes('is the price'))],
  ['single $ unclosed', 'A single $ here and text\n\n$unclosed math runs?\n\nnext\n', (b) => b.every((x) => x.mathSpans === 0)],
  ['math with markdown-looking tex', '$a_1 * b_2 * c$ and $\\{x | x > 0\\}$ and $[a](b)$\n', (b) => b[0].mathSpans === 3 && b[0].errors.length === 0],
  ['CJK around math', '面积为$S=\\pi r^2$，其中$r$为半径。\n', (b) => b[0].mathSpans === 2],
  ['math block with trailing text on closer line', '$$\nx\n$$ tail\n', (b) => b[0].blockMath === 1 && b[0].text.includes('tail')],
  ['giant tex > 20000 chars shown as code', '$' + 'x+'.repeat(11000) + 'y$\n', (b) => b[0].katex === 0 && b[0].text.includes('x+x+')],
  ['math inside inline code and fence must stay literal', '`$x$` and\n\n```\n$$\ny\n$$\n```\n', (b) => b.every((x) => x.mathSpans === 0)],
  ['math inside html block', '<div>\n$x$\n</div>\n', (b) => true],
];
for (const [name, text, ok] of cases) {
  await loadSettled(page, text, 'm.md');
  const b = await dump();
  console.log(`--- ${name}\n${JSON.stringify(b)}`);
  let pass = false;
  try { pass = ok(b); } catch { pass = false; }
  if (!pass) H.fail(`math semantics: ${name}`, { text, blocks: b });
  else H.pass(`math semantics: ${name}`);
  await assertEqualsReference(page, H, `math per-block == whole-doc: ${name}`);
}

// ---------------------------------------------------------------- KaTeX MathML half after DOMPurify: <semantics>/<annotation> present?
await loadSettled(page, 'Let $x^2$ hold.\n', 'mathml.md');
const mm = await page.evaluate(() => {
  const math = document.querySelector('.md-block .katex-mathml math');
  return { math: !!math, semantics: !!math?.querySelector('semantics'), annotation: !!math?.querySelector('annotation'), mathInner: math?.innerHTML.replace(/\s+/g, ' ').slice(0, 300) ?? null, strayText: math ? Array.from(math.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()) : null };
});
console.log('mathml after sanitize:', JSON.stringify(mm));
if (!mm.math || !mm.semantics || !mm.annotation) H.fail('math: DOMPurify strips <semantics>/<annotation> from KaTeX MathML (TeX source left as a stray text node inside <math>)', mm);
else H.pass('math: KaTeX MathML keeps <semantics>/<annotation> after sanitising');

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
