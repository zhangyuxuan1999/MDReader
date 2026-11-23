// SPEC §8 shortcut table, exercised through real keyboard events.
import { launch, open, loadText, check, step, expect, getText, lineText, cursor,
         placeCursor, focusEditor, finish, sleep, getFailures } from '../ux/lib.mjs';

const { browser, page, errors } = await launch();
await open(page, '?mode=split');

const DOC = [
  '# 标题一',
  '',
  '普通段落 hello world。',
  '',
  '- [ ] 任务一',
  '- [x] 任务二',
  '',
  '## 标题二',
  '',
  '最后一段。',
].join('\n');

// ---------- editor-scope shortcuts ----------
await loadText(page, DOC, 'kb.md');
await focusEditor(page);

async function sel(fromLine, fromCol, toLine, toCol) {
  await page.evaluate(([a,b,c,d]) => {
    const v = window.__mdr.app.editor.view;
    const f = v.state.doc.line(a).from + b, t = v.state.doc.line(c).from + d;
    v.dispatch({ selection: { anchor: f, head: t } }); v.focus();
  }, [fromLine, fromCol, toLine, toCol]);
}

await step('Mod-b wraps selection in **', async () => {
  await sel(3, 0, 3, 4);            // 普通段落
  await page.keyboard.press('Meta+b');
  const l = await lineText(page, 3);
  expect(l.startsWith('**普通段落**'), `line3 = ${JSON.stringify(l)}`);
});
await step('Mod-b again unwraps', async () => {
  await page.keyboard.press('Meta+b');
  const l = await lineText(page, 3);
  expect(l === '普通段落 hello world。', `line3 = ${JSON.stringify(l)}`);
});
await step('Mod-i wraps/unwraps with _', async () => {
  await sel(3, 0, 3, 4);
  await page.keyboard.press('Meta+i');
  let l = await lineText(page, 3);
  expect(l.startsWith('_普通段落_'), `after = ${JSON.stringify(l)}`);
  await page.keyboard.press('Meta+i');
  l = await lineText(page, 3);
  expect(l === '普通段落 hello world。', `unwrap = ${JSON.stringify(l)}`);
});
await step('Mod-e wraps/unwraps with backtick', async () => {
  await sel(3, 0, 3, 4);
  await page.keyboard.press('Meta+e');
  let l = await lineText(page, 3);
  expect(l.startsWith('`普通段落`'), `after = ${JSON.stringify(l)}`);
  await page.keyboard.press('Meta+e');
  l = await lineText(page, 3);
  expect(l === '普通段落 hello world。', `unwrap = ${JSON.stringify(l)}`);
});
await step('Mod-b with empty cursor inserts pair, cursor inside', async () => {
  await placeCursor(page, 10, 0);
  await page.keyboard.press('Meta+b');
  const l = await lineText(page, 10);
  const c = await cursor(page);
  expect(l.startsWith('****'), `line = ${JSON.stringify(l)}`);
  expect(c.col === 2, `cursor col = ${c.col} (want 2)`);
  await page.keyboard.press('Meta+z'); // undo
});
await step('Mod-k inserts link with selection as text', async () => {
  await loadText(page, DOC, 'kb.md');
  await sel(3, 0, 3, 4);
  await page.keyboard.press('Meta+k');
  await sleep(400);
  const l = await lineText(page, 3);
  expect(/^\[普通段落\]\(/.test(l), `line = ${JSON.stringify(l)}`);
});
for (const n of [1,2,3,4,5,6]) {
  await step(`Mod-${n} sets heading level ${n}`, async () => {
    await loadText(page, DOC, 'kb.md');
    await placeCursor(page, 3, 2);
    await page.keyboard.press(`Meta+${n}`);
    const l = await lineText(page, 3);
    expect(l === '#'.repeat(n) + ' 普通段落 hello world。', `line = ${JSON.stringify(l)}`);
  });
}
await step('Mod-0 turns heading into paragraph', async () => {
  await placeCursor(page, 1, 2);
  await page.keyboard.press('Meta+0');
  const l = await lineText(page, 1);
  expect(l === '标题一', `line = ${JSON.stringify(l)}`);
});
await step('Mod-Shift-x toggles task item', async () => {
  await loadText(page, DOC, 'kb.md');
  await placeCursor(page, 5, 8);
  await page.keyboard.press('Meta+Shift+x');
  let l = await lineText(page, 5);
  expect(l === '- [x] 任务一', `after toggle = ${JSON.stringify(l)}`);
  await page.keyboard.press('Meta+Shift+x');
  l = await lineText(page, 5);
  expect(l === '- [ ] 任务一', `after 2nd toggle = ${JSON.stringify(l)}`);
});
await step('Mod-f opens find panel', async () => {
  await focusEditor(page);
  await page.keyboard.press('Meta+f');
  await sleep(200);
  const vis = await page.locator('.cm-panel.cm-search').isVisible().catch(() => false);
  expect(vis, 'no .cm-search panel visible');
});
await step('Escape closes find panel, focus back to editor', async () => {
  await page.keyboard.press('Escape');
  await sleep(150);
  const n = await page.locator('.cm-panel.cm-search').count();
  expect(n === 0, `${n} search panels remain`);
  const focused = await page.evaluate(() => window.__mdr.app.editor.hasFocus());
  expect(focused, 'editor not focused after Escape');
});
await step('Mod-Alt-g goto line dialog/prompt', async () => {
  await focusEditor(page);
  await page.keyboard.press('Meta+Alt+g');
  await sleep(250);
  const panels = await page.evaluate(() => [...document.querySelectorAll('.cm-panel, .mdr-dialog')].map(e => e.className + '|' + e.textContent.slice(0,60)));
  expect(panels.length > 0, `no goto-line UI appeared; panels=${JSON.stringify(panels)}`);
  return JSON.stringify(panels);
});
await page.keyboard.press('Escape');

// ---------- global-scope shortcuts ----------
await step('Mod-/ cycles mode edit→split→preview', async () => {
  await page.evaluate(() => window.__mdr.mode('edit'));
  await sleep(100);
  await focusEditor(page);
  await page.keyboard.press('Meta+/');
  await sleep(120);
  const m1 = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  await page.keyboard.press('Meta+/');
  await sleep(120);
  const m2 = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  await page.keyboard.press('Meta+/');
  await sleep(120);
  const m3 = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  expect(m1 === 'split' && m2 === 'preview' && m3 === 'edit', `got ${m1},${m2},${m3}`);
});
await step('Mod-Shift-o toggles TOC', async () => {
  const before = await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc);
  await page.keyboard.press('Meta+Shift+o');
  await sleep(120);
  const after = await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc);
  expect(before !== after, `toc stayed ${after}`);
  await page.keyboard.press('Meta+Shift+o');
  await sleep(120);
});
await step('Mod-Shift-l toggles theme', async () => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.keyboard.press('Meta+Shift+l');
  await sleep(150);
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(before !== after, `theme stayed ${after}`);
  await page.keyboard.press('Meta+Shift+l');
  await sleep(150);
});
await step('Mod-Shift-p opens command palette', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await sleep(200);
  const vis = await page.locator('.mdr-palette').isVisible().catch(() => false);
  expect(vis, 'palette not visible');
  await page.keyboard.press('Escape');
  await sleep(150);
});
await step('Mod-s does not navigate / triggers save path', async () => {
  let dl = null;
  page.once('download', (d) => { dl = d; });
  await page.evaluate(() => { window.__savecalls = 0; });
  await page.keyboard.press('Meta+s');
  await sleep(800);
  const url = page.url();
  expect(url.startsWith('http://localhost:5203'), `navigated away to ${url}`);
  return dl ? `download: ${dl.suggestedFilename()}` : 'no download event';
});

finish('01-shortcuts', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
