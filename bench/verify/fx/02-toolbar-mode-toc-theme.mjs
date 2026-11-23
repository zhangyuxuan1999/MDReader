import { launch, open, loadText, check, step, expect, lineText, placeCursor,
         focusEditor, finish, sleep, getFailures, measure } from '../ux/lib.mjs';

const { browser, page, errors } = await launch();
page.setDefaultTimeout(8000);
page.on('download', d => d.saveAs('/tmp/mdr-dl-' + Date.now() + '-' + d.suggestedFilename()).catch(()=>{}));
await open(page, '?mode=split');

const DOC = ['# 第一章','','正文一。','','## 第二节','','正文二。','','### 三级','','正文三。'].join('\n');
await loadText(page, DOC, 't.md');

// ---- every toolbar button runs ----
const btns = await page.evaluate(() => [...document.querySelectorAll('.mdr-toolbar__btn')].map(b => b.dataset.cmd));
await step('toolbar exposes buttons', async () => expect(btns.length >= 10, `only ${btns.length}`) );

for (const cmd of btns) {
  if (cmd === 'file.open' || cmd === 'file.new' || cmd === 'file.save' || cmd === 'file.saveAs') continue;
  await step(`toolbar button ${cmd} clicks without error`, async () => {
    const before = errors.length;
    await placeCursor(page, 3, 1);
    await page.click(`.mdr-toolbar__btn[data-cmd="${cmd}"]`, { timeout: 5000 });
    await sleep(250);
    // dismiss anything modal the command opened so the next click is not blocked
    await page.keyboard.press('Escape');
    await sleep(150);
    const newErrs = errors.slice(before);
    expect(newErrs.length === 0, newErrs.join(' | '));
  });
}
// restore state
await page.evaluate(() => { window.__mdr.mode('split'); });
await loadText(page, DOC, 't.md');

// ---- icons render (buttons that have no text must have an svg/icon) ----
await step('toolbar buttons have visible glyphs', async () => {
  const bad = await page.evaluate(() => [...document.querySelectorAll('.mdr-toolbar__btn')]
    .filter(b => !b.textContent.trim() && !b.querySelector('svg,img') && !getComputedStyle(b,'::before').content.replace(/["']/g,'').trim())
    .map(b => b.dataset.cmd));
  expect(bad.length === 0, `empty buttons: ${JSON.stringify(bad)}`);
});

// ---- mode buttons reflect state ----
for (const [cmd, mode] of [['view.mode.edit','edit'],['view.mode.preview','preview'],['view.mode.split','split']]) {
  await step(`${cmd} sets data-mode=${mode} and aria-pressed`, async () => {
    await page.click(`.mdr-toolbar__btn[data-cmd="${cmd}"]`);
    await sleep(200);
    const st = await page.evaluate((c) => ({
      mode: document.querySelector('.mdr-app').dataset.mode,
      pressed: document.querySelector(`.mdr-toolbar__btn[data-cmd="${c}"]`).getAttribute('aria-pressed'),
      editorVisible: !!document.querySelector('.mdr-pane--editor')?.getClientRects().length,
      previewVisible: !!document.querySelector('.mdr-pane--preview')?.getClientRects().length,
    }), cmd);
    expect(st.mode === mode, `data-mode=${st.mode}`);
    expect(st.pressed === 'true', `aria-pressed=${st.pressed}`);
    if (mode === 'edit') expect(st.editorVisible && !st.previewVisible, JSON.stringify(st));
    if (mode === 'preview') expect(!st.editorVisible && st.previewVisible, JSON.stringify(st));
    if (mode === 'split') expect(st.editorVisible && st.previewVisible, JSON.stringify(st));
  });
}

// ---- mode persists across reload ----
await step('mode persists across reload (preview)', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await sleep(200);
  await page.reload();
  await page.waitForFunction(() => !!window.__mdr);
  await sleep(300);
  const m = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  expect(m === 'preview', `after reload mode=${m}`);
});
await page.evaluate(() => window.__mdr.mode('split'));
await sleep(200);

// ---- theme toggle persisted + applied before first paint ----
await step('theme toggle changes data-theme and persists in LS', async () => {
  const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]');
  await sleep(200);
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  const ls = await page.evaluate(() => localStorage.getItem('mdr.theme'));
  expect(t0 !== t1, `theme unchanged (${t1})`);
  expect(ls === t1, `LS mdr.theme=${ls} but data-theme=${t1}`);
  return `${t0} -> ${t1}, LS=${ls}`;
});
await step('theme applied on <html> IMMEDIATELY after navigation (no flash)', async () => {
  const want = await page.evaluate(() => localStorage.getItem('mdr.theme'));
  // Read data-theme as early as the document element exists.
  const ctx = page.context();
  const p2 = await ctx.newPage();
  let early = null;
  await p2.addInitScript(() => {
    const read = () => { if (document.documentElement) window.__earlyTheme = document.documentElement.dataset.theme ?? '(unset)'; };
    document.addEventListener('readystatechange', read, true);
    new MutationObserver(() => {}).observe(document, {subtree:false, childList:false}) ;
  });
  await p2.goto('http://localhost:5203/?mode=split', { waitUntil: 'commit' });
  // Sample data-theme as soon as the first paint-relevant state is available:
  early = await p2.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), state: document.readyState }));
  const bg = await p2.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  await p2.close();
  expect(early.attr === want, `right after navigation data-theme=${early.attr} (readyState ${early.state}) but stored pref is ${want}; bg=${bg}`);
  return `data-theme=${early.attr} at readyState=${early.state}`;
});
// reset theme
await page.evaluate(() => localStorage.removeItem('mdr.theme'));

// ---- TOC show/hide, click navigation, active following ----
await page.reload(); await page.waitForFunction(() => !!window.__mdr); await page.evaluate(()=>window.__mdr.waitIdle());
await page.evaluate(() => window.__mdr.mode('split')); await sleep(200);
await loadText(page, DOC, 't.md');

await step('TOC toggle hides/shows and persists', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  await sleep(200);
  const hidden = await page.evaluate(() => ({ attr: document.querySelector('.mdr-app').dataset.toc, visible: !!document.querySelector('.mdr-pane--toc')?.getClientRects().length, ls: localStorage.getItem('mdr.toc') }));
  expect(hidden.attr !== 'open' && !hidden.visible, JSON.stringify(hidden));
  await page.reload(); await page.waitForFunction(() => !!window.__mdr); await sleep(300);
  const after = await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc);
  expect(after !== 'open', `after reload data-toc=${after}`);
  await page.click('.mdr-toolbar__btn[data-cmd="view.toggleToc"]');
  await sleep(200);
});
await page.evaluate(() => window.__mdr.mode('split'));
await loadText(page, DOC, 't.md');

await step('TOC lists all headings with correct levels', async () => {
  const items = await page.evaluate(() => [...document.querySelectorAll('.mdr-toc__item')].map(a => ({ t: a.textContent, l: a.className.match(/--h(\d)/)?.[1], line: a.dataset.line })));
  expect(items.length === 3, `items=${JSON.stringify(items)}`);
  expect(items[0].l === '1' && items[1].l === '2' && items[2].l === '3', JSON.stringify(items));
  return JSON.stringify(items);
});
await step('TOC click navigates editor + preview', async () => {
  await page.click('.mdr-toc__item[data-line="9"]');
  await sleep(500);
  const st = await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    const l = v.state.doc.lineAt(v.state.selection.main.head).number;
    return { line: l, previewTop: window.__mdr.app.preview.topVisible() };
  });
  expect(st.line === 9, `editor cursor line=${st.line} want 9`);
  expect(Math.abs(st.previewTop.line - 9) <= 1, `preview top line=${JSON.stringify(st.previewTop)}`);
  return JSON.stringify(st);
});
await step('TOC active item follows the cursor', async () => {
  await placeCursor(page, 11, 0);
  await sleep(400);
  let act = await page.evaluate(() => document.querySelector('.mdr-toc__item.is-active')?.dataset.line);
  expect(act === '9', `active=${act} want 9`);
  await placeCursor(page, 3, 0);
  await sleep(400);
  act = await page.evaluate(() => document.querySelector('.mdr-toc__item.is-active')?.dataset.line);
  expect(act === '1', `active=${act} want 1`);
});

finish('02-toolbar-mode-toc-theme', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
