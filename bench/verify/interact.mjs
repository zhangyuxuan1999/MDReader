// bench/verify/interact.mjs — task checkbox round-trip, reference-definition edits propagating to links, export HTML.
// Run: node bench/verify/interact.mjs
import { openApp, loadAndSettle, harness, sleep } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const H = harness('interact');
const app = await openApp();
const { page } = app;

const lineText = (l) => page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, l);

// ---------------------------------------------------------------- 1. task list toggle round-trip
const taskDoc = [
  '# Tasks',
  '',
  '- [ ] top unchecked',        // 3
  '- [x] top checked',          // 4
  '  - [ ] nested unchecked',   // 5
  '',
  '1. [ ] ordered task',        // 7
  '',
  '> - [ ] task in quote',      // 9
  '',
  '- [ ] loose one',            // 11
  '',
  '- [x] loose two',            // 13
  '',
  '* [ ] star task',            // 15
  '+ [ ] plus task',            // 16
  '',
  '- [ ] **bold** task with `code` and [link](https://x.y)', // 18
  '',
].join('\n');
await loadAndSettle(page, taskDoc, 'tasks.md');

async function clickBox(line, expectAfter) {
  const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), line);
  const sel = `.md-block[data-id="${b.id}"] li[data-l="${line - b.startLine}"] > input[type="checkbox"], .md-block[data-id="${b.id}"] li[data-l="${line - b.startLine}"] > p > input[type="checkbox"]`;
  const before = await lineText(line);
  const box = page.locator(sel).first();
  const count = await page.locator(sel).count();
  if (count === 0) return { ok: false, reason: `no checkbox for line ${line} (selector ${sel})`, before };
  const wasChecked = await box.isChecked();
  await box.click();
  let after;
  try {
    await page.waitForFunction(({ l, e }) => window.__mdr.app.editor.view.state.doc.line(l).text === e, { l: line, e: expectAfter }, { timeout: 1500 });
    after = await lineText(line);
  } catch {
    after = await lineText(line);
    return { ok: false, reason: 'source line not toggled as expected', before, after, expected: expectAfter };
  }
  // the re-rendered block must show the box in the new state, same wrapper element
  try {
    await page.waitForFunction(({ s, w }) => { const i = document.querySelector(s); return !!i && i.checked === !w && !i.closest('.md-block').classList.contains('is-stale'); }, { s: sel, w: wasChecked }, { timeout: 1500 });
  } catch {
    const checked = await page.locator(sel).first().isChecked().catch(() => 'gone');
    return { ok: false, reason: 'preview checkbox did not reflect the toggled source', before, after, previewChecked: checked };
  }
  return { ok: true, before, after };
}

const toggles = [
  [3, '- [x] top unchecked'],
  [4, '- [ ] top checked'],
  [5, '  - [x] nested unchecked'],
  [7, '1. [x] ordered task'],
  [9, '> - [x] task in quote'],
  [11, '- [x] loose one'],
  [13, '- [ ] loose two'],
  [15, '* [x] star task'],
  [16, '+ [x] plus task'],
  [18, '- [x] **bold** task with `code` and [link](https://x.y)'],
];
for (const [line, expected] of toggles) {
  const r = await clickBox(line, expected);
  if (!r.ok) H.fail(`task toggle: line ${line}`, r);
  else H.pass(`task toggle: line ${line}`, `${r.before.trim()} → ${r.after.trim()}`);
}
// round trip: toggle back
const rt = await clickBox(3, '- [ ] top unchecked');
if (!rt.ok) H.fail('task toggle: round trip back to unchecked', rt); else H.pass('task toggle: round trip back to unchecked');
// undo restores checkbox
await page.evaluate(() => window.__mdr.app.editor.focus());
await page.keyboard.press('Meta+z');
await sleep(300);
const undone = await lineText(3);
if (undone !== '- [x] top unchecked') H.fail('task toggle: undo restores previous state', { got: undone });
else H.pass('task toggle: undo restores previous state');

// ---------------------------------------------------------------- 2. reference definitions
// definition far away (end of a long doc), definition added later, edits propagating (viewport + far away)
const filler = Array.from({ length: 400 }, (_, i) => `Filler paragraph ${i} with [far][fardef] usage.\n`).join('\n');
const refDoc = `# Refs\n\nTop uses [far][fardef] and [later][laterdef] and [Case][CaseDef].\n\n${filler}\n[fardef]: https://example.org/far-v1\n[casedef]: https://example.org/case\n`;
await loadAndSettle(page, refDoc, 'refs.md', { mountAll: false });
await sleep(300);
const topSel = () => Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).find((b) => b.textContent.includes('Top uses'));
const top = await page.evaluate((f) => {
  const b = (0, eval)(f)();
  return { html: b?.innerHTML ?? '', far: b?.querySelector('a[href="https://example.org/far-v1"]')?.textContent ?? null, later: b?.querySelector('a[href*="later"]')?.getAttribute('href') ?? null, caseA: b?.querySelector('a[href="https://example.org/case"]')?.textContent ?? null };
}, `(${topSel.toString()})`);
if (top.far !== 'far') H.fail('refs: definition 800 lines away resolves', { top });
else H.pass('refs: definition far away resolves');
if (top.caseA !== 'Case') H.fail('refs: case-insensitive label match', { top });
else H.pass('refs: case-insensitive label match');
if (top.later !== null) H.fail('refs: undefined ref must render as text', { top });
else H.pass('refs: undefined ref renders as text');

// edit the far definition → top link (in viewport) must update
const defLine = refDoc.split('\n').findIndex((l) => l.startsWith('[fardef]:')) + 1;
await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 10_000), defLine);
await page.keyboard.press('Backspace');
await page.keyboard.type('2');
const t0 = Date.now();
const upd = await page.waitForFunction(() => !!document.querySelector('.md-block a[href="https://example.org/far-v2"]'), null, { timeout: 3000 }).then(() => true).catch(() => false);
if (!upd) H.fail('refs: editing the definition updates a link in the viewport', { defLine, line: await lineText(defLine) });
else { H.pass('refs: editing the definition updates a link in the viewport', `${Date.now() - t0} ms`); H.measure('ref-def edit → viewport link updated', `${Date.now() - t0} ms`, '< 1000 ms (eventually)', Date.now() - t0 < 1000); }

// the editor is now at the bottom; blocks in the middle are far from both. Scroll preview to the middle and verify they use v2
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(400, 0));
await sleep(200);
await page.evaluate(() => window.__mdr.waitIdle());
const mid = await page.waitForFunction(() => {
  const els = Array.from(document.querySelectorAll('.md-block:not(.is-pending) a[href^="https://example.org/far-"]'));
  const hrefs = new Set(els.map((a) => a.getAttribute('href')));
  return els.length > 5 && hrefs.size === 1 && hrefs.has('https://example.org/far-v2') ? true : (els.length > 5 ? Array.from(hrefs) : null);
}, null, { timeout: 4000 }).then((h) => h.jsonValue()).catch(() => 'timeout');
if (mid !== true) H.fail('refs: blocks scrolled into view later use the new definition', { got: mid });
else H.pass('refs: blocks scrolled into view later use the new definition');

// scroll back to top and check every mounted block (mountAll) uses v2
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await page.evaluate(() => window.__mdr.waitIdle());
await page.waitForFunction(() => document.querySelectorAll('.md-block.is-pending, .md-block.is-stale').length === 0, null, { timeout: 20_000 });
const all = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('.md-block a[href^="https://example.org/far-"]'));
  const hrefs = {};
  for (const a of els) hrefs[a.getAttribute('href')] = (hrefs[a.getAttribute('href')] || 0) + 1;
  return { total: els.length, hrefs, unresolved: Array.from(document.querySelectorAll('.md-block p')).filter((p) => p.textContent.includes('[far]')).length };
});
if (all.hrefs['https://example.org/far-v1'] || all.unresolved || all.total !== 401) H.fail('refs: all blocks after mountAll use the new definition', all);
else H.pass('refs: all blocks after mountAll use the new definition', JSON.stringify(all.hrefs));

// add a definition later (at the very end) → [later][laterdef] at the top must resolve
await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 10_000); });
await page.keyboard.type('\n[laterdef]: https://example.org/later\n');
await page.evaluate(() => window.__mdr.waitIdle());
// the top block is ~900 lines away from the editor cursor: scroll the preview back to it and wait for its refresh
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0));
const tLater = Date.now();
const laterOk = await page.waitForFunction(() => {
  const b = Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).find((x) => x.textContent.includes('Top uses'));
  return !!b && !b.classList.contains('is-stale') && !!b.querySelector('a[href="https://example.org/later"]');
}, null, { timeout: 5000 }).then(() => true).catch(() => false);
const topState = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.md-block')).find((x) => x.textContent.includes('Top uses')); return b ? { stale: b.classList.contains('is-stale'), pending: b.classList.contains('is-pending'), html: b.innerHTML.slice(0, 400) } : 'no top block in DOM'; });
if (!laterOk) H.fail('refs: definition added later resolves an earlier link (after scrolling it into view)', { topState, tail: await page.evaluate(() => window.__mdr.app.getText().slice(-120)) });
else H.pass('refs: definition added later resolves an earlier link (after scrolling it into view)', `${Date.now() - tLater} ms after scroll`);

// delete the definition → link must revert to plain text
await page.evaluate((l) => { const v = window.__mdr.app.editor.view; const line = v.state.doc.line(l); v.dispatch({ changes: { from: line.from, to: line.to, insert: '' } }); }, defLine);
await page.evaluate(() => window.__mdr.waitIdle());
// mounted blocks far from the viewport may stay stale (SPEC 4.3.7 lazily); blocks in the viewport must refresh. Scroll to the middle.
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(400, 0));
const tDel = Date.now();
const gone = await page.waitForFunction(() => {
  const p = window.__mdr.app.preview;
  const vis = Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).filter((b) => { const r = b.getBoundingClientRect(); const pr = p.el.getBoundingClientRect(); return r.bottom > pr.top && r.top < pr.bottom; });
  if (vis.length < 3) return false;
  return vis.every((b) => !b.classList.contains('is-stale') && !b.querySelector('a[href^="https://example.org/far-"]') && b.textContent.includes('[far][fardef]'));
}, null, { timeout: 5000 }).then(() => true).catch(() => false);
const delState = await page.evaluate(() => {
  const p = window.__mdr.app.preview;
  const pr = p.el.getBoundingClientRect();
  const vis = Array.from(document.querySelectorAll('.md-block:not(.is-pending)')).filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > pr.top && r.top < pr.bottom; });
  return { visible: vis.length, visibleStale: vis.filter((b) => b.classList.contains('is-stale')).length, visibleWithOldAnchor: vis.filter((b) => b.querySelector('a[href^="https://example.org/far-"]')).length, totalStale: document.querySelectorAll('.md-block.is-stale').length, totalOldAnchors: document.querySelectorAll('.md-block a[href^="https://example.org/far-"]').length, sample: vis[0]?.innerHTML.slice(0, 200) };
});
if (!gone) H.fail('refs: deleting the definition reverts links in the viewport to text (mounted stale blocks scrolled into view)', delState);
else H.pass('refs: deleting the definition reverts links in the viewport to text', `${Date.now() - tDel} ms; ${JSON.stringify(delState)}`);
// and after a mountAll everything must be consistent
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await page.evaluate(() => window.__mdr.waitIdle());
await page.waitForFunction(() => document.querySelectorAll('.md-block.is-pending, .md-block.is-stale').length === 0, null, { timeout: 20_000 }).catch(() => {});
const finalState = await page.evaluate(() => ({ stale: document.querySelectorAll('.md-block.is-stale').length, oldAnchors: document.querySelectorAll('.md-block a[href^="https://example.org/far-"]').length }));
if (finalState.stale || finalState.oldAnchors) H.fail('refs: after mountAll no block still uses the deleted definition', finalState);
else H.pass('refs: after mountAll no block still uses the deleted definition');

// ---------------------------------------------------------------- 3. export HTML
const exportDoc = [
  '# Export Title',
  '',
  'Intro with [ref][r] and $x^2$ math and `inline`.',
  '',
  '## Section A',
  '',
  '```ts',
  'const n: number = 42;',
  '```',
  '',
  '```py',
  'def f(): return 1',
  '```',
  '',
  '```',
  'no lang',
  '```',
  '',
  '## Section A',
  '',
  '### 中文 节',
  '',
  '- [ ] task',
  '- [x] done',
  '',
  '| a | b |',
  '|:--|--:|',
  '| 1 | 2 |',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '<script>window.__exported_xss = 1</script>',
  '',
  '<img src=x onerror="window.__exported_xss2=1">',
  '',
  '[r]: https://example.org/r',
  '',
].join('\n');
await loadAndSettle(page, exportDoc, 'export-me.md');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15_000 }),
  page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml')),
]);
const path = await download.path();
const html = readFileSync(path, 'utf8');
const dom = new JSDOM(html);
const d = dom.window.document;
const hs = Array.from(d.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({ tag: h.tagName, id: h.id, text: h.textContent.trim() }));
const problems = [];
if (!/^<!doctype html>/i.test(html)) problems.push('no doctype');
if (!d.querySelector('style')) problems.push('no embedded <style>');
if (!d.querySelector('meta[charset]')) problems.push('no charset');
const expectedHs = [['H1', 'export-title'], ['H2', 'section-a'], ['H2', 'section-a-1'], ['H3', '中文-节']];
if (hs.length !== 4 || expectedHs.some(([t, id], i) => hs[i]?.tag !== t || hs[i]?.id !== id)) problems.push(`headings/ids: ${JSON.stringify(hs)}`);
const codes = Array.from(d.querySelectorAll('pre code'));
if (codes.length !== 3) problems.push(`expected 3 code blocks, got ${codes.length}`);
if (!codes[0] || !codes[0].querySelector('[class*="hljs-"]')) problems.push('ts code not highlighted');
if (!codes[1] || !codes[1].querySelector('[class*="hljs-"]')) problems.push('py code not highlighted');
if (!d.querySelector('a[href="https://example.org/r"]')) problems.push('reference link unresolved');
if (!d.querySelector('.katex')) problems.push('math not rendered');
if (!d.querySelector('input[type="checkbox"]')) problems.push('task checkbox missing');
if (!d.querySelector('table')) problems.push('table missing');
const externalRefs = Array.from(d.querySelectorAll('link[href], script[src]')).map((e) => e.getAttribute('href') || e.getAttribute('src'));
const inlineScripts = Array.from(d.querySelectorAll('script:not([src])')).map((s) => s.textContent.slice(0, 60));
const onAttrs = Array.from(d.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).filter((a) => /^on/i.test(a.name)).map((a) => `${e.tagName}[${a.name}]`));
console.log('export: external refs', externalRefs, 'inline scripts', inlineScripts, 'on* attrs', onAttrs, 'size', html.length, 'name', download.suggestedFilename());
if (problems.length) H.fail('export: standalone document content', { problems, headings: hs });
else H.pass('export: standalone document has all headings (deduped ids), highlighted code, refs, math, tasks, table', `${html.length} bytes`);
if (externalRefs.length) H.fail('export: document is not standalone (external resources)', { externalRefs });
else H.pass('export: no external resources');
if (inlineScripts.length || onAttrs.length) H.fail('export: unsanitised script / event handlers from the source are written into the exported file', { inlineScripts, onAttrs });
else H.pass('export: no script / on* attributes');
if (download.suggestedFilename() !== 'export-me.html') H.fail('export: file name', { got: download.suggestedFilename() }); else H.pass('export: file name export-me.html');

// export of an empty and a CRLF doc must not throw
await loadAndSettle(page, '', 'empty.md');
const emptyExport = await Promise.all([
  page.waitForEvent('download', { timeout: 10_000 }).then(async (dl) => readFileSync(await dl.path(), 'utf8')).catch((e) => 'ERR ' + e.message),
  page.evaluate(() => window.__mdr.app.registry.run('file.exportHtml')),
]);
if (typeof emptyExport[0] !== 'string' || emptyExport[0].startsWith('ERR')) H.fail('export: empty document', { got: emptyExport[0] }); else H.pass('export: empty document exports');

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
if (app.consoleErrors.length) H.fail('console errors', { errors: app.consoleErrors.slice(0, 5) }); else H.pass('no console errors');
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
