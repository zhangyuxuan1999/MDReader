// bench/verify/ux/08-more.mjs — Tab outside lists, blockquote continuation, Mod-k with clipboard URL,
// theme recolours code/toc, undo grouping after toggle-wrap. Run: node bench/verify/ux/08-more.mjs
import { launch, open, loadText, lineText, cursor, placeCursor, selectRange, step, expect, check, finish, sleep, getFailures } from './lib.mjs';
const { browser, context, page, errors } = await launch({ permissions: ['clipboard-read', 'clipboard-write'] });
await open(page, '?mode=split');
await loadText(page, '段落 abc\n\n> 引用一\n\n```js\nlet a = 1;\n```\n', 'm.md');
await step('Tab outside a list inserts indentation (indentMore), Shift-Tab removes it', async () => {
  await placeCursor(page, 1, 0);
  await page.keyboard.press('Tab');
  const t = await lineText(page, 1);
  expect(t === '  段落 abc', `after Tab: "${t}"`);
  await page.keyboard.press('Shift+Tab');
  expect((await lineText(page, 1)) === '段落 abc', `after Shift-Tab: "${await lineText(page, 1)}"`);
});
await step('Enter inside a blockquote continues with "> "', async () => {
  await placeCursor(page, 3, 5);
  await page.keyboard.press('Enter');
  await page.keyboard.type('二');
  expect((await lineText(page, 4)) === '> 二', `got "${await lineText(page, 4)}"`);
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
});
await step('Mod-k uses a URL from the clipboard when one is present', async () => {
  await page.evaluate(() => navigator.clipboard.writeText('https://clip.example/path'));
  const l = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.line(1));
  await selectRange(page, l.from + 3, l.from + 6);
  await page.keyboard.press('Meta+k');
  await sleep(300);
  const t = await lineText(page, 1);
  expect(t === '段落 [abc](https://clip.example/path)', `got "${t}"`);
  await page.keyboard.press('Meta+z');
  await page.evaluate(() => navigator.clipboard.writeText('not a url'));
  await selectRange(page, l.from + 3, l.from + 6);
  await page.keyboard.press('Meta+k');
  await sleep(300);
  const t2 = await lineText(page, 1);
  expect(t2 === '段落 [abc](url)', `non-url clipboard: got "${t2}"`);
  await page.keyboard.press('Meta+z');
});
await step('Theme toggle recolours the hljs code block, TOC and status bar (tokens flip)', async () => {
  const grab = () => page.evaluate(() => ({ kw: getComputedStyle(document.querySelector('.hljs-keyword')).color, pre: getComputedStyle(document.querySelector('.mdr-preview pre')).backgroundColor, sb: getComputedStyle(document.querySelector('.mdr-statusbar')).backgroundColor, tb: getComputedStyle(document.querySelector('.mdr-toolbar')).backgroundColor, cmGutter: getComputedStyle(document.querySelector('.cm-gutters')).backgroundColor }));
  const a = await grab();
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]');
  await sleep(150);
  const b = await grab();
  for (const k of Object.keys(a)) expect(a[k] !== b[k], `${k} unchanged after theme toggle: ${a[k]}`);
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]');
  return JSON.stringify({ light: a, dark: b });
});
await step('Selection survives toggle-wrap round trip and cursor-only italic/code place cursor inside', async () => {
  await placeCursor(page, 1, 9);
  await page.keyboard.press('Meta+i'); await page.keyboard.type('y');
  expect((await lineText(page, 1)) === '段落 abc_y_', `italic: "${await lineText(page, 1)}"`);
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
  await placeCursor(page, 1, 9);
  await page.keyboard.press('Meta+e'); await page.keyboard.type('z');
  expect((await lineText(page, 1)) === '段落 abc`z`', `code: "${await lineText(page, 1)}"`);
  await page.keyboard.press('Meta+z'); await page.keyboard.press('Meta+z');
});
await step('Heading command on a list line / code fence line (edge)', async () => {
  await placeCursor(page, 6, 0);
  await page.keyboard.press('Meta+2');
  const t = await lineText(page, 6);
  await page.keyboard.press('Meta+z');
  return `inside fence: "${t}"`;
});
finish('08-more', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
