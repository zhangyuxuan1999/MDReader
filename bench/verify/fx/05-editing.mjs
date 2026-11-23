import { launch, open, loadText, step, expect, lineText, cursor, placeCursor,
         focusEditor, getText, finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(8000);
await open(page, '?mode=split');

const put = async (text) => { await loadText(page, text, 'e.md'); await focusEditor(page); };

await step('Enter continues an unordered list', async () => {
  await put('- 甲\n- 乙\n');
  await placeCursor(page, 2, 2);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('丙');
  const l = await lineText(page, 3);
  expect(l === '- 丙', `line3 = ${JSON.stringify(l)}`);
});
await step('Enter continues an ordered list with the next number', async () => {
  await put('1. 甲\n2. 乙\n');
  await placeCursor(page, 2, 0); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('丙');
  const l = await lineText(page, 3);
  expect(l === '3. 丙', `line3 = ${JSON.stringify(l)}`);
});
await step('Enter continues a task list with an unchecked box', async () => {
  await put('- [x] 甲\n');
  await placeCursor(page, 1, 0); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('乙');
  const l = await lineText(page, 2);
  expect(l === '- [ ] 乙', `line2 = ${JSON.stringify(l)}`);
});
await step('Enter on an empty list item ends the list', async () => {
  await put('- 甲\n- \n');
  await placeCursor(page, 2, 0); await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const txt = await getText(page);
  expect(!/^- $/m.test(txt.split('\n')[1] ?? ''), `text = ${JSON.stringify(txt)}`);
  return JSON.stringify(txt);
});
await step('Enter continues a blockquote', async () => {
  await put('> 引用一\n');
  await placeCursor(page, 1, 0); await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.type('引用二');
  const l = await lineText(page, 2);
  expect(l.startsWith('>'), `line2 = ${JSON.stringify(l)}`);
});
await step('Tab indents a list item', async () => {
  await put('- 甲\n- 乙\n');
  await placeCursor(page, 2, 4);
  await page.keyboard.press('Tab');
  const l = await lineText(page, 2);
  expect(l === '  - 乙', `line2 = ${JSON.stringify(l)}`);
});
await step('Shift-Tab dedents a list item', async () => {
  await page.keyboard.press('Shift+Tab');
  const l = await lineText(page, 2);
  expect(l === '- 乙', `line2 = ${JSON.stringify(l)}`);
});
await step('Tab outside a list indents by tabSize', async () => {
  await put('普通一行\n');
  await placeCursor(page, 1, 0);
  await page.keyboard.press('Tab');
  const l = await lineText(page, 1);
  expect(l.startsWith('  ') || l.startsWith('\t'), `line1 = ${JSON.stringify(l)}`);
});
await step('Backspace after a list marker removes the marker', async () => {
  await put('- 甲\n');
  await placeCursor(page, 1, 2);
  await page.keyboard.press('Backspace');
  const l = await lineText(page, 1);
  expect(l === '甲', `line1 = ${JSON.stringify(l)}`);
});
await step('Backspace after a task marker removes the whole marker', async () => {
  await put('- [ ] 甲\n');
  await placeCursor(page, 1, 6);
  await page.keyboard.press('Backspace');
  const l = await lineText(page, 1);
  expect(l === '甲', `line1 = ${JSON.stringify(l)} (want "甲")`);
});
await step('Backspace after an indented list marker removes indent+marker', async () => {
  await put('- 甲\n  - 乙\n');
  await placeCursor(page, 2, 4);
  await page.keyboard.press('Backspace');
  const l = await lineText(page, 2);
  expect(l === '乙', `line2 = ${JSON.stringify(l)}`);
});
await step('bold toggle-wrap works on a multi-word selection and unwraps exactly', async () => {
  await put('alpha beta gamma\n');
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(1); v.dispatch({ selection: { anchor: l.from + 6, head: l.from + 10 } }); v.focus(); });
  await page.keyboard.press('Meta+b');
  let l = await lineText(page, 1);
  expect(l === 'alpha **beta** gamma', `wrap = ${JSON.stringify(l)}`);
  await page.keyboard.press('Meta+b');
  l = await lineText(page, 1);
  expect(l === 'alpha beta gamma', `unwrap = ${JSON.stringify(l)}`);
});
await step('INFO: bold with a bare cursor inside **…** (SPEC §7 says cursor-only inserts a pair)', async () => {
  await put('alpha **beta** gamma\n');
  await placeCursor(page, 1, 10);
  await page.keyboard.press('Meta+b');
  const l = await lineText(page, 1);
  return JSON.stringify(l);
});
await step('heading command replaces an existing heading prefix (no stacking)', async () => {
  await put('### 三级标题\n');
  await placeCursor(page, 1, 5);
  await page.keyboard.press('Meta+1');
  const l = await lineText(page, 1);
  expect(l === '# 三级标题', `line = ${JSON.stringify(l)}`);
});
await step('heading command over a multi-line selection rewrites each line', async () => {
  await put('一\n二\n三\n');
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(1).from, head: v.state.doc.line(3).to } }); v.focus(); });
  await page.keyboard.press('Meta+2');
  const t = await getText(page);
  return JSON.stringify(t);
});
await step('link command with no selection places the cursor sensibly', async () => {
  await put('行尾\n');
  await placeCursor(page, 1, 2);
  await page.keyboard.press('Meta+k');
  await sleep(400);
  const l = await lineText(page, 1);
  const c = await cursor(page);
  return `${JSON.stringify(l)} cursor=${JSON.stringify(c)}`;
});
await step('undo restores the document after a command', async () => {
  await put('alpha\n');
  await placeCursor(page, 1, 0);
  await page.keyboard.press('Meta+1');
  expect((await lineText(page, 1)) === '# alpha', 'heading not applied');
  await page.keyboard.press('Meta+z');
  await sleep(150);
  const l = await lineText(page, 1);
  expect(l === 'alpha', `after undo = ${JSON.stringify(l)}`);
});

finish('05-editing', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
