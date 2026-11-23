// bench/verify/incremental.mjs — rendering correctness AFTER EDITS: each scenario edits the document through
// the editor (dispatch / keyboard), waits for the worker to settle on that version, mounts everything and
// compares the preview with markdown-it rendering the resulting text; also checks tiling, TOC and stats.
// Run: node bench/verify/incremental.mjs   (dev server on :5202)
import { openApp2, loadSettled, mountAllSettled, settle, assertEqualsReference, harness, finish, tocItems, statusStats, independentStats, sleep } from './lib2.mjs';

const H = harness('incremental');
const app = await openApp2();
const { page } = app;

const base = [
  '# Title',                       // 1
  '',
  'Intro paragraph with [ref][r1] and [later][r2].',   // 3
  '',
  '- item one',                    // 5
  '- item two',                    // 6
  '  continuation',                // 7
  '- item three',                  // 8
  '',
  'Para A line 1',                 // 10
  'Para A line 2',                 // 11
  '',
  'Para B',                        // 13
  '',
  '```ts',                         // 15
  'const a: number = 1;',          // 16
  'function f() {}',               // 17
  '```',                           // 18
  '',
  'col1 | col2',                   // 20
  '',
  'Setext candidate',              // 22
  '',
  '> quote line',                  // 24
  '',
  'Para C',                        // 26
  '',
  'Para D',                        // 28
  '',
  'Para E',                        // 30
  '',
  '## Section',                    // 32
  '',
  'Tail paragraph.',               // 34
  '',
  '[r1]: https://example.com/r1',  // 36
  '',
].join('\n');

const lineRange = (l) => page.evaluate((n) => { const ln = window.__mdr.app.editor.view.state.doc.line(n); return { from: ln.from, to: ln.to, text: ln.text }; }, l);
const dispatch = (changes) => page.evaluate((c) => { window.__mdr.app.editor.view.dispatch({ changes: c }); }, changes);
const insertAt = async (line, col, text) => { const r = await lineRange(line); await dispatch({ from: r.from + col, insert: text }); };
const replaceLine = async (line, text) => { const r = await lineRange(line); await dispatch({ from: r.from, to: r.to, insert: text }); };
const deleteLine = async (line) => { const r = await lineRange(line); const eol = await page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).to + 1, line); await dispatch({ from: r.from, to: Math.min(eol, await page.evaluate(() => window.__mdr.app.editor.view.state.doc.length)) }); };
const insertLineAfter = async (line, text) => { const r = await lineRange(line); await dispatch({ from: r.to, insert: '\n' + text }); };
const getText = () => page.evaluate(() => window.__mdr.app.getText());

async function check(label) {
  const s = await settle(page, 30_000);
  if (!s.ok) { H.fail(`${label}: worker did not settle`, s); return; }
  await mountAllSettled(page, 30_000);
  await assertEqualsReference(page, H, label);
  // stats consistency
  const text = await getText();
  const exp = independentStats(text);
  const got = await statusStats(page);
  if (got.words !== exp.words || got.chars !== exp.chars || got.reading !== exp.readingMinutes) H.fail(`${label}: status-bar stats drift after edit`, { got, exp });
  // TOC vs rendered headings (top level)
  const toc = await tocItems(page);
  const rendered = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block :is(h1,h2,h3,h4,h5,h6)')).filter((h) => !h.closest('li') && !h.closest('blockquote')).map((h) => ({ level: Number(h.tagName[1]), text: h.textContent.trim() })));
  const tocKey = toc.map((t) => `${t.level}:${t.text}`).join('|');
  const renKey = rendered.map((t) => `${t.level}:${t.text}`).join('|');
  if (tocKey !== renKey) H.fail(`${label}: TOC differs from rendered headings after edit`, { toc: tocKey, rendered: renKey });
  // TOC line numbers must point at heading lines
  const lines = text.split('\n');
  const badLines = toc.filter((t) => !/^ {0,3}#{1,6}(\s|$)/.test(lines[t.line - 1] ?? '') && !/^ {0,3}(=+|-+)\s*$/.test(lines[t.line] ?? ''));
  if (badLines.length) H.fail(`${label}: TOC entries point at non-heading lines`, { badLines: badLines.map((t) => ({ ...t, src: lines[t.line - 1] })) });
}

await loadSettled(page, base, 'inc.md');
await assertEqualsReference(page, H, 'base');

const scenarios = [
  ['type "# " at start of list continuation line (heading inside list)', async () => insertAt(7, 2, '# ')],
  ['insert blank line between list items (must stay one list)', async () => insertLineAfter(5, '')],
  ['delete blank line between Para A and Para B (merge)', async () => deleteLine(12)],
  ['open an unclosed fence above Para C', async () => insertLineAfter(25, '```js')],
  ['close that fence after Para D', async () => insertLineAfter(29, '```')],
  ['type a table delimiter under "col1 | col2"', async () => insertLineAfter(20, '---|---')],
  ['add a table row after the delimiter', async () => insertLineAfter(21, 'x | y')],
  ['type "===" under Setext candidate', async () => insertLineAfter(24, '===')],
  ['define [r2] at the end (later definition)', async () => { const n = await page.evaluate(() => window.__mdr.app.editor.lineCount()); await insertLineAfter(n, '[r2]: https://example.com/r2 "Later"'); }],
  ['change [r1] definition url', async () => { const t = await getText(); const l = t.split('\n').findIndex((x) => x.startsWith('[r1]:')) + 1; await replaceLine(l, '[r1]: https://example.com/r1-changed'); }],
  ['rename the [r1] label so the link becomes undefined', async () => { const t = await getText(); const l = t.split('\n').findIndex((x) => x.startsWith('[r1]:')) + 1; await replaceLine(l, '[r1x]: https://example.com/r1-changed'); }],
  ['wrap Para C..E in <div> ... </div> (README pattern)', async () => { const t = await getText(); const ls = t.split('\n'); const c = ls.indexOf('Para C') + 1; const e = ls.indexOf('Para E') + 1; await insertLineAfter(e, '\n</div>'); await insertLineAfter(c - 2, '<div align="center">\n'); }],
  ['remove the opening <div> again', async () => { const t = await getText(); const l = t.split('\n').indexOf('<div align="center">') + 1; await deleteLine(l); }],
  ['open $$ above Tail paragraph', async () => { const t = await getText(); const l = t.split('\n').indexOf('Tail paragraph.') + 1; await insertLineAfter(l - 2, '$$'); }],
  ['close $$ after Tail paragraph', async () => { const t = await getText(); const l = t.split('\n').indexOf('Tail paragraph.') + 1; await insertLineAfter(l, '$$'); }],
  ['convert "- item three" to "1. item three" (kind change, new list)', async () => { const t = await getText(); const l = t.split('\n').indexOf('- item three') + 1; await replaceLine(l, '1. item three'); }],
  ['type inside the ts fence', async () => insertAt(16, 6, 'bb: string = "s", ')],
  ['delete the closing fence of the ts block', async () => { const t = await getText(); const ls = t.split('\n'); const i = ls.indexOf('function f() {}'); await deleteLine(i + 2); }],
  ['restore the closing fence', async () => { const t = await getText(); const ls = t.split('\n'); const i = ls.indexOf('function f() {}'); await insertLineAfter(i + 1, '```'); }],
  ['paste a multi-block chunk in the middle', async () => insertLineAfter(13, '\n## Pasted\n\n- p1\n- p2\n\n| q | r |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\n\n> pq\n')],
  ['keyboard: type a new heading with Enter continuation', async () => { await page.evaluate(() => window.__mdr.app.editor.gotoLine(2, 0)); await page.keyboard.type('#### Typed heading'); await page.keyboard.press('Enter'); await page.keyboard.type('- typed item'); await page.keyboard.press('Enter'); await page.keyboard.type('second typed item'); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); }],
  ['select all + retype small doc', async () => { await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '# New\n\nfresh **doc**\n\n- [ ] t\n' } }); }); }],
  ['undo ×3', async () => { await page.evaluate(() => window.__mdr.app.editor.focus()); for (let i = 0; i < 3; i++) await page.keyboard.press('Meta+z'); }],
  ['redo ×2', async () => { for (let i = 0; i < 2; i++) await page.keyboard.press('Meta+Shift+z'); }],
  ['undo everything', async () => { for (let i = 0; i < 60; i++) await page.keyboard.press('Meta+z'); }],
];

for (const [name, edit] of scenarios) {
  try {
    await edit();
    await check(`edit: ${name}`);
  } catch (err) {
    H.fail(`edit: ${name} (exception)`, { error: String(err).slice(0, 600) });
  }
}
const finalText = await getText();
if (finalText !== base) H.fail('undo everything: text differs from the original', { head: finalText.slice(0, 200) });
else H.pass('undo everything: text equals the original');

// ---------------------------------------------------------------- isolated: heading block directly followed by a list whose item holds an indented heading
for (const [name, text, edit] of [
  ['heading then list with indented heading (no blank line)', '### Mid list\n- item two\n  # continuation\n- item three\n', null],
  ['paragraph then list with indented heading (no blank line)', 'text\n- item two\n  # continuation\n- item three\n', null],
  ['list with indented heading, then insert a heading line above the list', '- item one\n\n- item two\n  # continuation\n- item three\n', async () => insertLineAfter(1, '\n### Mid list')],
]) {
  await loadSettled(page, text, 'iso.md');
  if (edit) await edit();
  await check(`isolated: ${name}`);
}

// ---------------------------------------------------------------- typing burst inside a heading: TOC text follows each keystroke, preview equals reference at the end
await loadSettled(page, '# Heading\n\ntext\n\n## Sub\n', 'toc-typing.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.editor.gotoLine(1, 9));
await page.keyboard.type(' Extended Title 中文', { delay: 15 });
await page.waitForFunction(() => document.querySelector('.mdr-toc__item')?.textContent === 'Heading Extended Title 中文', null, { timeout: 3000 }).catch(() => {});
const tt = await tocItems(page);
if (tt[0]?.text !== 'Heading Extended Title 中文') H.fail('toc: text after a typing burst in the heading', { toc: tt });
else H.pass('toc: text follows a typing burst in a heading');
await check('typing burst in heading');

// ---------------------------------------------------------------- reference definition edit while the using block is NOT mounted (far away), then scroll to it
const filler = Array.from({ length: 300 }, (_, i) => `Filler ${i}.\n`).join('\n');
await loadSettled(page, `Top [x][xd] link.\n\n${filler}\n[xd]: https://example.com/x1\n`, 'ref-far.md', { mountAll: false });
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(600, 0));
await sleep(300);
await settle(page);
const topPending = await page.evaluate(() => document.querySelector('.md-block')?.classList.contains('is-pending'));
const n = await page.evaluate(() => window.__mdr.app.editor.lineCount());
await replaceLine(n - 1, '[xd]: https://example.com/x2');
await settle(page);
await page.evaluate(() => window.__mdr.app.preview.scrollToLine(1, 0));
const ok = await page.waitForFunction(() => { const b = document.querySelector('.md-block'); return !!b && !b.classList.contains('is-pending') && !b.classList.contains('is-stale') && !!b.querySelector('a[href="https://example.com/x2"]'); }, null, { timeout: 5000 }).then(() => true).catch(() => false);
if (!ok) H.fail('refs: unmounted (evicted/pending) block uses the new definition when scrolled into view', { topPending, html: await page.evaluate(() => document.querySelector('.md-block')?.innerHTML) });
else H.pass('refs: unmounted block uses the new definition when scrolled into view', `top block was pending before the edit: ${topPending}`);

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
