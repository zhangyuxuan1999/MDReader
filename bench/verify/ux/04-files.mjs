// bench/verify/04-files.mjs — drag & drop, draft autosave/restore, legacy save (download), export HTML.
// Run: node bench/verify/04-files.mjs
import { launch, open, loadText, getText, step, expect, check, finish, sleep, statusText, getFailures, BASE } from './lib.mjs';

const { browser, context, page, errors } = await launch();
// Force the legacy (download) backend: the FSA pickers cannot be automated.
await context.addInitScript(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
  delete window.showDirectoryPicker;
});
page.on('dialog', (d) => d.accept());
await open(page, '?mode=split');

// ---------------------------------------------------------------- drag & drop
const dropFile = (name, text) =>
  page.evaluate(([name, text]) => {
    const app = document.querySelector('.mdr-app');
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/markdown', lastModified: Date.now() - 86400000 }));
    const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    app.dispatchEvent(ev('dragenter'));
    const over = app.classList.contains('is-dragover');
    app.dispatchEvent(ev('dragover'));
    app.dispatchEvent(ev('drop'));
    return { over, after: app.classList.contains('is-dragover') };
  }, [name, text]);

await step('Drop a .md file: dragover highlight, file opens, name in toolbar + title, status 已保存', async () => {
  const r = await dropFile('dropped.md', '# 拖放标题\n\n拖放内容 dropped content\n');
  expect(r.over, 'is-dragover not set on dragenter');
  expect(!r.after, 'is-dragover not cleared on drop');
  await page.waitForFunction(() => window.__mdr.app.getText().includes('拖放内容'), null, { timeout: 3000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(100);
  const name = await page.evaluate(() => document.querySelector('.mdr-toolbar__name').textContent);
  expect(name === 'dropped.md', `toolbar name "${name}"`);
  expect((await page.title()) === 'dropped.md', `title "${await page.title()}"`);
  const s = await statusText(page);
  expect(s.file === 'dropped.md · 已保存', `status "${s.file}"`);
  const h1 = await page.evaluate(() => document.querySelector('.mdr-preview h1')?.textContent);
  expect(h1 === '拖放标题', `preview h1 "${h1}"`);
});
await step('Drop while dirty asks for confirmation; 取消 keeps the current text', async () => {
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type(' EDITED');
  await sleep(50);
  await dropFile('other.md', 'other');
  await page.waitForSelector('.mdr-dialog', { timeout: 2000 });
  await page.click('.mdr-dialog__btn:has-text("取消")');
  await sleep(100);
  expect((await getText(page)).includes('EDITED'), 'text lost');
  expect((await getText(page)) !== 'other', 'dropped file replaced text despite cancel');
});
await step('Drop while dirty + 丢弃 opens the dropped file', async () => {
  await dropFile('other.md', 'other content');
  await page.waitForSelector('.mdr-dialog', { timeout: 2000 });
  await page.click('.mdr-dialog__btn:has-text("丢弃")');
  await page.waitForFunction(() => window.__mdr.app.getText() === 'other content', null, { timeout: 3000 });
});
await step('Dragging non-file data (text) does not highlight', async () => {
  const r = await page.evaluate(() => {
    const app = document.querySelector('.mdr-app');
    const dt = new DataTransfer();
    dt.setData('text/plain', 'x');
    app.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const on = app.classList.contains('is-dragover');
    app.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return on;
  });
  expect(!r, 'highlighted for text drag');
});

// ---------------------------------------------------------------- legacy save (download)
await step('Legacy backend: save button is titled 下载; Mod-s downloads the file, clears dirty', async () => {
  const title = await page.evaluate(() => document.querySelector('[data-cmd="file.save"]').title);
  expect(title.startsWith('下载'), `save title "${title}"`);
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type(' 修改');
  await sleep(100);
  expect((await page.title()).startsWith('●'), 'not dirty');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.keyboard.press('Meta+s')]);
  expect(dl.suggestedFilename() === 'other.md', `filename ${dl.suggestedFilename()}`);
  const path = await dl.path();
  const body = (await import('node:fs')).readFileSync(path, 'utf8');
  expect(body === 'other content 修改', `downloaded body "${body}"`);
  await sleep(150);
  expect((await page.title()) === 'other.md', `title after save "${await page.title()}"`);
  const s = await statusText(page);
  expect(s.file === 'other.md · 已保存', `status "${s.file}"`);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent).join('|'));
  expect(toast.includes('已下载'), `toast "${toast}"`);
});
await step('Mod-Shift-s (另存为) downloads; untitled doc downloads as 未命名.md', async () => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.keyboard.press('Meta+Shift+s')]);
  expect(dl.suggestedFilename() === 'other.md', `filename ${dl.suggestedFilename()}`);
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await sleep(100);
  await page.click('.cm-content');
  await page.keyboard.type('新文档');
  await sleep(50);
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('.mdr-toolbar__btn[data-cmd="file.save"]')]);
  expect(dl2.suggestedFilename() === '未命名.md', `filename ${dl2.suggestedFilename()}`);
  await sleep(100);
  const s = await statusText(page);
  expect(s.file === '未命名.md · 已保存', `status "${s.file}"`);
});
await step('Export HTML downloads a standalone .html with the rendered content', async () => {
  await loadText(page, '# 导出标题\n\n段落 **加粗** $E=mc^2$\n\n```js\nconst a = 1;\n```\n', 'exp.md');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('.mdr-toolbar__btn[data-cmd="file.exportHtml"]')]);
  expect(dl.suggestedFilename() === 'exp.html', `filename ${dl.suggestedFilename()}`);
  const body = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  expect(body.includes('<h1') && body.includes('导出标题') && body.includes('<strong>加粗</strong>'), 'html content missing');
  expect(body.includes('<style>') && body.includes('.mdr-preview__body'), 'css not inlined');
  check('Export HTML is standalone (no external stylesheet/CDN links)', !/<link[^>]+href="https?:/.test(body), (/<link[^>]+href="[^"]+/.exec(body) || ['none'])[0]);
  expect(body.includes('hljs') || body.includes('md-code'), 'code block missing');
  expect(!body.includes('<script'), 'export contains script');
  return `${body.length} bytes; katex=${body.includes('katex')}`;
});

// ---------------------------------------------------------------- drafts
await step('Draft autosave: status shows 草稿已存 within ~1.5 s of typing', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await sleep(100);
  await page.click('.cm-content');
  await page.keyboard.type('草稿内容 draft text 123');
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('[data-stat="file"]').textContent.includes('草稿已存'), null, { timeout: 4000 });
  return `draft saved after ${Date.now() - t0} ms`;
});
await step('Reload after draft: restore prompt with 恢复/丢弃; 恢复 restores text', async () => {
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await page.waitForSelector('.mdr-toast', { timeout: 4000 });
  const txt = await page.evaluate(() => document.querySelector('.mdr-toast__text').textContent);
  expect(txt === '发现未保存的草稿，是否恢复？', `toast "${txt}"`);
  const btns = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__btn')].map((b) => b.textContent));
  expect(btns.join(',') === '恢复,丢弃', `buttons ${btns}`);
  expect((await getText(page)) === '', 'doc not empty before restore');
  await page.click('.mdr-toast__btn:has-text("恢复")');
  await sleep(200);
  expect((await getText(page)) === '草稿内容 draft text 123', `restored "${await getText(page)}"`);
  const s = await statusText(page);
  expect(/草稿已存|未保存/.test(s.file), `status "${s.file}"`);
  const p = await page.evaluate(() => document.querySelector('.mdr-preview p')?.textContent);
  expect(p === '草稿内容 draft text 123', `preview "${p}"`);
  expect((await page.title()).startsWith('●'), `title should be dirty after restore: "${await page.title()}"`);
  const toastGone = await page.evaluate(() => !document.querySelector('.mdr-toast'));
  expect(toastGone, 'toast not dismissed');
});
await step('Restored draft persists again after a further reload (still offered)', async () => {
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await page.waitForSelector('.mdr-toast', { timeout: 4000 });
  await page.click('.mdr-toast__btn:has-text("恢复")');
  await sleep(100);
  expect((await getText(page)) === '草稿内容 draft text 123', `restored "${await getText(page)}"`);
});
await step('丢弃 deletes the draft: no prompt on the next reload', async () => {
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await page.waitForSelector('.mdr-toast', { timeout: 4000 });
  await page.click('.mdr-toast__btn:has-text("丢弃")');
  await sleep(200);
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await sleep(1200);
  const toast = await page.evaluate(() => document.querySelector('.mdr-toast')?.textContent ?? null);
  expect(toast === null, `unexpected toast "${toast}"`);
});
await step('Draft is flushed on visibilitychange→hidden (typing < 1 s before reload)', async () => {
  await page.click('.cm-content');
  await page.keyboard.type('快速输入');
  // simulate tab hide → flush
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  const found = await page.waitForSelector('.mdr-toast', { timeout: 3000 }).then(() => true).catch(() => false);
  expect(found, 'no draft prompt after flush');
  await page.click('.mdr-toast__btn:has-text("恢复")');
  await sleep(100);
  expect((await getText(page)) === '快速输入', `restored "${await getText(page)}"`);
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await page.waitForSelector('.mdr-dialog');
  await page.click('.mdr-dialog__btn:has-text("丢弃")');
});
await step('Saving clears the draft (no prompt after reload)', async () => {
  await sleep(100);
  await page.click('.cm-content');
  await page.keyboard.type('要保存的内容');
  await page.waitForFunction(() => document.querySelector('[data-stat="file"]').textContent.includes('草稿已存'), null, { timeout: 4000 });
  await Promise.all([page.waitForEvent('download'), page.keyboard.press('Meta+s')]);
  await sleep(200);
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await sleep(1200);
  const toast = await page.evaluate(() => document.querySelector('.mdr-toast')?.textContent ?? null);
  expect(toast === null, `unexpected toast "${toast}"`);
});
await step('Draft for a dropped (legacy) file is offered on re-drop of the same file', async () => {
  await dropFile('same.md', 'original body');
  await page.waitForFunction(() => window.__mdr.app.getText() === 'original body');
  await page.click('.cm-content');
  await page.keyboard.press('End');
  await page.keyboard.type(' plus edit');
  await page.waitForFunction(() => document.querySelector('[data-stat="file"]').textContent.includes('草稿已存'), null, { timeout: 4000 });
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr);
  await sleep(300);
  await dropFile('same.md', 'original body');
  await page.waitForFunction(() => window.__mdr.app.getText() === 'original body');
  const found = await page.waitForSelector('.mdr-toast', { timeout: 3000 }).then(() => true).catch(() => false);
  expect(found, 'no draft prompt for re-dropped file');
  await page.click('.mdr-toast__btn:has-text("丢弃")');
});

finish('04-files', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
