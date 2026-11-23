import { launch, open, loadText, step, expect, lineText, cursor, getText,
         finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(8000);
await open(page, '?mode=split');

const DOC = [
  '# 第一章 Introduction',      // 1
  '',
  '这是第一段 paragraph one。',   // 3
  '',
  '- [ ] 任务甲',                 // 5
  '- [x] 任务乙',                 // 6
  '- [ ] 任务丙',                 // 7
  '',
  '## 第二章 Details',           // 9
  '',
  '段落二 with [锚点](#第一章-introduction) 和 [外链](https://example.com/x) 和 [相对](./other.md)。',  // 11
  '',
  '第三段落。',                   // 13
  '',
  '### 小节',                     // 15
  '',
  '结尾。',                       // 17
].join('\n');
await loadText(page, DOC, 'i.md');
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await sleep(600);

await step('preview renders task checkboxes', async () => {
  const n = await page.locator('.mdr-preview input[type=checkbox]').count();
  expect(n === 3, `${n} checkboxes (want 3)`);
  const checked = await page.evaluate(() => [...document.querySelectorAll('.mdr-preview input[type=checkbox]')].map(i => i.checked));
  expect(JSON.stringify(checked) === '[false,true,false]', JSON.stringify(checked));
});
await step('clicking a preview checkbox writes back to the source', async () => {
  await page.locator('.mdr-preview input[type=checkbox]').first().click();
  await sleep(500);
  const l = await lineText(page, 5);
  expect(l === '- [x] 任务甲', `line5 = ${JSON.stringify(l)}`);
  await page.locator('.mdr-preview input[type=checkbox]').first().click();
  await sleep(500);
  const l2 = await lineText(page, 5);
  expect(l2 === '- [ ] 任务甲', `after untoggle line5 = ${JSON.stringify(l2)}`);
});
await step('clicking the 3rd checkbox toggles the 3rd line (not the first)', async () => {
  await page.locator('.mdr-preview input[type=checkbox]').nth(2).click();
  await sleep(500);
  const t = await getText(page);
  const lines = t.split('\n');
  expect(lines[6] === '- [x] 任务丙', `line7=${JSON.stringify(lines[6])} (line5=${JSON.stringify(lines[4])}, line6=${JSON.stringify(lines[5])})`);
  await page.locator('.mdr-preview input[type=checkbox]').nth(2).click();
  await sleep(400);
});
await step('Alt+click on a preview block moves the editor cursor to that line', async () => {
  const box = await page.locator('.mdr-preview [data-l]').filter({ hasText: '第三段落' }).first().boundingBox()
    .catch(() => null);
  const target = box ?? await page.evaluate(() => {
    const e = [...document.querySelectorAll('.mdr-preview [data-l]')].find(n => n.textContent.includes('第三段落'));
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(target, 'could not find the 第三段落 element in the preview');
  await page.keyboard.down('Alt');
  await page.mouse.click(target.x + 8, target.y + target.height / 2);
  await page.keyboard.up('Alt');
  await sleep(500);
  const c = await cursor(page);
  expect(c.line === 13, `cursor line=${c.line} want 13`);
  return JSON.stringify(c);
});
await step('#anchor link in the preview navigates BOTH panes', async () => {
  // scroll away first
  await page.evaluate(() => { window.__mdr.app.preview.scrollToLine(17, 0); window.__mdr.app.editor.scrollToLine(17, 0); });
  await sleep(400);
  const a = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.mdr-preview a[href^="#"]')][0];
    if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect();
    return { href: e.getAttribute('href'), x: r.x, y: r.y, h: r.height };
  });
  expect(a, 'no #anchor link found in the preview');
  await page.mouse.click(a.x + 4, a.y + a.h / 2);
  await sleep(700);
  const st = await page.evaluate(() => ({
    cur: (() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; })(),
    pv: window.__mdr.app.preview.topVisible(),
    url: location.href,
  }));
  expect(st.cur === 1, `editor cursor line=${st.cur} want 1 (href=${a.href})`);
  expect(Math.abs(st.pv.line - 1) <= 1, `preview top=${JSON.stringify(st.pv)}`);
  expect(!st.url.includes('#'), `URL got a hash appended: ${st.url}`);
  return JSON.stringify(st);
});
await step('external link has target=_blank rel=noopener', async () => {
  const info = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.mdr-preview a')].find(a => a.href.startsWith('https://example.com'));
    return e ? { target: e.target, rel: e.rel, href: e.href } : null;
  });
  expect(info, 'no external link rendered');
  expect(info.target === '_blank', `target=${JSON.stringify(info.target)}`);
  expect(/noopener/.test(info.rel), `rel=${JSON.stringify(info.rel)}`);
  return JSON.stringify(info);
});
await step('external link actually opens in a new tab', async () => {
  const ctx = page.context();
  const before = ctx.pages().length;
  const a = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.mdr-preview a')].find(a => a.href.startsWith('https://example.com'));
    e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height };
  });
  const pagePromise = ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null);
  await page.mouse.click(a.x + 4, a.y + a.h / 2);
  const np = await pagePromise;
  await sleep(300);
  if (np) { await np.close(); }
  expect(np || ctx.pages().length > before, 'no new tab opened for an external link');
  expect(page.url().startsWith('http://localhost:5203'), `main page navigated away to ${page.url()}`);
});
await step('relative link shows the zh-CN toast and does not navigate', async () => {
  const a = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.mdr-preview a')].find(a => a.getAttribute('href') === './other.md');
    if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height };
  });
  expect(a, 'no relative link rendered');
  await page.mouse.click(a.x + 4, a.y + a.h / 2);
  await sleep(500);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(t => t.textContent));
  expect(toast.length > 0, 'no toast shown for a relative link');
  expect(toast.some(t => /相对链接/.test(t)), JSON.stringify(toast));
  expect(page.url().startsWith('http://localhost:5203/?'), `navigated to ${page.url()}`);
  return JSON.stringify(toast);
});
await step('heading anchors work for a raw-slug href too', async () => {
  await loadText(page, '# Alpha Beta\n\n正文\n\n[jump](#alpha-beta)\n', 'a.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(500);
  const a = await page.evaluate(() => {
    const e = [...document.querySelectorAll('.mdr-preview a[href^="#"]')][0];
    if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height };
  });
  expect(a, 'no anchor link');
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(5).from } }); });
  await page.mouse.click(a.x + 4, a.y + a.h / 2);
  await sleep(600);
  const c = await cursor(page);
  expect(c.line === 1, `cursor line=${c.line} want 1`);
});

finish('06-preview-interactions', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
