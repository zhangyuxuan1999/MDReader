import { launch, open, loadText, step, expect, finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(20000);
await open(page, '?mode=split');
await page.evaluate(() => { window.__outline = []; window.__mdr.app.bus.on('outline:changed', () => {}); });
await page.evaluate(() => { const p = window.__mdr.app.preview; const orig = p.applyOutline.bind(p); p.applyOutline = (it) => { window.__outline = it; return orig(it); }; });
// 3600 headings: 900 x (h1, h2, h3, h4)
const parts = [];
for (let i = 1; i <= 900; i++) parts.push(`# 一级 ${i}\n\n正文\n\n## 二级 ${i}\n\n正文\n\n### 三级 ${i}\n\n正文\n\n#### 四级 ${i}\n\n正文\n`);
await page.evaluate((t) => window.__mdr.loadText(t, 'toc.md'), parts.join('\n'));
await page.evaluate(() => window.__mdr.waitIdle());
await sleep(2000);
const info = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.mdr-toc__item')];
  const byLevel = {};
  for (const a of items) {
    const l = a.className.match(/--h(\d)/)?.[1] ?? '?';
    byLevel[l] ??= { total: 0, visible: 0 };
    byLevel[l].total++;
    const cs = getComputedStyle(a);
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && a.getClientRects().length) byLevel[l].visible++;
  }
  return { outlineEntries: window.__outline?.length ?? null, total: items.length, byLevel, hasCollapseUI: !!document.querySelector('.mdr-toc [aria-expanded], .mdr-toc__toggle, .mdr-toc details, .mdr-toc .is-collapsed') };
});
console.log(JSON.stringify(info));
await step('SPEC §5.7: with > 3000 outline entries, levels >= 3 are collapsed by default', async () => {
  expect((info.outlineEntries ?? info.total) > 3000, `only ${info.outlineEntries ?? info.total} outline entries (rendered items ${info.total})`);
  const deep = Object.entries(info.byLevel).filter(([l]) => Number(l) >= 3).reduce((a, [, v]) => a + v.visible, 0);
  expect(deep === 0,
    `outline has ${info.outlineEntries} entries (rendered TOC items ${info.total}); SPEC §5.7 says "levels >= 3 collapsed by default", but ${deep} of them are rendered and visible (per level ${JSON.stringify(info.byLevel)}); no collapse affordance found either (${info.hasCollapseUI})`);
});
await step('the TOC expand toggle is visible and reveals the deep levels', async () => {
  const btn = await page.evaluate(() => { const b = document.querySelector('.mdr-toc__expand'); if (!b) return null;
    const r = b.getBoundingClientRect(); return { txt: b.textContent, w: Math.round(r.width), h: Math.round(r.height), visible: !!b.getClientRects().length }; });
  expect(btn, 'no .mdr-toc__expand control for a > 3000-entry outline');
  expect(btn.visible && btn.w > 0, `expand toggle not visible: ${JSON.stringify(btn)}`);
  await page.click('.mdr-toc__expand');
  await sleep(1500);
  const after = await page.evaluate(() => ({ items: document.querySelectorAll('.mdr-toc__item').length,
    h3: document.querySelectorAll('.mdr-toc__item--h3').length, label: document.querySelector('.mdr-toc__expand')?.textContent }));
  expect(after.h3 > 0, `after clicking 「${btn.txt}」 the level-3 entries are still absent: ${JSON.stringify(after)}`);
  return `${JSON.stringify(btn)} -> ${JSON.stringify(after)}`;
});
finish('19-toc-collapse', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
