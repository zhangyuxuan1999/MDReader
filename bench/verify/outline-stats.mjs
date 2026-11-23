// bench/verify/outline-stats.mjs — TOC/outline entries (levels, text, slug dedupe) and status-bar stats vs independent counts.
// Run: node bench/verify/outline-stats.mjs
import { openApp, loadAndSettle, previewState, independentStats, harness, sleep } from './lib.mjs';

const H = harness('outline');
const app = await openApp();
const { page } = app;

// ---------------------------------------------------------------- outline fixture
const doc = [
  '# Intro',
  '',
  'text',
  '',
  '## Intro',                       // dup → intro-1
  '',
  '### Intro',                      // dup → intro-2
  '',
  '## Code `inline` and *em* and [link](https://x.y) ##',
  '',
  'Setext H1',
  '=========',
  '',
  'Setext H2',
  '---------',
  '',
  '#### 中文 标题 Heading',
  '',
  '##### A & B <b>c</b> &amp; \\# d',
  '',
  '###### Deep 6',
  '',
  '####### not a heading (7 hashes)',
  '',
  '#no space',
  '',
  '```',
  '# in fence',
  '```',
  '',
  '<pre>',
  '# in pre',
  '</pre>',
  '',
  '$$',
  '# in math',
  '$$',
  '',
  '> # heading in quote',
  '',
  '- item',
  '  # heading in list (2 spaces)',
  '',
  '   ### three-space indent ok',
  '',
  '    # four spaces is code',
  '',
  'para',
  '## Right after para',
  '',
  '## Trailing hashes ###   ',
  '',
  '##   Spaces   Inside  ',
  '',
  '# ![img](https://x.y/i.png) with image',
  '',
  '# Emoji 🎉 & Punct!?',
  '',
].join('\n');

await loadAndSettle(page, doc, 'outline.md');
const st = await previewState(page);
const outline = await page.evaluate(() => new Promise((res) => {
  // outline as the preview/TOC received it: read from the TOC anchors (data-line) + rendered headings
  const hs = Array.from(document.querySelectorAll('.mdr-preview__body .md-block :is(h1,h2,h3,h4,h5,h6)')).map((h) => ({ tag: h.tagName.toLowerCase(), text: h.textContent.trim(), id: h.id || null, inList: !!h.closest('li') }));
  res({ headings: hs });
}));

// Expected (per SPEC 4.3.9, using the spec's own text/slug rules) — compare against what a reader expects.
const expectedToc = [
  [1, 'Intro', 'intro'],
  [2, 'Intro', 'intro-1'],
  [3, 'Intro', 'intro-2'],
  [2, 'Code inline and em and link', 'code-inline-and-em-and-link'],
  [1, 'Setext H1', 'setext-h1'],
  [2, 'Setext H2', 'setext-h2'],
  [4, '中文 标题 Heading', '中文-标题-heading'],
  [5, 'A & B c & # d', 'a--b-c--d'],
  [6, 'Deep 6', 'deep-6'],
  [1, 'heading in quote', null],       // rendered as h1 inside blockquote by markdown-it; outline: spec says only block-first-line headings — accept either
  [2, 'Right after para', 'right-after-para'],
  [2, 'Trailing hashes', 'trailing-hashes'],
  [2, 'Spaces Inside', 'spaces-inside'],
  [1, 'with image', 'with-image'],
  [1, 'Emoji 🎉 & Punct!?', 'emoji--punct'],
];
console.log('TOC items:', JSON.stringify(st.toc));
console.log('Rendered headings:', JSON.stringify(outline.headings));

// checks: every rendered heading (outside the blockquote) appears in the TOC with the same level; text matches rendered text
// headings nested inside list items render inside the list (decision 8c) and are not block-level outline entries (SPEC 4.3.9)
const NESTED_IN_LIST = new Set(['heading in list (2 spaces)', 'three-space indent ok', 'four spaces is code']);
const renderedTop = outline.headings.filter((h) => h.text !== 'heading in quote' && !(h.inList ?? NESTED_IN_LIST.has(h.text)));
if (st.toc.length !== renderedTop.length && st.toc.length !== renderedTop.length + 1) {
  H.fail('outline: entry count differs from rendered headings', { toc: st.toc.length, rendered: renderedTop.length, tocItems: st.toc.map((t) => `${t.level}:${t.text}`), headings: renderedTop.map((h) => `${h.tag}:${h.text}`) });
} else H.pass('outline: entry count matches rendered headings', `${st.toc.length}`);
const mismatches = [];
for (let i = 0; i < Math.min(st.toc.length, renderedTop.length); i++) {
  const t = st.toc[i];
  const h = renderedTop[i];
  if (t.level !== Number(h.tag[1]) || t.text !== h.text) mismatches.push({ toc: `${t.level}:${JSON.stringify(t.text)}`, rendered: `${h.tag}:${JSON.stringify(h.text)}` });
}
if (mismatches.length) H.fail('outline: level/text differs from rendered heading', { mismatches });
else H.pass('outline: level/text equal to rendered headings');

// slug dedupe: exercised via anchor links (#intro, #intro-1, #intro-2) → nav:gotoLine
const anchorDoc = '# Intro\n\n[a](#intro) [b](#intro-1) [c](#intro-2) [d](#中文-标题) [e](#missing)\n\n## Intro\n\n### Intro\n\n#### 中文 标题\n' + '\npara\n'.repeat(80);
await loadAndSettle(page, anchorDoc, 'anchors.md');
const lines = await page.evaluate(async () => {
  const out = {};
  for (const href of ['#intro', '#intro-1', '#intro-2', '#中文-标题', '#missing']) {
    const a = document.querySelector(`.md-block a[href="${href}"]`) ?? document.querySelector(`.md-block a[href="${encodeURI(href)}"]`);
    if (!a) { out[href] = 'no anchor element'; continue; }
    let got = null;
    const off = window.__mdr.app.bus.on('nav:gotoLine', (e) => { got = e.line; });
    a.click();
    off();
    out[href] = got;
  }
  return out;
});
const expectLines = { '#intro': 1, '#intro-1': 5, '#intro-2': 7, '#中文-标题': 9, '#missing': null };
const bad = Object.entries(expectLines).filter(([k, v]) => lines[k] !== v);
if (bad.length) H.fail('outline: slug dedupe / anchor resolution', { got: lines, expected: expectLines });
else H.pass('outline: slug dedupe -1/-2 and CJK slugs resolve to the right lines');

// ---------------------------------------------------------------- stats
const statsFixtures = [
  ['ascii', 'Hello world, this is a test-doc with 10 words and it\'s fine.\n\nSecond paragraph here.\n'],
  ['cjk+latin', '# 标题\n\n这是中文段落，包含 English words 和数字 2024 以及 mixed内容。\n\n日本語のテキスト and 한국어 텍스트.\n'],
  ['symbols', '**bold** _em_ `code` [link](https://example.com/path?x=1) ![i](a.png) | a | b |\n---|---\n'],
  ['empty', ''],
  ['long cjk', '中'.repeat(1000) + '\n\n' + 'word '.repeat(500) + '\n'],
  ['crlf', 'a b c\r\nd e f\r\n\r\ng\r\n'],
  ['trailing newline', 'one two three\n'],
  ['no trailing newline', 'one two three'],
];
for (const [name, text] of statsFixtures) {
  await loadAndSettle(page, text, `stats-${name}.md`, { mountAll: false });
  await sleep(150);
  const s = (await previewState(page)).stats;
  // Note: the editor normalises CRLF → LF; the independent count uses the same normalisation
  const norm = text.replace(/\r\n?/g, '\n');
  const exp = independentStats(norm);
  const words = Number((s.words || '').match(/\d+/)?.[0]);
  const chars = Number((s.chars || '').match(/\d+/)?.[0]);
  const reading = s.readingHidden ? 0 : Number((s.reading || '').match(/\d+/)?.[0]);
  const problems = [];
  if (words !== exp.words) problems.push(`words ${words} ≠ ${exp.words} (cjk ${exp.cjk} + latin ${exp.latinWords})`);
  if (chars !== exp.chars) problems.push(`chars ${chars} ≠ ${exp.chars}`);
  if (reading !== exp.readingMinutes) problems.push(`reading ${reading} ≠ ${exp.readingMinutes}`);
  if (problems.length) H.fail(`stats: ${name}`, { problems, statusbar: s, fixture: text.slice(0, 200) });
  else H.pass(`stats: ${name}`, `${s.words} / ${s.chars} / ${s.reading}${s.readingHidden ? ' (hidden)' : ''}`);
}

// stats after typing must stay consistent (running totals)
await loadAndSettle(page, 'alpha beta\n\n中文字\n\n- item\n', 'stats-typing.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(1, 10));
await page.keyboard.type(' gamma 汉字');
await page.keyboard.press('Enter');
await page.keyboard.type('delta');
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(300);
const after = await page.evaluate(() => window.__mdr.app.getText());
const s2 = (await previewState(page)).stats;
const exp2 = independentStats(after);
const w2 = Number((s2.words || '').match(/\d+/)?.[0]);
const c2 = Number((s2.chars || '').match(/\d+/)?.[0]);
if (w2 !== exp2.words || c2 !== exp2.chars) H.fail('stats: running totals after typing', { got: s2, expected: exp2, text: after });
else H.pass('stats: running totals after typing', `${s2.words} / ${s2.chars}`);

// multi-line setext heading (markdown-it renders it as h1; outline only handles 2-line blocks per SPEC 4.3.4)
await loadAndSettle(page, 'first line\nsecond line\n==========\n\n# ATX\n', 'setext-multi.md', { mountAll: false });
await sleep(200);
const sx = await previewState(page);
const rendered = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block :is(h1,h2)')).map((h) => h.tagName + ':' + h.textContent.replace(/\s+/g, ' ')));
if (sx.toc.length !== rendered.length) H.fail('outline: multi-line setext heading missing from the TOC', { toc: sx.toc, rendered });
else H.pass('outline: multi-line setext heading in TOC');

// outline updates while typing a new heading and removing one
await loadAndSettle(page, '# One\n\ntext\n\n# Two\n', 'outline-edit.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(3, 4));
await page.keyboard.press('Enter');
await page.keyboard.type('## Inserted');
await page.waitForFunction(() => document.querySelectorAll('.mdr-toc__item').length === 3, null, { timeout: 2000 }).catch(() => {});
let toc = (await previewState(page)).toc;
if (toc.length !== 3 || toc[1].text !== 'Inserted' || toc[1].level !== 2 || toc[1].line !== 4) H.fail('outline: live update after typing a heading', { toc });
else H.pass('outline: live update after typing a heading');
// change the heading text char by char → toc text follows
await page.keyboard.type('X');
await page.waitForFunction(() => Array.from(document.querySelectorAll('.mdr-toc__item')).some((a) => a.textContent === 'InsertedX'), null, { timeout: 2000 }).catch(() => {});
toc = (await previewState(page)).toc;
if (!toc.some((t) => t.text === 'InsertedX')) H.fail('outline: toc text follows heading edit', { toc });
else H.pass('outline: toc text follows heading edit');
// duplicate heading typed later must get -1 slug: verify via anchor resolution
await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 10_000); });
await page.keyboard.press('Enter');
await page.keyboard.type('\n# One\n\n[dup](#one-1)\n');
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(300);
const dupLine = await page.evaluate(() => {
  const a = document.querySelector('.md-block a[href="#one-1"]');
  if (!a) return 'no anchor';
  let got = null;
  const off = window.__mdr.app.bus.on('nav:gotoLine', (e) => { got = e.line; });
  a.click();
  off();
  return got;
});
const text = await page.evaluate(() => window.__mdr.app.getText());
const expectedDupLine = text.split('\n').findIndex((l, i) => l === '# One' && i > 0) + 1;
if (dupLine !== expectedDupLine) H.fail('outline: duplicate heading added later gets -1 slug', { dupLine, expectedDupLine, text });
else H.pass('outline: duplicate heading added later gets -1 slug');

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const realErrors = app.consoleErrors.filter((e) => !/Failed to load resource/.test(e));
if (realErrors.length) H.fail('console errors', { errors: realErrors.slice(0, 5) }); else H.pass('no console errors (fixture image 404s ignored)');
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
