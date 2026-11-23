import { launch, step, expect, finish, sleep, getFailures, focusEditor, placeCursor } from '../ux/lib.mjs';
import fs from 'node:fs';
const BASE = 'http://localhost:5203/';

// ---- A: legacy backend (FSA removed before the app boots) ----
{
  const { browser, page, errors } = await launch();
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete window.showDirectoryPicker;
  });
  await page.goto(BASE + '?mode=split');
  await page.waitForFunction(() => !!window.__mdr);
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate(() => window.__mdr.loadText('# 下载测试\n\n内容一二三。\n', 'dl.md'));
  await sleep(600);

  await step('[legacy] toolbar save button is labelled 下载', async () => {
    const t = await page.evaluate(() => document.querySelector('.mdr-toolbar__btn[data-cmd="file.save"]')?.title);
    expect(/下载/.test(t ?? ''), `title=${JSON.stringify(t)} (SPEC §8: legacy backend shows 下载)`);
    return t;
  });
  await step('[legacy] 保存 downloads the markdown', async () => {
    const dlP = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.click('.mdr-toolbar__btn[data-cmd="file.save"]');
    const dl = await dlP;
    expect(dl, 'no download event');
    const p = '/tmp/mdr-legacy-' + Date.now() + '.md';
    await dl.saveAs(p);
    const c = fs.readFileSync(p, 'utf8');
    expect(c.includes('下载测试'), JSON.stringify(c.slice(0, 80)));
    return `${dl.suggestedFilename()} (${c.length} bytes)`;
  });
  await step('[legacy] after saving, status shows 已保存 and the title dot clears', async () => {
    await sleep(600);
    const r = await page.evaluate(() => ({ title: document.title, file: document.querySelector('.mdr-statusbar__item[data-stat=file]')?.textContent }));
    expect(!r.title.startsWith('●'), JSON.stringify(r));
    expect(/已保存/.test(r.file ?? ''), JSON.stringify(r));
    return JSON.stringify(r);
  });
  await step('[legacy] Mod-s also downloads', async () => {
    await focusEditor(page); await placeCursor(page, 3, 0); await page.keyboard.type('X'); await sleep(400);
    const dlP = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.keyboard.press('Meta+s');
    const dl = await dlP;
    expect(dl, 'Mod-s produced no download');
    return dl.suggestedFilename();
  });
  finish('09-save/legacy', errors);
  await browser.close();
}

// ---- B: FSA available but the picker rejects (what the user sees) ----
{
  const { browser, page, errors } = await launch();
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.__pickerCalls = 0;
    window.showSaveFilePicker = () => { window.__pickerCalls++; return Promise.reject(Object.assign(new DOMException('user aborted', 'AbortError'))); };
  });
  await page.goto(BASE + '?mode=split');
  await page.waitForFunction(() => !!window.__mdr);
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate(() => window.__mdr.loadText('# FSA\n\n内容。\n', 'fsa.md'));
  await sleep(600);
  await step('[fsa] cancelled save picker leaves the document dirty and shows no error', async () => {
    await focusEditor(page); await placeCursor(page, 3, 0); await page.keyboard.type('Y'); await sleep(400);
    await page.click('.mdr-toolbar__btn[data-cmd="file.save"]');
    await sleep(800);
    const r = await page.evaluate(() => ({ calls: window.__pickerCalls, title: document.title, toasts: [...document.querySelectorAll('.mdr-toast')].map(t => t.textContent) }));
    expect(r.calls === 1, `showSaveFilePicker called ${r.calls} times`);
    expect(r.title.startsWith('●'), `document marked clean after a cancelled save: ${JSON.stringify(r)}`);
    expect(r.toasts.length === 0, `toast shown for a user cancellation: ${JSON.stringify(r.toasts)}`);
    return JSON.stringify(r);
  });
  await step('[fsa] a failing picker (SecurityError) surfaces a zh-CN error toast', async () => {
    await page.evaluate(() => { window.showSaveFilePicker = () => Promise.reject(new DOMException('nope', 'SecurityError')); });
    await page.click('.mdr-toolbar__btn[data-cmd="file.save"]');
    await sleep(900);
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(t => t.textContent));
    expect(toasts.length > 0, 'no toast for a failing save');
    expect(/[一-鿿]/.test(toasts.join('')), JSON.stringify(toasts));
    return JSON.stringify(toasts);
  });
  finish('09-save/fsa', errors);
  await browser.close();
}
process.exit(getFailures() ? 1 : 0);
