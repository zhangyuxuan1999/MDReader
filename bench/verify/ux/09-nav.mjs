// bench/verify/ux/09-nav.mjs — navigation landing accuracy (TOC click / #anchor) in the preview:
// heading offset from the preview top, first click vs second click, and after 全部渲染 (mountAll).
// Run: node bench/verify/ux/09-nav.mjs
import { launch, open, loadText, cursor, lineText, step, expect, check, measure, finish, sleep, getFailures } from './lib.mjs';
const { browser, page, errors } = await launch();
await open(page, '?mode=split');
const filler = Array.from({ length: 150 }, (_, i) => `填充段落 ${i + 1}：这是一段用来撑开文档高度的文字。Paragraph ${i + 1}.`).join('\n\n');
const DOC = `# 顶部\n\n[跳到第二节](#第二节)\n\n${filler}\n\n## 第二节\n\n段落二。\n\n${filler}\n\n## 第三节\n\n段落三。\n`;
await loadText(page, DOC, 'nav.md');
const headOff = (text) => page.evaluate((t) => {
  const sc = document.querySelector('.mdr-preview'); const sr = sc.getBoundingClientRect();
  const h = [...sc.querySelectorAll('h2')].find((e) => e.textContent.trim() === t);
  const pv = window.__mdr.app.preview.topVisible();
  const pending = sc.querySelectorAll('.md-block.is-pending').length;
  return {
    off: h ? +(h.getBoundingClientRect().top - sr.top).toFixed(0) : null,
    pvLine: pv.line, pendingBlocks: pending,
    // Since lead decision 1 the preview's scroll-past-end region is max(48px, 20vh) instead of 100vh, so a
    // heading inside the document's last screen can no longer be lifted all the way to the top edge: the
    // pane simply runs out of scroll range. `atMax` says the pane got as close as it physically can.
    atMax: sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 2,
    clientHeight: sc.clientHeight,
  };
}, text);
/** The landing is right when the heading is flush with the top edge — or, for a heading in the document's
 *  last screen, when the pane is at its maximum scroll and the heading is on screen (decision 1). */
const landed = (r) => r.off !== null && (Math.abs(r.off) <= 4 || (r.atMax && r.off >= 0 && r.off < r.clientHeight));
const target2 = await page.evaluate(() => { const d = window.__mdr.app.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (d.line(i).text === '## 第二节') return i; });
const target3 = await page.evaluate(() => { const d = window.__mdr.app.editor.view.state.doc; for (let i = 1; i <= d.lines; i++) if (d.line(i).text === '## 第三节') return i; });

await step('#anchor click #1 (cold, blocks pending): heading offset from preview top', async () => {
  await page.locator('.mdr-preview a', { hasText: '跳到第二节' }).click();
  await sleep(800);
  const r = await headOff('第二节');
  const c = await cursor(page);
  expect(c.line === target2, `editor cursor ${c.line}, want ${target2}`);
  measure('anchor click (cold) heading offset px', r.off ?? 'not mounted', '0 ± 4 px', landed(r));
  return JSON.stringify({ ...r, target: target2 });
});
await step('#anchor click #2 (same target, blocks now mounted)', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(300);
  await page.locator('.mdr-preview a', { hasText: '跳到第二节' }).click();
  await sleep(800);
  const r = await headOff('第二节');
  measure('anchor click (warm) heading offset px', r.off ?? 'not mounted', '0 ± 4 px', landed(r));
  return JSON.stringify(r);
});
await step('TOC click on 第三节 (cold): heading offset', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(300);
  await page.locator('.mdr-toc__item', { hasText: '第三节' }).click();
  await sleep(800);
  const r = await headOff('第三节');
  const c = await cursor(page);
  expect(c.line === target3, `editor cursor ${c.line}, want ${target3}`);
  // 第三节 is the document's LAST heading: with the modest tail the pane bottoms out before it reaches
  // the top edge, so the requirement is "as far as the scroll range allows, heading on screen".
  measure('TOC click (cold) last-heading landing', r.off ?? 'not mounted', 'top edge, or pane at max scroll', landed(r));
  return JSON.stringify({ ...r, target: target3 });
});
await step('TOC click on 第三节 after 全部渲染 (all blocks measured)', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await page.waitForFunction(() => document.querySelectorAll('.md-block.is-pending').length === 0, null, { timeout: 20000 });
  await sleep(300);
  await page.locator('.mdr-toc__item', { hasText: '第二节' }).click();
  await sleep(800);
  const r = await headOff('第二节');
  measure('TOC click (all mounted) heading offset px', r.off ?? 'not mounted', '0 ± 4 px', landed(r));
  return JSON.stringify(r);
});
await step('Editor-driven sync to the same heading (scroll editor so 第二节 is at top): preview offset', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  const edBox = await page.locator('.mdr-pane--editor').boundingBox();
  await page.mouse.move(edBox.x + 200, edBox.y + 300); await page.mouse.wheel(0, 1);
  await page.evaluate((l) => window.__mdr.app.editor.scrollToLine(l, 0), target2);
  await sleep(800);
  const r = await headOff('第二节');
  measure('editor→preview sync heading offset px (all mounted)', r.off ?? 'not mounted', '0 ± 30 px', r.off !== null && Math.abs(r.off) <= 30);
  return JSON.stringify(r);
});
finish('09-nav', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
