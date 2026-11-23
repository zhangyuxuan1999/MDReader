import { launch, open, loadText, step, expect, lineText, cursor, placeCursor,
         focusEditor, finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(8000);
await open(page, '?mode=split');
const DOC = ['# 标题','','alpha beta gamma','','delta beta epsilon','','- 项目一','- 项目二','','结尾行 beta'].join('\n');
await loadText(page, DOC, 'p.md');
await focusEditor(page);

// -------- command palette --------
const items = () => page.evaluate(() => [...document.querySelectorAll('.mdr-palette__item')].map(e => ({ t: e.textContent.trim(), sel: e.classList.contains('is-active') || e.getAttribute('aria-selected') === 'true' })));

await step('palette opens with Mod-Shift-p, input focused, lists all commands', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await sleep(250);
  const n = (await items()).length;
  const total = await page.evaluate(() => window.__mdr.app.registry.list().length);
  const focused = await page.evaluate(() => document.activeElement?.className);
  expect(n > 0, 'no items');
  expect(focused.includes('mdr-palette__input'), `activeElement=${focused}`);
  return `${n} items of ${total} commands, focus=${focused}`;
});
await step('palette fuzzy filter narrows the list', async () => {
  const before = (await items()).length;
  await page.keyboard.type('主题');
  await sleep(250);
  const after = await items();
  expect(after.length > 0 && after.length < before, `${before} -> ${after.length}`);
  expect(after.some(i => i.t.includes('切换主题')), JSON.stringify(after));
  return `${before} -> ${after.length}: ${JSON.stringify(after.map(i=>i.t))}`;
});
await step('palette fuzzy (non-contiguous) match works', async () => {
  await page.keyboard.press('Meta+a'); await page.keyboard.type('qhml');
  await sleep(250);
  const a = await items();
  await page.keyboard.press('Meta+a'); await page.keyboard.type('导HT');
  await sleep(250);
  const b = await items();
  return `"qhml" -> ${a.length}, "导HT" -> ${JSON.stringify(b.map(i=>i.t))}`;
});
await step('palette arrow keys move the selection', async () => {
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace');
  await sleep(250);
  const i0 = await items();
  const sel0 = i0.findIndex(i => i.sel);
  await page.keyboard.press('ArrowDown');
  await sleep(150);
  const i1 = await items();
  const sel1 = i1.findIndex(i => i.sel);
  expect(sel0 === 0, `initial selection index=${sel0}`);
  expect(sel1 === 1, `after ArrowDown index=${sel1}`);
  await page.keyboard.press('ArrowUp');
  await sleep(150);
  const sel2 = (await items()).findIndex(i => i.sel);
  expect(sel2 === 0, `after ArrowUp index=${sel2}`);
});
await step('palette Enter runs the selected command', async () => {
  await page.keyboard.type('切换主题');
  await sleep(250);
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.keyboard.press('Enter');
  await sleep(350);
  const openNow = await page.locator('.mdr-palette').isVisible().catch(() => false);
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(t1 !== t0, `theme unchanged ${t0}`);
  expect(!openNow, 'palette still open after Enter');
  await page.keyboard.press('Meta+Shift+l'); await sleep(200); // restore
});
await step('palette Esc closes and returns focus to the editor', async () => {
  await focusEditor(page);
  await placeCursor(page, 3, 4);
  await page.keyboard.press('Meta+Shift+p');
  await sleep(250);
  await page.keyboard.press('Escape');
  await sleep(300);
  const openNow = await page.locator('.mdr-palette').isVisible().catch(() => false);
  const hasFocus = await page.evaluate(() => window.__mdr.app.editor.hasFocus());
  expect(!openNow, 'palette still visible');
  expect(hasFocus, `editor.hasFocus()=false, activeElement=${await page.evaluate(() => document.activeElement?.className)}`);
});
await step('palette closes on outside click', async () => {
  await page.keyboard.press('Meta+Shift+p');
  await sleep(250);
  await page.mouse.click(30, 700);
  await sleep(300);
  const openNow = await page.locator('.mdr-palette').isVisible().catch(() => false);
  expect(!openNow, 'palette still visible after outside click');
});
await page.keyboard.press('Escape');

// -------- find / replace panel, zh-CN --------
await step('Mod-f find panel shows zh-CN labels', async () => {
  await focusEditor(page);
  await page.keyboard.press('Meta+f');
  await sleep(300);
  const info = await page.evaluate(() => {
    const p = document.querySelector('.cm-panel.cm-search');
    if (!p) return null;
    return {
      text: p.textContent,
      placeholders: [...p.querySelectorAll('input')].map(i => i.placeholder),
      buttons: [...p.querySelectorAll('button')].map(b => b.textContent.trim() || b.getAttribute('name') || b.title),
      labels: [...p.querySelectorAll('label')].map(l => l.textContent.trim()),
    };
  });
  expect(info, 'no search panel');
  const all = JSON.stringify(info);
  const hasCJK = /[一-鿿]/.test(info.text);
  expect(hasCJK, `panel has no Chinese text: ${all}`);
  const ascii = [...info.placeholders, ...info.buttons, ...info.labels].filter(s => s && /[A-Za-z]/.test(s) && !/[一-鿿]/.test(s));
  expect(ascii.length === 0, `untranslated (English) UI strings in the find panel: ${JSON.stringify(ascii)} — full panel ${all}`);
  return all;
});
await step('find highlights and Mod-g moves to the next match', async () => {
  await page.evaluate(() => { const i = document.querySelector('.cm-search input'); i.focus(); });
  await page.keyboard.type('beta');
  await sleep(400);
  const matches = await page.evaluate(() => document.querySelectorAll('.cm-searchMatch').length);
  await page.keyboard.press('Enter');
  await sleep(200);
  const c1 = await cursor(page);
  await page.keyboard.press('Meta+g');
  await sleep(250);
  const c2 = await cursor(page);
  expect(matches > 0, `no .cm-searchMatch elements (matches=${matches})`);
  expect(c2.line !== c1.line, `Mod-g did not advance: ${JSON.stringify(c1)} -> ${JSON.stringify(c2)}`);
  return `matches=${matches}, ${JSON.stringify(c1)} -> ${JSON.stringify(c2)}`;
});
await step('replace all works from the panel', async () => {
  const info = await page.evaluate(() => {
    const p = document.querySelector('.cm-panel.cm-search');
    return { html: p ? p.innerHTML.slice(0, 1200) : null };
  });
  const ok = await page.evaluate(() => {
    const p = document.querySelector('.cm-panel.cm-search');
    const inputs = [...p.querySelectorAll('input[type=text], input:not([type])')];
    if (inputs.length < 2) return 'only ' + inputs.length + ' text inputs';
    inputs[1].focus();
    return true;
  });
  expect(ok === true, `${ok}; panel=${info.html}`);
  await page.keyboard.type('ZETA');
  const btn = await page.evaluate(() => {
    const p = document.querySelector('.cm-panel.cm-search');
    const b = [...p.querySelectorAll('button')].find(b => /全部替换|替换全部|all/i.test(b.textContent + b.getAttribute('name')));
    if (!b) return null; b.click(); return b.textContent;
  });
  expect(btn !== null, 'no replace-all button found');
  await sleep(400);
  const txt = await page.evaluate(() => window.__mdr.app.getText());
  expect(!txt.includes('beta') && txt.includes('ZETA'), `text after replace all: ${JSON.stringify(txt)}`);
  return `button=${btn}`;
});
await page.keyboard.press('Escape');

// -------- goto line --------
await step('Mod-Alt-g jumps to the typed line', async () => {
  await loadText(page, Array.from({length: 60}, (_, i) => `第 ${i+1} 行内容`).join('\n'), 'g.md');
  await focusEditor(page);
  await placeCursor(page, 1, 0);
  await page.keyboard.press('Meta+Alt+g');
  await sleep(300);
  const has = await page.locator('.cm-panel.cm-gotoLine, .cm-goto-line').count();
  expect(has > 0, 'no goto-line panel');
  const zh = await page.evaluate(() => {
    const p = document.querySelector('.cm-panel');
    return { text: p.textContent, ascii: [...p.querySelectorAll('button,label')].map(e=>e.textContent.trim()).filter(s=>s && /[A-Za-z]/.test(s) && !/[一-鿿]/.test(s)) };
  });
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  await sleep(400);
  const c = await cursor(page);
  expect(c.line === 42, `cursor line=${c.line} want 42; panel=${JSON.stringify(zh)}`);
  expect(zh.ascii.length === 0, `untranslated strings in goto-line panel: ${JSON.stringify(zh.ascii)}`);
  return JSON.stringify(zh);
});

finish('04-palette-find-goto', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
