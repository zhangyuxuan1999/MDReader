import { launch, open, loadText, step, expect, getText, finish, sleep, getFailures, focusEditor, placeCursor } from '../ux/lib.mjs';
import fs from 'node:fs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await open(page, '?mode=split');

console.log('FSA available:', await page.evaluate(() => ({ picker: 'showOpenFilePicker' in window, canSaveInPlace: window.__mdr.app.files?.canSaveInPlace })));

await step('title shows the file name, no dot when clean', async () => {
  await loadText(page, '# 干净文档\n\n内容。\n', 'clean.md');
  await sleep(400);
  const t = await page.title();
  expect(t.includes('clean.md'), `title=${JSON.stringify(t)}`);
  expect(!t.startsWith('●'), `title starts with dot while clean: ${JSON.stringify(t)}`);
  return t;
});
await step('editing adds the ● dot to the title and the toolbar file label', async () => {
  await focusEditor(page);
  await placeCursor(page, 3, 0);
  await page.keyboard.type('改');
  await sleep(500);
  const t = await page.title();
  const label = await page.evaluate(() => {
    const f = document.querySelector('.mdr-toolbar__file');
    const d = f?.querySelector('.mdr-toolbar__dot');
    return { text: f?.textContent, dotHidden: d?.hidden, dotVisible: !!d?.getClientRects().length };
  });
  expect(t.startsWith('●'), `title=${JSON.stringify(t)}`);
  expect(label.dotVisible, `toolbar dirty dot not visible: ${JSON.stringify(label)}`);
  return `${t} | ${JSON.stringify(label)}`;
});
await step('status bar shows 未保存 when dirty', async () => {
  const s = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.mdr-statusbar__item')].map(e => [e.dataset.stat, e.textContent])));
  expect(/未保存/.test(s.file ?? ''), JSON.stringify(s));
  return JSON.stringify(s);
});

// ---------- new-file dirty guard ----------
await step('file.new while dirty shows a zh-CN confirm dialog; cancel keeps the content', async () => {
  const before = await getText(page);
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await sleep(500);
  const custom = await page.evaluate(() => {
    const d = document.querySelector('.mdr-dialog');
    return d ? { text: d.textContent, buttons: [...d.querySelectorAll('button')].map(b => b.textContent.trim()) } : null;
  });
  const msg = custom ? JSON.stringify(custom) : JSON.stringify(dialogs);
  expect(custom || dialogs.length, 'no dirty-guard dialog appeared at all');
  const txt = custom ? custom.text : dialogs.join(' ');
  expect(/[一-鿿]/.test(txt), `dialog not in Chinese: ${msg}`);
  if (custom) {
    const cancel = await page.evaluate(() => {
      const d = document.querySelector('.mdr-dialog');
      const b = [...d.querySelectorAll('button')].find(b => /取消|否|放弃更改/.test(b.textContent) === false) ;
      return null;
    });
    // click the cancel-looking button
    const btns = custom.buttons;
    const idx = btns.findIndex(b => /取消/.test(b));
    expect(idx >= 0, `no 取消 button: ${JSON.stringify(btns)}`);
    await page.evaluate((i) => { [...document.querySelector('.mdr-dialog').querySelectorAll('button')][i].click(); }, idx);
  }
  await sleep(500);
  const after = await getText(page);
  expect(after === before, `content changed after cancelling the guard: ${JSON.stringify(after.slice(0,60))}`);
  return msg;
});
await step('file.new confirmed clears the document', async () => {
  page.removeAllListeners('dialog');
  page.on('dialog', async d => { await d.accept(); });
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await sleep(400);
  const custom = await page.evaluate(() => {
    const d = document.querySelector('.mdr-dialog');
    if (!d) return null;
    const bs = [...d.querySelectorAll('button')];
    const ok = bs.find(b => !/取消/.test(b.textContent));
    ok?.click(); return ok?.textContent ?? null;
  });
  await sleep(600);
  const t = await getText(page);
  const title = await page.title();
  expect(t.trim() === '', `document not cleared: ${JSON.stringify(t.slice(0,80))}`);
  expect(/未命名/.test(title), `title=${title}`);
  return `ok button=${custom}, title=${title}`;
});

// ---------- legacy save = download ----------
await step('INFO: 保存 with the real FSA picker present (picker cannot be automated; see 09-save.mjs)', async () => {
  await loadText(page, '# 下载测试\n\n内容一二三。\n', 'dl.md');
  await sleep(300);
  const dlPromise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
  await page.click('.mdr-toolbar__btn[data-cmd="file.save"]');
  const dl = await dlPromise;
  if (!dl) return 'no download (FSA picker path — covered by 09-save.mjs)';
  const p = '/tmp/mdr-save-' + Date.now() + '.md';
  await dl.saveAs(p);
  const content = fs.readFileSync(p, 'utf8');
  expect(content.includes('下载测试'), `downloaded content = ${JSON.stringify(content.slice(0,80))}`);
  await sleep(500);
  const title = await page.title();
  const st = await page.evaluate(() => document.querySelector('.mdr-statusbar__item[data-stat=file]')?.textContent);
  expect(!title.startsWith('●'), `title still dirty after save: ${title}`);
  expect(/已保存/.test(st ?? ''), `status after save: ${st}`);
  return `${dl.suggestedFilename()} -> ${content.length} bytes, status=${st}`;
});
await step('导出 HTML downloads a standalone html file', async () => {
  const dlPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.click('.mdr-toolbar__btn[data-cmd="file.exportHtml"]');
  const dl = await dlPromise;
  expect(dl, 'no download from 导出 HTML');
  const p = '/tmp/mdr-export-' + Date.now() + '.html';
  await dl.saveAs(p);
  const html = fs.readFileSync(p, 'utf8');
  expect(/<html/i.test(html) && html.includes('下载测试'), `export = ${JSON.stringify(html.slice(0,200))}`);
  return `${dl.suggestedFilename()} ${html.length} bytes`;
});

// ---------- drag & drop ----------
await step('drag & drop of a .md file loads it', async () => {
  const md = '# 拖拽文件\n\n拖进来的内容。\n\n## 第二节\n';
  await page.evaluate(async (text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'dropped.md', { type: 'text/markdown' }));
    const app = document.querySelector('.mdr-app');
    app.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, md);
  await sleep(1500);
  const t = await getText(page);
  const title = await page.title();
  expect(t.includes('拖拽文件'), `document after drop = ${JSON.stringify(t.slice(0,80))}; title=${title}`);
  expect(title.includes('dropped.md'), `title=${title}`);
  return title;
});
await step('dragover adds the .is-dragover affordance', async () => {
  const cls = await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.md', { type: 'text/markdown' }));
    const app = document.querySelector('.mdr-app');
    app.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    app.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 60));
    const c = app.className;
    app.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return c;
  });
  expect(/is-dragover/.test(cls), `.mdr-app class during dragover = ${JSON.stringify(cls)}`);
});

finish('08-files', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
