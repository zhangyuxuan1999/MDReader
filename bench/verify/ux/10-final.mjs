// bench/verify/ux/10-final.mjs — global shortcuts with focus outside the editor; edit→split keeps the top line.
// Run: node bench/verify/ux/10-final.mjs
import { launch, open, step, expect, check, finish, sleep, getFailures } from './lib.mjs';
const { browser, page, errors } = await launch();
await open(page, '?doc=/test-data/small.md&mode=split');
const mode = () => page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
await step('Global shortcuts work with focus on the preview pane / body (Mod-/, Mod-Shift-o, Mod-Shift-l, Mod-Shift-p)', async () => {
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  const active = await page.evaluate(() => document.activeElement?.tagName);
  await page.keyboard.press('Meta+/');
  await sleep(80);
  expect((await mode()) === 'preview', `Mod-/ from ${active}: mode ${await mode()}`);
  await page.keyboard.press('Meta+/'); await page.keyboard.press('Meta+/'); await sleep(80);
  expect((await mode()) === 'split', `mode ${await mode()}`);
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  await page.keyboard.press('Meta+Shift+o'); await sleep(50);
  expect((await page.evaluate(() => document.querySelector('.mdr-app').dataset.toc)) === 'closed', 'Mod-Shift-o from preview did not close TOC');
  await page.keyboard.press('Meta+Shift+o'); await sleep(50);
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  await page.keyboard.press('Meta+Shift+l'); await sleep(50);
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'Mod-Shift-l from preview did not toggle theme');
  await page.keyboard.press('Meta+Shift+l'); await sleep(50);
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  await page.keyboard.press('Meta+Shift+p');
  const pal = await page.waitForSelector('.mdr-palette:not([hidden])', { timeout: 1500 }).then(() => true).catch(() => false);
  expect(pal, 'Mod-Shift-p from preview did not open palette');
  await page.keyboard.press('Escape');
  return `focus was on ${active}`;
});
await step('Mod-b / Mod-f (editor-scope) with focus on the preview pane: behaviour', async () => {
  await page.click('.mdr-preview', { position: { x: 300, y: 300 } });
  const before = await page.evaluate(() => window.__mdr.app.getText());
  await page.keyboard.press('Meta+b'); await sleep(50);
  const after = await page.evaluate(() => window.__mdr.app.getText());
  check('Editor-scope Mod-b with focus on preview leaves the document unchanged', before === after, 'doc changed');
  await page.keyboard.press('Meta+f');
  const open = await page.waitForSelector('.cm-search', { timeout: 1000 }).then(() => true).catch(() => false);
  check('Mod-f with focus on preview opens the editor search panel (SPEC §13: Cmd+F routed to editor search)', open, 'no search panel');
  if (open) await page.keyboard.press('Escape');
});
await step('edit → split keeps the editor top line in the preview', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.edit"]');
  await sleep(100);
  await page.evaluate(() => window.__mdr.app.editor.scrollToLine(600, 0));
  await sleep(300);
  const ed = await page.evaluate(() => window.__mdr.app.editor.topVisible());
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.split"]');
  await sleep(800);
  const pv = await page.evaluate(() => window.__mdr.app.preview.topVisible());
  const ed2 = await page.evaluate(() => window.__mdr.app.editor.topVisible());
  expect(Math.abs(pv.line - ed.line) <= 3, `editor top ${ed.line} → preview top ${pv.line} (editor now ${ed2.line})`);
  return `editor ${ed.line} → preview ${pv.line}`;
});
finish('10-final', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
