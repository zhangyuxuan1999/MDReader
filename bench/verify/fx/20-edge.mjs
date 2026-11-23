import { launch, open, loadText, step, expect, finish, sleep, getFailures, focusEditor, getText, cursor, placeCursor, lineText } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await open(page, '?mode=split');

await step('Alt+click on the 3rd line of a multi-line list block hits that line', async () => {
  await loadText(page, '前言\n\n- 甲\n- 乙\n- 丙\n- 丁\n', 'a.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(700);
  const t = await page.evaluate(() => { const e = [...document.querySelectorAll('.mdr-preview li')].find(n => n.textContent.trim() === '丙'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, h: r.height, dl: e.dataset.l }; });
  expect(t, 'no <li> 丙 found');
  await page.keyboard.down('Alt');
  await page.mouse.click(t.x + 6, t.y + t.h / 2);
  await page.keyboard.up('Alt');
  await sleep(500);
  const c = await cursor(page);
  expect(c.line === 5, `cursor line=${c.line} want 5 (li data-l=${t.dl})`);
  return `data-l=${t.dl}, cursor ${JSON.stringify(c)}`;
});
await step('undo after a preview checkbox toggle restores the source', async () => {
  await loadText(page, '- [ ] 甲\n- [ ] 乙\n', 'b.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(600);
  await page.locator('.mdr-preview input[type=checkbox]').first().click();
  await sleep(600);
  expect((await getText(page)).startsWith('- [x]'), 'toggle did not apply');
  await focusEditor(page);
  await page.keyboard.press('Meta+z');
  await sleep(400);
  const t = await getText(page);
  expect(t.startsWith('- [ ]'), `after undo: ${JSON.stringify(t)}`);
  return JSON.stringify(t);
});
await step('global shortcuts are suppressed while the palette input has focus', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await sleep(300);
  const mode0 = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  await page.keyboard.press('Meta+/');
  await sleep(300);
  const mode1 = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  const stillOpen = await page.locator('.mdr-palette').isVisible().catch(() => false);
  await page.keyboard.press('Escape');
  await sleep(200);
  expect(mode0 === mode1, `Mod-/ changed the mode (${mode0} -> ${mode1}) while the palette was focused`);
  return `mode stayed ${mode1}, palette open=${stillOpen}`;
});
await step('dropping a file while dirty asks before discarding', async () => {
  await loadText(page, '# 原文档\n\n内容\n', 'orig.md');
  await focusEditor(page); await placeCursor(page, 3, 0); await page.keyboard.type('脏');
  await sleep(500);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# 新文档\n'], 'new.md', { type: 'text/markdown' }));
    const app = document.querySelector('.mdr-app');
    app.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(700);
  const d = await page.evaluate(() => { const e = document.querySelector('.mdr-dialog'); return e ? { txt: e.textContent, btns: [...e.querySelectorAll('button')].map(b => b.textContent.trim()) } : null; });
  expect(d, 'dropping a file over unsaved changes did not ask for confirmation');
  // cancel and check the original content survives
  await page.evaluate(() => { const e = document.querySelector('.mdr-dialog'); [...e.querySelectorAll('button')].find(b => /取消/.test(b.textContent)).click(); });
  await sleep(700);
  const t = await getText(page);
  expect(t.includes('原文档'), `after cancelling the drop the document is ${JSON.stringify(t.slice(0,40))}`);
  return JSON.stringify(d);
});
await step('dropping a non-markdown file is refused with a toast', async () => {
  await page.evaluate(() => window.__mdr.loadText('# 保留\n', 'keep.md'));
  await sleep(400);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x89,0x50,0x4e,0x47])], 'x.png', { type: 'image/png' }));
    const app = document.querySelector('.mdr-app');
    app.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(800);
  const t = await getText(page);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map(e => e.textContent));
  expect(t.includes('保留'), `a .png replaced the document: ${JSON.stringify(t.slice(0,60))}`);
  expect(toasts.length > 0, 'no toast for an unsupported file');
  return JSON.stringify(toasts);
});
await step('selecting text in the preview does not move the cursor / break sync', async () => {
  await loadText(page, '# T\n\n第一段落内容。\n\n第二段落内容。\n', 'c.md');
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await sleep(600);
  await placeCursor(page, 1, 0);
  const t = await page.evaluate(() => { const e = [...document.querySelectorAll('.mdr-preview p')].find(p => p.textContent.includes('第二段落')); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(t.x + 4, t.y + t.h / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + 80, t.y + t.h / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(400);
  const sel = await page.evaluate(() => getSelection().toString());
  const c = await cursor(page);
  expect(sel.length > 0, 'no text selected in the preview');
  expect(c.line === 1, `plain drag-select in the preview moved the editor cursor to line ${c.line}`);
  return `selected ${JSON.stringify(sel)}`;
});
await step('rapid mode cycling stays consistent', async () => {
  const seen = [];
  for (let i = 0; i < 9; i++) {
    await page.evaluate(() => window.__mdr.app.registry.run('view.cycleMode'));
    await sleep(90);
    seen.push(await page.evaluate(() => ({ attr: document.querySelector('.mdr-app').dataset.mode, api: window.__mdr.app.layout.getMode(),
      st: document.querySelector('.mdr-statusbar__item[data-stat=mode]')?.textContent })));
  }
  const bad = seen.filter(s => s.attr !== s.api);
  expect(bad.length === 0, `layout attr and API disagree: ${JSON.stringify(bad)}`);
  return JSON.stringify(seen.map(s => s.attr));
});
finish('20-edge', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
