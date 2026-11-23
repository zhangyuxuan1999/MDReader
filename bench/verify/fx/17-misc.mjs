import { launch, open, loadText, step, expect, finish, sleep, getFailures, focusEditor, placeCursor, lineText, getText, cursor } from '../ux/lib.mjs';
import fs from 'node:fs';
const BASE = 'http://localhost:5203/';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
await page.goto(BASE + '?mode=split');
await page.waitForFunction(() => !!window.__mdr);
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(300);

await step('[legacy] 打开 uses an <input type=file> that actually loads the file', async () => {
  const p = '/tmp/mdr-open-' + Date.now() + '.md';
  fs.writeFileSync(p, '# 打开的文件\n\n通过 input 打开。\n');
  const chooser = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
  await page.click('.mdr-toolbar__btn[data-cmd="file.open"]');
  const fc = await chooser;
  expect(fc, 'no file chooser opened');
  await fc.setFiles(p);
  await sleep(1500);
  const t = await getText(page);
  const title = await page.title();
  expect(t.includes('打开的文件'), `text = ${JSON.stringify(t.slice(0,60))}`);
  return `title=${title}`;
});
await step('toolbar command keeps the editor focused (no focus loss on 加粗)', async () => {
  await loadText(page, 'alpha beta\n', 'f.md');
  await focusEditor(page);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(1); v.dispatch({ selection: { anchor: l.from, head: l.from + 5 } }); v.focus(); });
  await page.click('.mdr-toolbar__btn[data-cmd="edit.bold"]');
  await sleep(300);
  const r = await page.evaluate(() => ({ line: window.__mdr.app.editor.view.state.doc.line(1).text, focus: window.__mdr.app.editor.hasFocus(), active: document.activeElement?.className }));
  expect(r.line === '**alpha** beta', `line = ${JSON.stringify(r.line)}`);
  expect(r.focus, `editor lost focus after a toolbar command (activeElement=${r.active}) — the next keystroke goes nowhere`);
  return JSON.stringify(r);
});
await step('typing right after a toolbar command lands in the editor', async () => {
  await page.keyboard.type('X');
  await sleep(250);
  const t = await getText(page);
  expect(t.includes('X'), `document after typing: ${JSON.stringify(t)}`);
  return JSON.stringify(t);
});
await step('preview checkbox works while in preview-only mode', async () => {
  await loadText(page, '- [ ] 甲\n- [ ] 乙\n', 'p.md');
  await page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(500);
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(600);
  await page.locator('.mdr-preview input[type=checkbox]').nth(1).click();
  await sleep(700);
  const t = await getText(page);
  expect(t.split('\n')[1] === '- [x] 乙', `text = ${JSON.stringify(t)}`);
  await page.evaluate(() => window.__mdr.mode('split'));
  await sleep(300);
  return JSON.stringify(t);
});
await step('task checkbox inside a blockquote maps to the right line', async () => {
  await loadText(page, '正文\n\n> - [ ] 引用里的任务\n> - [ ] 第二个\n', 'q.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(700);
  const n = await page.locator('.mdr-preview input[type=checkbox]').count();
  expect(n === 2, `${n} checkboxes`);
  await page.locator('.mdr-preview input[type=checkbox]').nth(1).click();
  await sleep(700);
  const t = await getText(page);
  expect(t.split('\n')[3] === '> - [x] 第二个', `text = ${JSON.stringify(t)}`);
  return JSON.stringify(t);
});
await step('big-file toast 「大文件：已关闭语法高亮…」 appears', async () => {
  await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(1200);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(t => t.textContent));
  expect(toasts.some(t => /大文件/.test(t)), `toasts = ${JSON.stringify(toasts)} (SPEC §7: the size gate must announce itself once)`);
  return JSON.stringify(toasts);
});
await step('TOC handles a big outline and clicking still navigates', async () => {
  const n = await page.evaluate(() => document.querySelectorAll('.mdr-toc__item').length);
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].slice(0, 3).map(a => a.dataset.line));
  await page.evaluate(() => { const a = [...document.querySelectorAll('.mdr-toc__item')][40]; a?.scrollIntoView(); });
  await sleep(200);
  const target = await page.evaluate(() => { const a = [...document.querySelectorAll('.mdr-toc__item')][40]; return a ? a.dataset.line : null; });
  await page.evaluate(() => { const a = [...document.querySelectorAll('.mdr-toc__item')][40]; a.click(); });
  await sleep(900);
  const c = await cursor(page);
  expect(String(c.line) === target, `clicked TOC item for line ${target}, cursor ended at ${c.line}`);
  return `${n} items, first lines ${items}`;
});
await step('Mod-Shift-s (另存为) reaches the save-as path', async () => {
  await loadText(page, '# 另存为\n', 'sa.md');
  const dlP = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
  await focusEditor(page);
  await page.keyboard.press('Meta+Shift+s');
  const dl = await dlP;
  expect(dl, 'Mod-Shift-s produced nothing');
  return dl.suggestedFilename();
});
await step('command palette reflects command availability (no dead entries)', async () => {
  const dead = await page.evaluate(() => window.__mdr.app.registry.list().filter(c => c.enabled && !c.enabled()).map(c => c.id));
  return `disabled commands: ${JSON.stringify(dead)}`;
});
finish('17-misc', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
