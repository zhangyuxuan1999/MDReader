// bench/verify/testdata-compare.mjs — whole test-data documents (small.md, medium.md, optionally large.md)
// rendered by the app (mountAll) vs markdown-it rendering the whole file; plus a data-l line-mapping audit
// (every [data-l] element must point at a source line that matches its element type) and a TOC audit.
// Run: node bench/verify/testdata-compare.mjs [--large]   (dev server on :5202)
import { openApp2, loadSettled, blocksHtml, structure, renderReference, canonical, diffCanonical, harness, finish, tocItems, statusStats, independentStats, sleep, BASE } from './lib2.mjs';

const H = harness('testdata');
const app = await openApp2();
const { page } = app;
const files = ['small.md', 'medium.md'];
if (process.argv.includes('--large')) files.push('large.md');

const ATX = /^ {0,3}#{1,6}(\s|$)/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const HR = /^ {0,3}(\*\s*){3,}$|^ {0,3}(-\s*){3,}$|^ {0,3}(_\s*){3,}$/;

for (const f of files) {
  const text = await (await fetch(`${BASE}/test-data/${f}`)).text();
  const t0 = Date.now();
  await loadSettled(page, text, f, { timeout: 180_000 });
  const ms = Date.now() - t0;
  H.measure(`${f}: load → idle → all mounted`, `${ms} ms`, 'informational', true);
  const html = await blocksHtml(page);
  const refHtml = renderReference(text);
  if (f === 'large.md') {
    // 17 MB of HTML: JSDOM canonicalisation OOMs node, so compare element counts by tag instead
    const count = (h) => { const c = {}; for (const m of h.matchAll(/<(h[1-6]|p|ul|ol|li|table|tr|td|th|pre|code|blockquote|hr|a|strong|em|del|img|input|span class="md-math|div class="md-math)[\s>]/g)) c[m[1]] = (c[m[1]] || 0) + 1; return c; };
    const e = count(refHtml), a = count(html);
    const diff = Object.keys({ ...e, ...a }).filter((k) => e[k] !== a[k]).map((k) => `${k}: expected ${e[k] ?? 0}, preview ${a[k] ?? 0}`);
    if (diff.length) H.fail(`${f}: element counts differ from markdown-it`, { diff });
    else H.pass(`${f}: element counts equal markdown-it`, JSON.stringify(a));
  } else {
  const expected = canonical(refHtml);
  const actual = canonical(html);
  // collect ALL differences (resync by skipping) — count them, show the first 3
  const diffs = [];
  let i = 0, j = 0;
  while ((i < expected.length || j < actual.length) && diffs.length < 200) {
    if (expected[i] === actual[j]) { i++; j++; continue; }
    diffs.push({ at: i, expected: expected.slice(Math.max(0, i - 2), i + 4).join('\n'), actual: actual.slice(Math.max(0, j - 2), j + 4).join('\n') });
    // resync: find next common line within 40
    let found = false;
    for (let k = 1; k < 40 && !found; k++) {
      for (let a = 0; a <= k; a++) { const b = k - a; if (expected[i + a] !== undefined && expected[i + a] === actual[j + b]) { i += a; j += b; found = true; break; } }
    }
    if (!found) { i++; j++; }
  }
  if (diffs.length) H.fail(`${f}: preview ≠ markdown-it (${diffs.length}${diffs.length >= 200 ? '+' : ''} differences)`, { first: diffs.slice(0, 3), expectedLines: expected.length, actualLines: actual.length });
  else H.pass(`${f}: preview == markdown-it`, `${actual.length} canonical lines`);
  }

  // structure tiling + data-l audit
  const st = await structure(page);
  if (st.problems.length) H.fail(`${f}: structure tiling`, st.problems);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const audit = await page.evaluate(() => {
    const out = [];
    for (const w of document.querySelectorAll('.md-block')) {
      const id = Number(w.dataset.id);
      for (const el of w.querySelectorAll('[data-l]')) {
        out.push({ id, tag: el.tagName.toLowerCase(), l: Number(el.dataset.l), inQuote: !!el.closest('blockquote'), inLi: !!el.parentElement?.closest('li'), text: (el.textContent || '').trim().slice(0, 40) });
      }
    }
    return out;
  });
  const bad = [];
  for (const e of audit) {
    const b = st.byId[e.id];
    if (!b) { bad.push({ ...e, why: 'unknown block id' }); continue; }
    const line = b.startLine + e.l;
    let src = lines[line - 1];
    if (src === undefined) { bad.push({ ...e, line, why: 'line beyond doc' }); continue; }
    if (e.l < 0 || e.l >= b.lineCount) { bad.push({ ...e, line, why: `data-l ${e.l} outside block (${b.lineCount} lines)` }); continue; }
    // strip quote markers / list markers for nested content
    let s = src.replace(/^( {0,3}>\s?)+/, '');
    let ok = true;
    switch (e.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': ok = ATX.test(s) || (/\S/.test(s) && /^ {0,3}(=+|-+)\s*$/.test((lines[line] ?? '').replace(/^( {0,3}>\s?)+/, ''))); break;
      case 'li': ok = LIST.test(s) || LIST.test(s.replace(/^\s+/, '')); break;
      case 'p': ok = /\S/.test(s); break;
      case 'pre': ok = /^ {0,3}(`{3,}|~{3,})/.test(s.replace(/^\s+/, '')) || /^( {4}|\t)/.test(src) || /^\s+/.test(src); break;
      case 'table': ok = s.includes('|'); break;
      case 'blockquote': ok = /^ {0,3}>/.test(src.replace(/^(\s*[-*+]\s+|\s*\d+[.)]\s+)/, '')) || /^ {0,3}>/.test(src); break;
      case 'hr': ok = HR.test(s.replace(/^\s+/, '')); break;
      case 'div': ok = /\S/.test(s); break;
      default: ok = /\S/.test(s);
    }
    if (!ok) bad.push({ ...e, line, src: src.slice(0, 60), why: 'source line does not match element' });
  }
  H.measure(`${f}: [data-l] elements audited`, `${audit.length} (bad ${bad.length})`, '0 bad', bad.length === 0);
  if (bad.length) H.fail(`${f}: data-l → source line mapping wrong for ${bad.length} elements (click-to-source / checkbox toggle land on the wrong line)`, { sample: bad.slice(0, 8) });
  else H.pass(`${f}: every [data-l] element maps to a matching source line`, `${audit.length} elements`);

  // TOC audit: level/text/line vs source
  const toc = await tocItems(page);
  const srcHeads = [];
  for (let k = 0; k < lines.length; k++) {
    // only top-level ATX outside fences (rough: the fixture generator uses ``` fences)
    if (ATX.test(lines[k])) srcHeads.push({ level: lines[k].match(/^ {0,3}(#{1,6})/)[1].length, text: lines[k].replace(/^ {0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim(), line: k + 1 });
  }
  // remove those inside fences
  let inFence = false; const fenceLines = new Set();
  for (let k = 0; k < lines.length; k++) { if (/^ {0,3}(`{3,}|~{3,})/.test(lines[k])) { inFence = !inFence; continue; } if (inFence) fenceLines.add(k + 1); }
  const srcTop = srcHeads.filter((h) => !fenceLines.has(h.line));
  const tocMismatch = [];
  const byLine = new Map(toc.map((t) => [t.line, t]));
  for (const h of srcTop) { const t = byLine.get(h.line); if (!t) tocMismatch.push({ ...h, why: 'missing from TOC' }); else if (t.level !== h.level || t.text !== h.text.replace(/[*_`~]/g, '')) tocMismatch.push({ src: h, toc: t }); }
  const extra = toc.filter((t) => !srcTop.some((h) => h.line === t.line));
  H.measure(`${f}: TOC entries`, `${toc.length} (source ATX headings ${srcTop.length})`, 'equal', toc.length === srcTop.length);
  if (tocMismatch.length || extra.length) H.fail(`${f}: TOC differs from the source headings`, { mismatch: tocMismatch.slice(0, 5), extra: extra.slice(0, 5) });
  else H.pass(`${f}: TOC equals the source ATX headings (level, text, line)`);

  // stats
  const exp = independentStats(text.replace(/\r\n?/g, '\n'));
  const got = await statusStats(page);
  if (got.words !== exp.words || got.chars !== exp.chars || got.reading !== exp.readingMinutes) H.fail(`${f}: status-bar stats`, { got, exp });
  else H.pass(`${f}: status-bar stats equal independent counts`, JSON.stringify(got));
}

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
