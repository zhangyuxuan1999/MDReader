// bench/verify/big.mjs — pathological sizes: 1 MB single paragraph, 20k one-line blocks; correctness + timings.
// Run: node bench/verify/big.mjs
import { openApp, loadAndSettle, previewHtml, renderReference, canonical, diffCanonical, harness, previewState, sleep } from './lib.mjs';
import MarkdownIt from 'markdown-it';

const H = harness('big');
const app = await openApp();
const { page } = app;

// ---------------------------------------------------------------- 1 MB single paragraph (CJK + latin + inline markup)
const unit = '这是一段很长的中文文本，用于测试 **加粗** 和 *斜体* 以及 `code` 和 [链接](https://example.com) 的渲染性能。The quick brown fox jumps over the lazy dog. ';
let para = '';
while (para.length < 1_000_000) para += unit;
const paraDoc = `# Big paragraph\n\n${para}\n\n## After\n\ntail\n`;
const tNode0 = performance.now();
const refHtml = new MarkdownIt({ html: true, linkify: true }).render(paraDoc);
const nodeMs = performance.now() - tNode0;
console.log(`markdown-it (node) renders the 1 MB paragraph in ${nodeMs.toFixed(0)} ms → ${refHtml.length} chars`);

const t1 = await loadAndSettle(page, paraDoc, 'para1mb.md');
const p1 = await page.evaluate(() => {
  const blocks = Array.from(document.querySelectorAll('.md-block'));
  const big = blocks[1];
  return {
    blocks: blocks.length,
    bigTag: big?.firstElementChild?.tagName, bigClass: big?.firstElementChild?.className,
    strongs: big?.querySelectorAll('strong').length ?? 0,
    links: big?.querySelectorAll('a').length ?? 0,
    textLen: big?.textContent.length ?? 0,
    rawMarkupVisible: /\*\*加粗\*\*/.test(big?.textContent ?? ''),
    afterH2: !!document.querySelector('.md-block h2'),
    toc: document.querySelectorAll('.mdr-toc__item').length,
  };
});
H.measure('1 MB paragraph: load → idle (all rendered)', `${t1.totalMs} ms`, 'informational', true);
console.log('1 MB paragraph:', JSON.stringify(p1));
if (p1.rawMarkupVisible || p1.strongs === 0) {
  H.fail('1 MB paragraph rendered as raw text (HTML_FLAG_PLAIN), inline markup not rendered', { ...p1, note: 'SPEC 4.4 maxHtmlChars=200000 makes any block > 200 KB plain text; markdown-it renders it in ' + nodeMs.toFixed(0) + ' ms in node' });
} else H.pass('1 MB paragraph rendered with inline markup');
if (!p1.afterH2 || p1.toc !== 2) H.fail('1 MB paragraph: content after it', p1); else H.pass('1 MB paragraph: following heading rendered + in TOC');

// typing inside the 1 MB paragraph must not break the app
await page.evaluate(() => window.__mdr.app.editor.gotoLine(3, 20));
const tType = Date.now();
await page.keyboard.type('XYZ');
await page.evaluate(() => window.__mdr.waitIdle());
// The preview's giant guard (SPEC §5.5, GIANT_SETTLE_MS = 500 ms) deliberately keeps the old content
// on screen until a > 256 KB payload has been stable for half a second, which is AFTER the worker's
// `idle`: give it that window before asking whether the keystroke landed.
await new Promise((r) => setTimeout(r, 1500));
const typed = await page.evaluate(() => document.querySelectorAll('.md-block')[1]?.textContent.includes('XYZ'));
H.measure('1 MB paragraph: type 3 chars → idle', `${Date.now() - tType} ms`, 'informational', true);
if (!typed) H.fail('1 MB paragraph: typed text appears in preview', {}); else H.pass('1 MB paragraph: typed text appears in preview');

// a 150 KB paragraph (below the plain threshold) must render markup
let para2 = '';
while (para2.length < 150_000) para2 += unit;
await loadAndSettle(page, para2 + '\n', 'para150k.md');
const p2 = await page.evaluate(() => ({ strongs: document.querySelectorAll('.md-block strong').length, plain: !!document.querySelector('.md-code--plain') }));
if (p2.strongs === 0 || p2.plain) H.fail('150 KB paragraph rendered as markdown', p2); else H.pass('150 KB paragraph rendered as markdown', `${p2.strongs} <strong>`);

// ---------------------------------------------------------------- 20k one-line blocks
const kinds = (i) => {
  switch (i % 8) {
    case 0: return `# Heading ${i}`;
    case 1: return `Paragraph ${i} with **bold** and [link](https://example.com/${i}).`;
    case 2: return `- item ${i}`;
    case 3: return `> quote ${i}`;
    case 4: return `\`\`\`js\nconst x${i} = ${i};\n\`\`\``;
    case 5: return `| a | b |\n|---|---|\n| ${i} | x |`;
    case 6: return `---`;
    default: return `中文段落 ${i}，测试。`;
  }
};
const many = Array.from({ length: 20_000 }, (_, i) => kinds(i)).join('\n\n') + '\n';
const t2 = await loadAndSettle(page, many, 'blocks20k.md', { timeout: 120_000 });
const s2 = await previewState(page);
H.measure('20k blocks: load → worker idle', `${t2.idleMs} ms`, 'P3 idle < 20 s', t2.idleMs < 20_000);
H.measure('20k blocks: load → all mounted', `${t2.totalMs} ms`, 'informational', true);
if (s2.blocks !== 20_000) H.fail('20k blocks: block count', { blocks: s2.blocks }); else H.pass('20k blocks: 20000 blocks', `toc ${s2.toc.length}`);
if (s2.toc.length !== 2500) H.fail('20k blocks: TOC has 2500 headings', { toc: s2.toc.length }); else H.pass('20k blocks: TOC has 2500 headings');
const html2 = await previewHtml(page);
const exp2 = canonical(renderReference(many));
const act2 = canonical(html2);
const d2 = diffCanonical(exp2, act2);
if (d2) H.fail('20k blocks: rendering equals markdown-it', d2); else H.pass('20k blocks: rendering equals markdown-it', `${act2.length} canonical lines`);

// heading at the very end must be in the TOC and clicking it navigates
const lastHeadingLine = many.split('\n').lastIndexOf('# Heading 19992') + 1;
const tocLast = s2.toc[s2.toc.length - 1];
if (tocLast.line !== lastHeadingLine || tocLast.text !== 'Heading 19992') H.fail('20k blocks: last TOC entry', { tocLast, lastHeadingLine }); else H.pass('20k blocks: last TOC entry correct');

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
if (app.consoleErrors.length) H.fail('console errors', { errors: app.consoleErrors.slice(0, 5) }); else H.pass('no console errors');
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
