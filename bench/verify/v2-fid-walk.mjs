// bench/verify/v2-fid-walk.mjs — verify-fidelity (0.2.0 stage 2a): block-by-block fidelity walk in Chromium.
// For every block of the given documents:
//   I1  click into it, change nothing, Esc → source byte-identical, version unchanged;
//   I2  click, type a risky string at the end (or at the start), Esc → every line outside the block's
//       range byte-identical;
//   I3  the re-rendered region shows the typed string literally (text, NBSP as space) and the block's
//       other text, links and inline structure unchanged (compared with a fresh render of source+typed
//       text is NOT used: we compare against what the session DOM showed before Esc).
// Env: MDR_PORT (default 5281); MDR_NOSERVER=1 uses an already running vite on that port (several walks in
// parallel); MDR_DOCS = comma list of paths (relative to the root; "adv" = the built-in adversarial doc;
// path:N-M = a line range); MDR_MAX = max blocks per doc; MDR_OUT = output JSON (default scratch dir).
// Global timeout MDR_TIMEOUT ms (default 900000). Writes nothing into the tree.
import { writeFileSync } from 'node:fs';
import { startServer, stopServer, openBrowser, readRoot, sleep, lineDiff } from './inline-verify-lib.mjs';

const SCRATCH = '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/v2-fid';
const OUT = process.env.MDR_OUT ?? `${SCRATCH}/walk.json`;
const MAX = Number(process.env.MDR_MAX ?? 400);
const TIMEOUT = setTimeout(() => { console.log('GLOBAL TIMEOUT'); dump(); process.exit(3); }, Number(process.env.MDR_TIMEOUT ?? 900_000));

export const ADV = [
  '# 对抗文档 Adversarial',
  '',
  '中文段落含**粗体**、*斜体*、`代码`、[链接](https://example.com/a "标题")与 $E=mc^2$ 公式。',
  '',
  'RTL: שלום עולם and مرحبا بالعالم mixed with English, combining e\u0301 and emoji 👍🏽👨‍👩‍👧 here.',
  '',
  'Entities &copy; &amp; &lt;tag&gt; &#169; &#x41; and a&nbsp;b non-breaking.',
  '',
  'Hard break with two spaces  \nsecond line\\',
  'third line after backslash break',
  '',
  'Footnote reference[^1] in text.',
  '',
  '[^1]: The footnote text.',
  '',
  'Inline <kbd>Ctrl</kbd>+<kbd>K</kbd> and <sup>sup</sup> <sub>sub</sub> <mark>mark</mark>.',
  '',
  '<div class="note">HTML block</div>',
  '',
  '> 引用一层',
  '> > 嵌套引用',
  '> > - 引用里的列表',
  '',
  '- 一级',
  '  - 二级',
  '    - 三级 **粗**',
  '      1. 四级有序',
  '- [ ] 任务 A',
  '- [x] 任务 B',
  '',
  '7. 七',
  '8. 八',
  '',
  '   ```js',
  '   const inItem = 1;',
  '   ```',
  '9. 九',
  '',
  '| 左 | 中 | 右 | 第四列很宽很宽很宽很宽 | 五 | 六 |',
  '|:---|:---:|---:|---|---|---|',
  '| `a\\|b` | **x** | [l](https://e.example) | $y$ | ~~d~~ | 6 |',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '## 标题紧跟段落',
  '段落紧贴标题。',
  '',
  '```python',
  'print("code")',
  '```',
  '',
  '---',
  '',
  'Autolinks <https://example.com/x> and bare https://bare.example.com/p?q=1 and mail <a@b.co>.',
  '',
  'Price $5 and $10, currency 5$ each, a * b, snake_case, C:\\path\\file.',
  '',
  '~~删除~~与~单~与 ~~~ 三个',
  '',
  'Line one',
  'Line two soft-wrapped',
  'Line three',
  '',
].join('\n');

/** Risky strings typed at a block's end / start (rotated). */
const END_STRINGS = [' a*b_c`d$e[f]g~h', ' <i>j&amp;k#l|m\\n', ' $x$ ~~y~~ [z](w)', ' **q** <t.x> &lt;', ' !x [^1] [ ] 5$', ' #'];
const START_STRINGS = ['1. ', '- ', '> ', '# ', '+ ', '=== ', '```', '| a |'];

const docs = (process.env.MDR_DOCS ?? 'adv').split(',').map((d) => {
  if (d === 'adv') return { name: 'adv.md', text: ADV };
  const m = /^(.*?):(\d+)-(\d+)$/.exec(d);
  if (m) return { name: `${m[1]}:${m[2]}-${m[3]}`, text: readRoot(m[1]).split('\n').slice(Number(m[2]) - 1, Number(m[3])).join('\n') + '\n' };
  return { name: d, text: readRoot(d) };
});

const out = { docs: {}, i1: [], i2: [], i3: [], refused: [], noSession: [], errors: [] };
function dump() { try { writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch { /* */ } }

if (process.env.MDR_NOSERVER === '1') process.removeListener('exit', stopServer);
else await startServer();
const B = await openBrowser();
const { page } = B;
const KIND = ['Prose', 'Heading', 'Code', 'Table', 'List', 'Quote', 'Html', 'Math', 'Hr'];
const EDITABLE = new Set([0, 1, 2, 3, 4, 5]);
const regionText = (line, count) => page.evaluate(async ({ line, count }) => {
  const pv = window.__mdr.app.preview;
  let text = '', l = line, links = [];
  while (l < line + count) {
    const b = pv.blockAtLine(l); if (!b) break;
    pv.scrollToLine(l, 0, 'instant');
    let el = null;
    for (let i = 0; i < 200; i++) { el = pv.elementOfBlock(b.id); if (el && !el.classList.contains('is-stale') && !el.classList.contains('is-pending')) break; await new Promise((r) => requestAnimationFrame(r)); }
    if (el) {
      const c = el.cloneNode(true);
      for (const m of c.querySelectorAll('.md-math')) m.replaceWith('[math:' + (m.querySelector('annotation')?.textContent ?? m.textContent) + ']');
      for (const x of c.querySelectorAll('[data-mdr-ui], .md-code__lang, .md-codewrap > :not(pre)')) x.remove();
      text += c.textContent + '\n';
      for (const a of c.querySelectorAll('a[href]')) links.push(a.getAttribute('href'));
      for (const e of c.querySelectorAll('strong, em, code, s, del, hr, h1, h2, h3, h4, h5, h6, li, blockquote, table, pre')) links.push('<' + e.tagName.toLowerCase() + '>');
    }
    l = b.startLine + Math.max(1, b.lineCount);
  }
  return { text: text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), links };
}, { line, count });
const sessionText = () => page.evaluate(() => {
  const el = document.querySelector('.mdr-preview .is-editing');
  if (!el) return null;
  const c = el.cloneNode(true);
  for (const m of c.querySelectorAll('.md-math')) m.replaceWith('[math:' + (m.querySelector('annotation')?.textContent ?? m.textContent) + ']');
  for (const x of c.querySelectorAll('[data-mdr-ui], .md-code__lang, .md-codewrap > :not(pre)')) x.remove();
  const links = [];
  for (const a of c.querySelectorAll('a[href]')) links.push(a.getAttribute('href'));
  for (const e of c.querySelectorAll('strong, em, code, s, del, hr, h1, h2, h3, h4, h5, h6, li, blockquote, table, pre')) links.push('<' + e.tagName.toLowerCase() + '>');
  return { text: c.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), links };
});
const sameMulti = (a, b) => a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001');

async function caretStart() {
  return page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, [data-mdr-ui], a') ? 2 : (n.data.trim() ? 1 : 2)) });
    const n = w.nextNode(); if (!n) return false;
    const r = document.createRange(); r.setStart(n, n.data.search(/\S/)); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  });
}

try {
  await B.boot('mode=split');
  let k = 0;
  // Stage 2b (integrator), harness repair: textPoint's mountLine uses scrollToLine, whose navigation anchor
  // re-applies the line for about 600 ms, so a point taken right after a jump can be stale (it hits the gap
  // between blocks or another block). Before U7 a press anywhere in a block started a session; now the
  // press and release must hit the clicked block. Take the point again once the anchor has expired when the
  // first one does not hit the block.
  const stablePoint = async (line, which) => {
    let p = await B.textPoint(line, which);
    const hits = (q) => page.evaluate(({ q, line }) => {
      const pv = window.__mdr.app.preview;
      const el = pv.elementOfBlock(pv.blockAtLine(line).id);
      const e = document.elementFromPoint(q.x, q.y);
      return !!(el && e && el.contains(e));
    }, { q, line });
    if (p && !(await hits(p))) { await sleep(700); p = await B.textPoint(line, which); }
    return p;
  };
  for (const d of docs) {
    await B.loadDoc(d.text, 'walk.md');
    const orig = await B.source();
    const ol = orig.split('\n');
    const blocks = (await B.blocks()).filter((b) => ol.slice(b.startLine - 1, b.startLine - 1 + b.lineCount).some((l) => l.trim() !== '')).slice(0, MAX);
    let tested = 0;
    for (const b of blocks) {
      const lines = ol.slice(b.startLine - 1, b.startLine - 1 + b.lineCount);
      const label = `${d.name}:${b.startLine} ${KIND[b.kind]} «${lines[0].slice(0, 40)}»`;
      try {
        if ((await B.source()) !== orig) await B.loadDoc(orig, 'walk.md');
        await page.evaluate(() => getSelection().removeAllRanges());
        const pt = await stablePoint(b.startLine, 'first');
        if (!pt) { out.noSession.push(`${label}: no text`); continue; }
        // I1
        const v0 = await B.version();
        await page.mouse.click(pt.x, pt.y);
        await sleep(120);
        // Stage 2b (integrator), U7: a click made while the previous write is still on its way through the
        // worker waits for it (up to ~300 ms) before the session starts; poll instead of one fixed 120 ms look.
        let e1 = await B.editing();
        for (let i = 0; !e1 && i < 10; i++) { await sleep(50); e1 = await B.editing(); }
        if (!e1) {
          const toast = await page.evaluate(() => document.querySelector('.mdr-toast, [class*="toast"]')?.textContent ?? '');
          (EDITABLE.has(b.kind) ? out.noSession : out.refused).push(`${label}${toast ? ` (toast: ${toast.trim().slice(0, 30)})` : ''}`);
          continue;
        }
        await B.esc();
        const s1 = await B.source();
        if (s1 !== orig || (await B.version()) !== v0) { out.i1.push({ block: label, diff: lineDiff(orig, s1) }); await B.loadDoc(orig, 'walk.md'); }
        // I2 + I3: type a risky string at the end or the start
        const atStart = k % 3 === 2;
        const typed = atStart ? START_STRINGS[k % START_STRINGS.length] : END_STRINGS[k % END_STRINGS.length];
        k++;
        const pt2 = await stablePoint(b.startLine, atStart ? 'first' : 'last');
        await page.mouse.click(pt2.x, pt2.y);
        await sleep(150);
        if (!(await B.editing())) { out.noSession.push(`${label} (second click)`); continue; }
        if (atStart) await caretStart(); else await B.caretEnd();
        await page.keyboard.type(typed, { delay: 15 });
        await sleep(250);
        const shown = await sessionText();
        await B.esc();
        await sleep(150);
        await page.evaluate(() => window.__mdr.waitIdle());
        const after = await B.source();
        tested++;
        const al = after.split('\n');
        const delta = al.length - ol.length;
        const before = ol.slice(0, b.startLine - 1).join('\n') === al.slice(0, b.startLine - 1).join('\n');
        const tailO = ol.slice(b.startLine - 1 + b.lineCount), tailA = al.slice(b.startLine - 1 + b.lineCount + delta);
        if (!before || tailO.join('\n') !== tailA.join('\n')) out.i2.push({ block: label, typed, diff: lineDiff(orig, after) });
        const reg = await regionText(b.startLine, b.lineCount + Math.max(0, delta));
        if (shown && (reg.text !== shown.text || !sameMulti(reg.links, shown.links))) {
          out.i3.push({ block: label, typed, atStart, sessionText: shown.text.slice(-200), renderedText: reg.text.slice(-200), sessionMarks: shown.links.join(' '), renderedMarks: reg.links.join(' '), diff: lineDiff(orig, after) });
        }
      } catch (err) {
        out.errors.push(`${label}: ${String(err.message ?? err).split('\n')[0]}`);
        await page.keyboard.press('Escape').catch(() => {});
        await B.loadDoc(orig, 'walk.md').catch(() => {});
      }
      if (tested % 10 === 0) { dump(); console.log(`${d.name}: ${tested}/${blocks.length} — I1 ${out.i1.length} I2 ${out.i2.length} I3 ${out.i3.length} err ${out.errors.length}`); }
    }
    out.docs[d.name] = { blocks: blocks.length, tested };
    console.log(`DOC ${d.name}: ${blocks.length} blocks, ${tested} typed`);
    dump();
  }
  out.pageErrors = B.pageErrors.slice(0, 5);
  out.consoleErrors = B.consoleErrors.slice(0, 5);
  console.log(`DONE I1 ${out.i1.length} I2 ${out.i2.length} I3 ${out.i3.length} refused ${out.refused.length} noSession ${out.noSession.length} errors ${out.errors.length}`);
} finally {
  dump();
  await B.browser.close().catch(() => {});
  if (process.env.MDR_NOSERVER !== '1') stopServer();
  clearTimeout(TIMEOUT);
}
