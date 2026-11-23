// bench/verify/render-extra.mjs — focused reproductions for the rendering-correctness lens:
// <details>/<div> HTML containers split across blocks (content not nested), blockquote task toggle,
// ref-def deletion propagation, math trailing-text loss, ref-def inside a fence, export offline (KaTeX CDN),
// TOC text with inline HTML, and export heading ids vs in-app slugs.
// Run: node bench/verify/render-extra.mjs   (dev server on :5202)
import { openApp, loadAndSettle, harness, sleep, renderReference, canonical, diffCanonical, previewHtml, previewState } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const H = harness('extra');
const app = await openApp();
const { page } = app;

// ---------------------------------------------------------------- 1. <details> README pattern: is the hidden content actually collapsed?
const detailsDoc = '<details>\n<summary>Show more</summary>\n\nHIDDEN-PARAGRAPH\n\n</details>\n\n<div align="center">\n\nCENTERED-PARA\n\n</div>\n';
await loadAndSettle(page, detailsDoc, 'details.md');
const det = await page.evaluate(() => {
  const body = document.querySelector('.mdr-preview__body');
  const p = Array.from(body.querySelectorAll('p')).find((x) => x.textContent.includes('HIDDEN-PARAGRAPH'));
  const c = Array.from(body.querySelectorAll('p')).find((x) => x.textContent.includes('CENTERED-PARA'));
  const details = body.querySelector('details');
  const r = p?.getBoundingClientRect();
  return {
    insideDetails: !!p && !!p.closest('details'),
    detailsOpen: details?.open ?? null,
    hiddenParaVisibleHeight: r ? r.height : null,
    insideDiv: !!c && !!c.closest('div[align="center"]'),
    centeredTextAlign: c ? getComputedStyle(c).textAlign : null,
    blocks: Array.from(body.querySelectorAll('.md-block')).map((b) => b.innerHTML.replace(/\s+/g, ' ').trim().slice(0, 120)),
  };
});
if (det.insideDetails && (det.detailsOpen === false || det.hiddenParaVisibleHeight === 0)) H.pass('details: content is nested and collapsed');
else H.fail('details: content of a closed <details> is rendered outside it and stays visible', det);
if (det.insideDiv && (det.centeredTextAlign === 'center' || det.centeredTextAlign === '-webkit-center')) H.pass('div align=center: content nested and centred');
else H.fail('div align=center: markdown between the div tags is rendered outside the div (not centred)', { insideDiv: det.insideDiv, textAlign: det.centeredTextAlign });

// ---------------------------------------------------------------- 2. task checkbox inside a blockquote
await loadAndSettle(page, '> - [ ] task in quote\n\n> 1. [x] ordered in quote\n', 'quote-task.md');
const qt = async (line, sel) => {
  const before = await page.evaluate((l) => window.__mdr.app.editor.view.state.doc.line(l).text, line);
  const box = page.locator(sel).first();
  const wasChecked = await box.isChecked();
  await box.click();
  await sleep(400);
  const after = await page.evaluate((l) => window.__mdr.app.editor.view.state.doc.line(l).text, line);
  const domChecked = await page.locator(sel).first().isChecked();
  return { before, after, wasChecked, domChecked };
};
const q1 = await qt(1, '.md-block blockquote li input[type="checkbox"]');
if (q1.after === '> - [x] task in quote') H.pass('task toggle inside blockquote');
else H.fail('task toggle inside blockquote: checkbox click does not change the source (preview checkbox and source now disagree)', q1);

// ---------------------------------------------------------------- 3. math: text after the closing $$ is dropped
const mathDoc = '$$x^2$$ TRAILING-SAME-LINE\n\n$$\na = b\n$$ TRAILING-AFTER-CLOSER\n\nend\n';
await loadAndSettle(page, mathDoc, 'math-trailing.md');
const mt = await page.evaluate(() => ({ text: document.querySelector('.mdr-preview__body').textContent, html: document.querySelector('.mdr-preview__body').innerHTML.replace(/<span class="katex[\s\S]*?<\/span><\/span><\/span>/g, '[katex]').slice(0, 800) }));
if (mt.text.includes('TRAILING-SAME-LINE')) H.pass('math: text after same-line $$ kept'); else H.fail('math: text after a same-line closing "$$" is silently dropped from the preview', { text: mt.text, html: mt.html });
if (mt.text.includes('TRAILING-AFTER-CLOSER')) H.pass('math: text after closer line kept'); else H.fail('math: text on the closing "$$" line is silently dropped from the preview', { text: mt.text });

// ---------------------------------------------------------------- 4. reference definition inside a code fence / <pre> must not define a reference
for (const [name, doc] of [
  ['ref def inside fence', '```\n[x]: https://example.com/fence\n```\n\nuse [x] here\n'],
  ['ref def inside <pre>', '<pre>\n[y]: https://example.com/pre\n</pre>\n\nuse [y] here\n'],
  ['ref def inside indented code', 'para\n\n    [z]: https://example.com/indented\n\nuse [z] here\n'],
]) {
  await loadAndSettle(page, doc, name.replace(/\W+/g, '_') + '.md');
  const d = diffCanonical(canonical(renderReference(doc)), canonical(await previewHtml(page)));
  if (d) H.fail(`refs: ${name} is treated as a definition (markdown-it: literal text)`, { fixture: doc, expected: d.expected, actual: d.actual });
  else H.pass(`refs: ${name} not treated as a definition`);
}

// ---------------------------------------------------------------- 5. deleting a definition: viewport blocks refresh? (re-check with diagnostics)
const filler = Array.from({ length: 400 }, (_, i) => `Filler paragraph ${i} with [far][fardef] usage.\n`).join('\n');
const refDoc = `# Refs\n\n${filler}\n[fardef]: https://example.org/far-v1\n`;
await loadAndSettle(page, refDoc, 'refs-del.md', { mountAll: false });
const defLine = refDoc.split('\n').findIndex((l) => l.startsWith('[fardef]:')) + 1;
// mount a middle window first so that those blocks are mounted (not pending) when the definition is deleted
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(400, 0));
await sleep(300);
await page.evaluate(() => window.__mdr.waitIdle());
const beforeDel = await page.evaluate(() => ({ mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, anchors: document.querySelectorAll('.md-block a[href^="https://example.org/far-"]').length }));
await page.evaluate((l) => { const v = window.__mdr.app.editor.view; const line = v.state.doc.line(l); v.dispatch({ changes: { from: line.from, to: line.to, insert: '' } }); }, defLine);
const tDel = Date.now();
await page.evaluate(() => window.__mdr.waitIdle());
const idleMs = Date.now() - tDel;
const samples = [];
for (let i = 0; i < 12; i++) {
  samples.push(await page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const pr = p.el.getBoundingClientRect();
    const all = Array.from(document.querySelectorAll('.md-block'));
    const vis = all.filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > pr.top && r.top < pr.bottom; });
    return {
      t: performance.now() | 0,
      scrollTop: p.el.scrollTop | 0,
      visible: vis.length,
      visPending: vis.filter((b) => b.classList.contains('is-pending')).length,
      visStale: vis.filter((b) => b.classList.contains('is-stale')).length,
      visOld: vis.filter((b) => b.querySelector('a[href^="https://example.org/far-"]')).length,
      visIds: vis.slice(0, 3).map((b) => b.dataset.id),
      totalStale: all.filter((b) => b.classList.contains('is-stale')).length,
      totalOld: document.querySelectorAll('.md-block a[href^="https://example.org/far-"]').length,
    };
  }));
  await sleep(250);
}
const last = samples[samples.length - 1];
console.log('ref deletion samples:', JSON.stringify(samples));
if (last.visOld === 0 && last.visStale === 0 && last.visible >= 3) H.pass('refs: deleting the definition refreshes the visible blocks', `idle after ${idleMs} ms; ${JSON.stringify(last)}`);
else H.fail('refs: after deleting the definition, blocks in the viewport still show the old link / stay stale', { beforeDel, idleMs, samples });
// and scrolling elsewhere afterwards: are those blocks refreshed when they come into view?
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(200, 0));
const okScroll = await page.waitForFunction(() => {
  const p = window.__mdr.app.preview;
  const pr = p.el.getBoundingClientRect();
  const vis = Array.from(document.querySelectorAll('.md-block')).filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > pr.top && r.top < pr.bottom; });
  return vis.length >= 3 && vis.every((b) => !b.classList.contains('is-pending') && !b.classList.contains('is-stale') && !b.querySelector('a[href^="https://example.org/far-"]'));
}, null, { timeout: 5000 }).then(() => true).catch(() => false);
if (okScroll) H.pass('refs: blocks scrolled into view after the deletion are refreshed');
else H.fail('refs: blocks scrolled into view after the definition deletion keep the old link / stay stale', await page.evaluate(() => ({ stale: document.querySelectorAll('.md-block.is-stale').length, old: document.querySelectorAll('.md-block a[href^="https://example.org/far-"]').length })));

// ---------------------------------------------------------------- 6. TOC text / slug for headings with inline HTML + export ids
const tocDoc = '##### A & B <b>c</b> &amp; \\# d\n\n# ![img](https://x.y/i.png) with image\n\n[l1](#a--b-c--d) [l2](#with-image)\n';
await loadAndSettle(page, tocDoc, 'toc-html.md');
const st = await previewState(page);
console.log('toc:', JSON.stringify(st.toc));
if (st.toc[0]?.text.includes('<b>') || st.toc[0]?.text.includes('&amp;')) H.fail('toc: heading text shows raw inline HTML / entities', { toc: st.toc });
else H.pass('toc: heading text has HTML stripped');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'))]);
const exportHtml = readFileSync(await dl.path(), 'utf8');
const ids = Array.from(new JSDOM(exportHtml).window.document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.id);
console.log('export ids:', ids, 'app slugs:', st.toc.map((t) => t.slug));
if (ids.every((id, i) => '#' + id === st.toc[i]?.slug)) H.pass('export: heading ids equal in-app slugs');
else H.fail('export: heading ids differ from the in-app TOC slugs (anchor links resolve differently in app vs export)', { ids, slugs: st.toc.map((t) => t.slug) });

// ---------------------------------------------------------------- 7. export opened offline: KaTeX CSS comes from a CDN
await loadAndSettle(page, '# M\n\nInline $E=mc^2$ and\n\n$$\n\\int_0^1 x\\,dx\n$$\n', 'math-export.md');
const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml'))]);
const exp2 = readFileSync(await dl2.path(), 'utf8');
const offline = await app.context.newPage();
await offline.route(/cdn\.jsdelivr\.net|fonts\./, (r) => r.abort());
await offline.setContent(exp2, { waitUntil: 'load' });
await sleep(500);
const off = await offline.evaluate(() => {
  const k = document.querySelector('.katex');
  const mathml = document.querySelector('.katex-mathml');
  const html = document.querySelector('.katex-html');
  return { katex: !!k, mathmlDisplay: mathml ? getComputedStyle(mathml).display : null, mathmlHeight: mathml?.getBoundingClientRect().height ?? null, htmlHeight: html?.getBoundingClientRect().height ?? null, visibleText: document.body.innerText.slice(0, 300), links: Array.from(document.querySelectorAll('link[href]')).map((l) => l.href) };
});
await offline.close();
console.log('offline export:', JSON.stringify(off));
if (off.links.length === 0) H.pass('export: no external stylesheet');
else H.fail('export: exported HTML links a CDN stylesheet; opened offline the KaTeX HTML and MathML render unstyled/duplicated', { links: off.links, mathmlDisplay: off.mathmlDisplay, mathmlHeight: off.mathmlHeight, htmlHeight: off.htmlHeight, visibleText: off.visibleText });

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
const realErrors = app.consoleErrors.filter((e) => !/Failed to load resource|net::ERR_FAILED/.test(e));
if (realErrors.length) H.fail('console errors', { errors: realErrors.slice(0, 5) }); else H.pass('no console errors');
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
