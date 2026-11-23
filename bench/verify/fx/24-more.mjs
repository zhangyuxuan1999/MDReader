import { launch, open, loadText, step, expect, finish, sleep, getFailures, focusEditor, getText, lineText, placeCursor } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await page.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
await page.goto('http://localhost:5203/?mode=split');
await page.waitForFunction(() => !!window.__mdr);
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(300);

await step('heading command on a blockquote line', async () => {
  await loadText(page, '> 引用一\n', 'q.md');
  await focusEditor(page); await placeCursor(page, 1, 3);
  await page.keyboard.press('Meta+2');
  const l = await lineText(page, 1);
  return JSON.stringify(l);
});
await step('code command on a selection that already contains backticks', async () => {
  await loadText(page, 'x `y` z\n', 'c.md');
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; const l = v.state.doc.line(1); v.dispatch({ selection: { anchor: l.from, head: l.to } }); v.focus(); });
  await page.keyboard.press('Meta+e');
  await sleep(200);
  return JSON.stringify(await lineText(page, 1));
});
await step('bold across a multi-line selection', async () => {
  await loadText(page, '第一行\n第二行\n', 'b.md');
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(1).from, head: v.state.doc.line(2).to } }); v.focus(); });
  await page.keyboard.press('Meta+b');
  await sleep(200);
  return JSON.stringify(await getText(page));
});
await step('recent-files chip opens a list after opening files', async () => {
  const fs = await import('node:fs');
  page.on('dialog', async d => d.accept());
  const dismissGuard = async () => { await page.evaluate(() => { const d = document.querySelector('.mdr-dialog'); if (d) [...d.querySelectorAll('button')].find(b => /丢弃/.test(b.textContent))?.click(); }); await sleep(400); };
  for (const n of ['r1', 'r2']) {
    const p = `/tmp/mdr-${n}-${Date.now()}.md`;
    fs.writeFileSync(p, `# ${n}\n\n内容\n`);
    const ch = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
    await page.click('.mdr-toolbar__btn[data-cmd="file.open"]');
    await sleep(300); await dismissGuard();
    const fc = await ch; expect(fc, 'no chooser'); await fc.setFiles(p);
    await sleep(1200);
  }
  await page.click('.mdr-toolbar__file');
  await sleep(400);
  const list = await page.evaluate(() => { const l = document.querySelector('.mdr-recent, .mdr-toolbar__file ul'); return l ? { items: [...l.querySelectorAll('li')].map(li => li.textContent.trim()), visible: !!l.getClientRects().length } : null; });
  expect(list, 'clicking the file chip opened no recent-files list');
  expect(list.visible && list.items.length > 0, JSON.stringify(list));
  return JSON.stringify(list);
});
await step('choosing a recent entry reopens it', async () => {
  const before = await page.title();
  const clicked = await page.evaluate(() => { const l = document.querySelector('.mdr-recent, .mdr-toolbar__file ul'); const li = [...l.querySelectorAll('li')].find(li => /r1/.test(li.textContent)); if (!li) return null; li.click(); return li.textContent.trim(); });
  await sleep(1500);
  const after = await page.title();
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(t => t.textContent));
  return `clicked=${JSON.stringify(clicked)} title ${before} -> ${after}; toasts=${JSON.stringify(toasts)}`;
});
await step('interactive controls show a visible focus ring when tabbed to', async () => {
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Tab');
  const r = await page.evaluate(() => { const e = document.activeElement; const s = getComputedStyle(e);
    return { tag: e.tagName, cls: e.className, outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor, boxShadow: s.boxShadow }; });
  const visible = !/none/.test(r.outline.split(' ')[0]) || (r.boxShadow && r.boxShadow !== 'none');
  expect(visible, `first tab stop (${r.tag}.${r.cls}) has no focus indicator: ${JSON.stringify(r)}`);
  return JSON.stringify(r);
});
finish('24-more', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
