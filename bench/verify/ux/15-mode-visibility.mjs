// bench/verify/ux/15-mode-visibility.mjs — mode switches via toolbar buttons and Mod-/: is the editor
// visible/usable again after preview → split / preview → edit? Position kept on split → preview?
// Run: node bench/verify/ux/15-mode-visibility.mjs
import { launch, open, step, expect, check, finish, sleep, getFailures } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
const { browser, page, errors } = await launch();
await open(page, '?doc=/test-data/small.md&mode=split');

const state = () => page.evaluate(() => {
  const vis = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: +r.width.toFixed(0), h: +r.height.toFixed(0), display: cs.display, visibility: cs.visibility, opacity: cs.opacity }; };
  return {
    mode: document.querySelector('.mdr-app').dataset.mode,
    editorPane: vis('.mdr-pane--editor'), cmEditor: vis('.cm-editor'), cmContent: vis('.cm-content'), cmScroller: vis('.cm-scroller'),
    previewPane: vis('.mdr-pane--preview'),
    edTop: window.__mdr.app.editor.topVisible(), pvTop: window.__mdr.app.preview.topVisible(),
    pvScrollTop: document.querySelector('.mdr-preview').scrollTop,
  };
});

await step('split → preview (button) → split (button): editor visible and clickable again', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await sleep(400);
  const a = await state();
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  await sleep(400);
  const b = await state();
  await page.screenshot({ path: `${OUT}/after-preview-to-split.png` });
  expect(b.mode === 'split', `mode ${b.mode}`);
  expect(b.editorPane.w > 100 && b.cmContent.h > 50 && b.cmContent.display !== 'none', `editor not visible after preview→split: ${JSON.stringify(b)}`);
  let clicked = 'ok';
  try { await page.click('.cm-content', { position: { x: 100, y: 100 }, timeout: 3000 }); } catch (e) { clicked = e.message.split('\n')[0]; }
  expect(clicked === 'ok', `click on .cm-content: ${clicked}; state ${JSON.stringify(b)}`);
  return `preview: ${JSON.stringify(a.cmContent)} → split: ${JSON.stringify(b.cmContent)}`;
});

await step('split → preview via Mod-/ keeps the reading position (scrolled to ~line 600)', async () => {
  await page.evaluate(() => window.__mdr.app.editor.scrollToLine(600, 0));
  await sleep(400);
  const before = await state();
  await page.keyboard.press('Meta+/');
  await sleep(600);
  const after = await state();
  expect(after.mode === 'preview', `mode ${after.mode}`);
  expect(Math.abs(after.pvTop.line - before.edTop.line) <= 3, `editor top ${before.edTop.line} → preview top ${after.pvTop.line}`);
  return `editor ${before.edTop.line} → preview ${after.pvTop.line}`;
});
await step('preview → edit via Mod-/ keeps the reading position and shows the editor', async () => {
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 3000);
  await sleep(400);
  const before = await state();
  await page.keyboard.press('Meta+/');
  await sleep(600);
  const after = await state();
  expect(after.mode === 'edit', `mode ${after.mode}`);
  expect(after.cmContent && after.cmContent.h > 50 && after.editorPane.w > 100, `editor hidden in edit mode: ${JSON.stringify(after)}`);
  expect(Math.abs(after.edTop.line - before.pvTop.line) <= 3, `preview top ${before.pvTop.line} → editor top ${after.edTop.line}`);
  let clicked = 'ok';
  try { await page.click('.cm-content', { position: { x: 100, y: 100 }, timeout: 3000 }); } catch (e) { clicked = e.message.split('\n')[0]; }
  expect(clicked === 'ok', `click on .cm-content: ${clicked}`);
  return `preview ${before.pvTop.line} → editor ${after.edTop.line}`;
});
await step('edit → split via Mod-/: both panes visible, preview follows', async () => {
  const before = await state();
  await page.keyboard.press('Meta+/');
  await sleep(800);
  const after = await state();
  expect(after.mode === 'split', `mode ${after.mode}`);
  expect(after.editorPane.w > 100 && after.previewPane.w > 100, JSON.stringify(after));
  expect(Math.abs(after.pvTop.line - before.edTop.line) <= 3, `editor top ${before.edTop.line} → preview top ${after.pvTop.line}`);
  return `editor ${before.edTop.line} → preview ${after.pvTop.line}`;
});
await step('Repeat preview → split via buttons 3× (flakiness check)', async () => {
  const out = [];
  for (let i = 0; i < 3; i++) {
    await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
    await sleep(300);
    await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
    await sleep(300);
    const s = await state();
    out.push(`${s.mode}:${s.cmContent?.h}`);
    expect(s.mode === 'split' && s.cmContent?.h > 50, `iteration ${i}: ${JSON.stringify(s)}`);
  }
  return out.join(' ');
});

finish('15-mode-visibility', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
