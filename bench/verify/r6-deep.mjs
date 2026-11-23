// bench/verify/r6-deep.mjs — TOC collapse toggle, SPEC §13 declared deviations, ref-definition
// lifecycle across eviction, giant unclosed fence, slug re-dedupe.
// Run: node bench/verify/r6-deep.mjs      (dev server on :5202)
import { openApp, loadAndSettle, previewHtml, renderReference, canonical, diffCanonical, harness, BASE, sleep } from './lib.mjs';

const H = harness('r6');
const app = await openApp();
const { page } = app;

// ---------------------------------------------------------------- 1. TOC collapse toggle on a >3000-entry outline
const manyH = Array.from({ length: 1600 }, (_, i) => `# H1 ${i}\n\ntext\n\n## H2 ${i}\n\ntext\n\n### H3 ${i}\n\ntext\n`).join('\n');
await loadAndSettle(page, manyH, 'many.md', { mountAll: false });
const tocState = await page.evaluate(async () => {
  const items = () => document.querySelectorAll('.mdr-toc__item').length;
  const btn = document.querySelector('.mdr-toc__expand');
  const before = items();
  const label = btn?.textContent ?? null;
  btn?.click();
  await new Promise((r) => setTimeout(r, 400));
  const after = items();
  const label2 = btn?.textContent ?? null;
  btn?.click();
  await new Promise((r) => setTimeout(r, 400));
  return { before, after, back: items(), label, label2, hasBtn: !!btn };
});
console.log('toc collapse:', JSON.stringify(tocState));
if (!tocState.hasBtn) H.fail('toc: outline > 3000 entries silently drops levels >= 3 with no way to expand', tocState);
else if (tocState.after <= tocState.before) H.fail('toc: the expand toggle does not reveal the level-3 entries', tocState);
else H.pass('toc: >3000-entry outline collapses to h1/h2 with a working expand toggle', `${tocState.before} → ${tocState.after} → ${tocState.back}`);
// entries that are collapsed must still be navigable via #anchor
const anchorOk = await page.evaluate(async () => {
  let line = null;
  const off = window.__mdr.app.bus.on('nav:gotoLine', (e) => { line = e.line; });
  const a = document.createElement('a'); a.href = '#h3-7'; a.textContent = 'x';
  document.querySelector('.mdr-preview__body .md-block')?.appendChild(a);
  a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  off();
  return line;
});
if (anchorOk) H.pass('toc: an anchor to a collapsed heading still resolves', `line ${anchorOk}`);
else H.fail('toc: #anchor to a heading hidden by TOC collapsing does not resolve', { line: anchorOk });

// ---------------------------------------------------------------- 2. SPEC §13 declared deviations — measure them
const deviations = [
  ['html block spanning a blank line (§13)', '<div class="a">\n\nstill inside the div?\n\n</div>\n\nafter\n'],
  ['lazy continuation after a blank line (§13)', '> quote\n\nlazy?\n\n- item\n\nlazy item?\n'],
  ['multi-line reference title (§13)', '[a]\n\n[a]: https://e.com/a "title\nspanning two lines"\n\n[b]\n\n[b]: https://e.com/b\n  (paren title\n   over lines)\n'],
  ['html block spanning blank lines + markdown between', '<table>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n</table>\n'],
  ['ref definition split across a blank line', '[c]\n\n[c]:\n\nhttps://e.com/c\n'],
];
for (const [name, text] of deviations) {
  await loadAndSettle(page, text, 'dev.md');
  const d = diffCanonical(canonical(renderReference(text)), canonical(await previewHtml(page)));
  if (d) H.fail(`deviation: ${name}: preview != markdown-it (SPEC §13 accepted deviation?)`, { fixture: text, diffAt: d.index, expected: d.expected, actual: d.actual });
  else H.pass(`deviation: ${name} matches markdown-it after all`);
}

// ---------------------------------------------------------------- 3. ref definition added later, using block far away + evicted
const far = '# Top\n\nThe link is [far][late] here.\n\n' + Array.from({ length: 900 }, (_, i) => `Filler paragraph ${i} with words.`).join('\n\n') + '\n\nend\n';
await loadAndSettle(page, far, 'far.md', { mountAll: false });
await page.evaluate(() => { const p = window.__mdr.app.preview; p.el.scrollTop = p.el.scrollHeight; });
await sleep(800);
const evicted = await page.evaluate(() => {
  const b = document.querySelector('.mdr-preview__body .md-block');
  return { firstBlockPending: b?.classList.contains('is-pending') ?? null, scrollTop: window.__mdr.app.preview.el.scrollTop };
});
// append the definition at the very end while the using block is far/evicted
await page.evaluate(() => {
  const v = window.__mdr.app.editor;
  const doc = v.view.state.doc;
  v.view.dispatch({ changes: { from: doc.length, to: doc.length, insert: '\n[late]: https://example.org/LATE "L"\n' } });
});
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(400);
// scroll back to the top and check the link resolved
await page.evaluate(() => { window.__mdr.app.preview.el.scrollTop = 0; });
let resolved = null;
for (let i = 0; i < 40; i++) {
  resolved = await page.evaluate(() => {
    const b = document.querySelector('.mdr-preview__body .md-block:nth-child(2), .mdr-preview__body .md-block');
    const a = document.querySelector('.mdr-preview__body a[href="https://example.org/LATE"]');
    const stale = document.querySelectorAll('.md-block.is-stale').length;
    const txt = Array.from(document.querySelectorAll('.md-block')).slice(0, 4).map((x) => x.textContent.trim().slice(0, 40));
    return { hasAnchor: !!a, stale, txt };
  });
  if (resolved.hasAnchor) break;
  await sleep(250);
}
console.log('late-def far block:', JSON.stringify({ evicted, resolved }));
if (resolved?.hasAnchor) H.pass('refs: a definition appended at the end resolves a link near the top after scrolling back', `stale left: ${resolved.stale}`);
else H.fail('refs: a definition appended at the end never resolves the far-away link that uses it', { evicted, resolved });

// ---------------------------------------------------------------- 4. unclosed fence at line 1 of a long document, then closed
const longFence = '```js\n' + Array.from({ length: 4000 }, (_, i) => `const x${i} = ${i}; // # not a heading\n- not a list`).join('\n') + '\n';
await loadAndSettle(page, longFence, 'fence.md', { timeout: 120_000 });
const f1 = await page.evaluate(() => ({
  blocks: document.querySelectorAll('.md-block').length,
  pres: document.querySelectorAll('.mdr-preview__body pre').length,
  headings: document.querySelectorAll('.mdr-preview__body h1,h2,h3').length,
  lis: document.querySelectorAll('.mdr-preview__body li').length,
}));
if (f1.headings === 0 && f1.lis === 0 && f1.pres >= 1) H.pass('unclosed fence at line 1: whole document stays one code block', JSON.stringify(f1));
else H.fail('unclosed fence at line 1: content leaked out of the code block', f1);
// close it
await page.evaluate(() => {
  const v = window.__mdr.app.editor;
  const doc = v.view.state.doc;
  v.view.dispatch({ changes: { from: doc.length, to: doc.length, insert: '\n```\n\n# Real heading\n\n- real item\n' } });
});
await page.evaluate(() => window.__mdr.waitIdle());
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(1200);
const f2 = await page.evaluate(() => ({
  headings: document.querySelectorAll('.mdr-preview__body h1').length,
  lis: document.querySelectorAll('.mdr-preview__body li').length,
  pres: document.querySelectorAll('.mdr-preview__body pre').length,
  toc: document.querySelectorAll('.mdr-toc__item').length,
}));
if (f2.headings === 1 && f2.lis === 1 && f2.toc === 1) H.pass('unclosed fence closed: heading + list after it render and reach the TOC', JSON.stringify(f2));
else H.fail('closing a giant fence does not correctly re-render the content after it', f2);

// ---------------------------------------------------------------- 5. slug dedupe re-numbering after an edit
await loadAndSettle(page, '# Same\n\na\n\n# Same\n\nb\n\n# Same\n\nc\n', 'slug.md');
const s1 = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toc__item')).map((a) => a.dataset.slug ?? a.getAttribute('href')));
// rename the FIRST heading: the remaining two must renumber to Same / Same-1
await page.evaluate(() => {
  const v = window.__mdr.app.editor;
  v.view.dispatch({ changes: { from: 0, to: 6, insert: '# Other' } });
});
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(400);
const s2 = await page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toc__item')).map((a) => ({ t: a.textContent, s: a.dataset.slug ?? a.getAttribute('href') })));
console.log('slugs:', JSON.stringify(s1), '→', JSON.stringify(s2));
const want = ['#other', '#same', '#same-1'];
if (JSON.stringify(s2.map((x) => x.s)) === JSON.stringify(want)) H.pass('toc: slug dedupe renumbers after a heading rename', JSON.stringify(s2.map((x) => x.s)));
else H.fail('toc: slug dedupe does not renumber after a heading rename (anchors point at the wrong heading)', { before: s1, after: s2, expected: want });

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const re = app.consoleErrors.filter((e) => !/404|Failed to load resource|net::ERR/.test(e));
if (re.length) H.fail('console errors', { errors: re.slice(0, 5) }); else H.pass('no console errors');

await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
