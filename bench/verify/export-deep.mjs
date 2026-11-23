// bench/verify/export-deep.mjs — HTML export opened OFFLINE in a fresh page: standalone, headings with ids,
// code highlighted (hljs classes AND applied colours), KaTeX rendered once, tasks/tables/details present,
// export body == live preview (semantic), dark-theme export, export of large.md (time, main-thread cost).
// Run: node bench/verify/export-deep.mjs   (dev server on :5202)
import { openApp2, loadSettled, blocksHtml, canonical, diffCanonical, harness, finish, sleep, BASE } from './lib2.mjs';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const H = harness('export');
const app = await openApp2();
const { page } = app;

async function exportNow() {
  const t0 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'))]);
  const html = readFileSync(await dl.path(), 'utf8');
  return { html, ms: Date.now() - t0, name: dl.suggestedFilename() };
}

async function openOffline(html) {
  const p = await app.context.newPage();
  await p.route('**/*', (r) => r.abort());
  await p.setContent(html, { waitUntil: 'load' });
  await sleep(300);
  return p;
}

const doc = [
  '# Export Title', '', 'Intro with [ref][r] and `inline` and **bold** and 中文。', '',
  '## Section A', '', '```ts', 'const n: number = 42; // comment', 'export function f(s: string) { return `x${s}`; }', '```', '',
  '```py', 'def f(x):', '    return x  # c', '```', '', '```', 'no lang', '```', '',
  '## Section A', '', '### 中文 节', '', '- [ ] task', '- [x] done', '', '| a | b |', '|:--|--:|', '| 1 | 2 |', '',
  '<details>', '<summary>More</summary>', '', 'hidden **md**', '', '</details>', '',
  '> quote', '', '---', '', '![img](https://example.com/i.png)', '', '<img src="x" onerror="document.body.dataset.pwn=1">', '', '<script>document.body.dataset.pwn2=1</script>', '',
  '[r]: https://example.org/r', '',
].join('\n');

await loadSettled(page, doc, 'deep.md');
const previewHtml = await blocksHtml(page);
const { html, ms, name } = await exportNow();
H.measure('export: small doc time', `${ms} ms`, 'informational', true);
const off = await openOffline(html);
const r = await off.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const hs = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({ tag: h.tagName, id: h.id, text: h.textContent.trim() }));
  const kw = q('.hljs-keyword');
  const codeColor = q('pre code') ? getComputedStyle(q('pre code')).color : null;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const bodyColor = getComputedStyle(document.body).color;
  const details = q('details');
  const hidden = Array.from(document.querySelectorAll('p')).find((p) => p.textContent.includes('hidden'));
  return {
    hs, kwColor: kw ? getComputedStyle(kw).color : null, codeColor, bodyBg, bodyColor, lang: document.documentElement.lang, theme: document.documentElement.dataset.theme,
    title: document.title, charset: !!q('meta[charset]'), styles: document.querySelectorAll('style').length,
    checkbox: document.querySelectorAll('input[type=checkbox]').length, table: !!q('table'), details: !!details,
    // content-visibility keeps the hidden paragraph's own box size; the closed details box is only as tall as its summary
    detailsCollapsed: !!details && !details.open && !!hidden?.closest('details') && details.getBoundingClientRect().height <= details.querySelector('summary').getBoundingClientRect().height + 2,
    ref: q('a[href="https://example.org/r"]')?.textContent ?? null, pwn: document.body.dataset.pwn ?? null, pwn2: document.body.dataset.pwn2 ?? null,
    scripts: document.querySelectorAll('script').length, external: Array.from(document.querySelectorAll('link[href],script[src]')).length,
    detailsDebug: details ? { open: details.open, pInDetails: !!hidden?.closest('details'), pDisplay: hidden ? getComputedStyle(hidden).display : null, pH: hidden?.offsetHeight ?? null, summaryDisplay: getComputedStyle(details.querySelector('summary')).display, detailsH: details.offsetHeight } : null,
    fontFaces: Array.from(document.styleSheets).flatMap((s) => { try { return Array.from(s.cssRules); } catch { return []; } }).filter((r) => r.type === 5).length,
    h1Font: q('h1') ? getComputedStyle(q('h1')).fontSize : null, pFont: q('p') ? getComputedStyle(q('p')).fontSize : null,
    tableBorder: q('td') ? getComputedStyle(q('td')).borderTopWidth : null,
  };
});
console.log('offline export:', JSON.stringify(r));
const problems = [];
if (!r.charset || !r.styles) problems.push('no charset / no inline style');
if (r.hs.length !== 4 || r.hs[0].id !== 'export-title' || r.hs[1].id !== 'section-a' || r.hs[2].id !== 'section-a-1' || r.hs[3].id !== '中文-节') problems.push(`headings/ids ${JSON.stringify(r.hs)}`);
if (!r.kwColor) problems.push('no .hljs-keyword span in exported code');
else if (r.kwColor === r.codeColor) problems.push(`hljs colour not applied offline (keyword ${r.kwColor} == code ${r.codeColor})`);
if (r.checkbox !== 2 || !r.table || !r.details || r.ref !== 'ref') problems.push(`tasks ${r.checkbox} table ${r.table} details ${r.details} ref ${r.ref}`);
if (r.pwn || r.pwn2 || r.scripts) problems.push(`script executed / present: ${r.pwn} ${r.pwn2} ${r.scripts}`);
if (r.external) problems.push(`${r.external} external resources`);
if (r.h1Font === r.pFont) problems.push(`preview.css not applied offline (h1 ${r.h1Font} == p ${r.pFont})`);
if (problems.length) H.fail('export offline: standalone document checks', { problems, r });
else H.pass('export offline: standalone, ids, highlighted with colours, tasks/table/details, sanitised', `${html.length} bytes, ${name}`);
if (!r.detailsCollapsed) H.fail('export: <details> content not collapsed (markdown inside the container not nested)', { details: r.details, detailsCollapsed: r.detailsCollapsed, detailsDebug: r.detailsDebug });
else H.pass('export: <details> nested and collapsed');

// export body vs live preview (semantic, ignoring heading ids)
const expDom = new JSDOM(html);
const article = expDom.window.document.querySelector('.mdr-preview__body');
for (const h of article.querySelectorAll('[id]')) h.removeAttribute('id');
const expCanon = canonical(article.innerHTML);
const prevCanon = canonical(previewHtml);
const d = diffCanonical(prevCanon, expCanon);
if (d) H.fail('export: exported body differs from the live preview', d);
else H.pass('export: exported body == live preview (semantic)', `${expCanon.length} lines`);
await off.close();

// ---------------------------------------------------------------- math export: rendered once, offline
await loadSettled(page, '# M\n\nInline $E=mc^2$ and $\\alpha$.\n\n$$\n\\int_0^1 x\\,dx = \\frac12\n$$\n\n$5 and $10 stay text.\n', 'math-export.md');
const mx = await exportNow();
const offm = await openOffline(mx.html);
const m = await offm.evaluate(() => {
  const k = document.querySelectorAll('.katex').length;
  const mathml = document.querySelectorAll('.katex-mathml');
  const visibleMathml = Array.from(mathml).filter((e) => e.getBoundingClientRect().height > 0).length;
  const dup = (document.body.innerText.match(/E=mc/g) || []).length;
  const disp = document.querySelector('.katex-display, .md-math--block');
  const frac = document.querySelector('.katex .frac-line, .katex .mfrac');
  return { katex: k, mathml: mathml.length, visibleMathml, dup, display: !!disp, frac: !!frac, currency: document.body.innerText.includes('$5 and $10'), text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200), katexFont: document.querySelector('.katex') ? getComputedStyle(document.querySelector('.katex')).fontFamily : null };
});
console.log('offline math export:', JSON.stringify(m));
if (m.katex < 3 || !m.display || !m.currency) H.fail('export: math not rendered / currency broken', m);
else H.pass('export: 3 KaTeX formulas + display block, currency untouched');
if (m.visibleMathml > 0 || m.dup > 1) H.fail('export: formulas rendered twice offline (MathML visible)', m);
else H.pass('export: formulas shown once offline');
await offm.close();

// ---------------------------------------------------------------- dark theme export
await page.evaluate(() => window.__mdr.app.theme.set('dark'));
await sleep(200);
await loadSettled(page, '# Dark\n\n```ts\nconst a = 1;\n```\n\ntext\n', 'dark.md');
const dk = await exportNow();
const offd = await openOffline(dk.html);
const dres = await offd.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color, kw: document.querySelector('.hljs-keyword') ? getComputedStyle(document.querySelector('.hljs-keyword')).color : null }));
console.log('dark export:', JSON.stringify(dres));
const lum = (c) => { const m = c.match(/\d+/g); return m ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 : null; };
if (dres.theme !== 'dark' || lum(dres.bg) === null || lum(dres.bg) > 100 || lum(dres.fg) < 150) H.fail('export: dark theme export not dark / unreadable', dres);
else H.pass('export: dark theme exported as dark', JSON.stringify(dres));
await offd.close();
await page.evaluate(() => window.__mdr.app.theme.set('light'));

// ---------------------------------------------------------------- large.md export
const large = await (await fetch(`${BASE}/test-data/large.md`)).text();
await loadSettled(page, large, 'large.md', { mountAll: false, timeout: 180_000 });
await page.evaluate(() => { window.__lt.length = 0; });
const lx = await exportNow();
const lt = await page.evaluate(() => window.__lt.slice());
const ldom = new JSDOM(lx.html);
const lh = ldom.window.document.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
const srcH = (large.match(/^ {0,3}#{1,6}\s/gm) || []).length;
const lcodes = ldom.window.document.querySelectorAll('pre code').length;
const lhl = ldom.window.document.querySelectorAll('pre code [class*="hljs-"]').length;
const lscripts = ldom.window.document.querySelectorAll('script').length;
const lids = new Set(Array.from(ldom.window.document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.id));
H.measure('export large.md (3 MB): command → download', `${lx.ms} ms`, 'informational (no spec target)', true);
H.measure('export large.md: main-thread long tasks during export', `${lt.length} (max ${Math.max(0, ...lt.map((t) => t.dur))} ms)`, 'informational', true);
H.measure('export large.md: output size', `${(lx.html.length / 1048576).toFixed(1)} MB`, 'informational', true);
console.log('large export:', JSON.stringify({ headings: lh, srcHeadings: srcH, codes: lcodes, hljsSpans: lhl, scripts: lscripts, uniqueIds: lids.size, longTasks: lt.slice(0, 10) }));
if (lh < srcH * 0.98 || lids.size !== lh || lcodes === 0 || lhl === 0 || lscripts) H.fail('export large.md: headings/ids/code', { headings: lh, srcHeadings: srcH, uniqueIds: lids.size, codes: lcodes, hljsSpans: lhl, scripts: lscripts });
else H.pass('export large.md: all headings with unique ids, code highlighted, no scripts', `${lh} headings, ${lcodes} code blocks`);
// app still responsive after export?
const resp = await page.evaluate(async () => { const t = performance.now(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; });
H.measure('after large export: two rAFs', `${resp.toFixed(0)} ms`, '< 100 ms', resp < 100);

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
