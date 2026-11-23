import { launch, open, loadText, step, expect, finish, sleep, getFailures } from '../ux/lib.mjs';
const { browser, page, errors } = await launch();
page.setDefaultTimeout(10000);
await open(page, '?mode=split');
const LONG = 'const veryLongIdentifierName = someFunctionWithAVeryLongName(argumentOne, argumentTwo, argumentThree, argumentFour);';
await loadText(page, `# T\n\n\`\`\`ts\n${LONG}\n\`\`\`\n\n| 一 | 二 | 三 | 四 | 五 | 六 | 七 | 八 | 九 | 十 | 十一 | 十二 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n| aaaaaaaa | bbbbbbbb | cccccccc | dddddddd | eeeeeeee | ffffffff | gggggggg | hhhhhhhh | iiiiiiii | jjjjjjjj | kkkkkkkk | llllllll |\n\n很长的不可断词：aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n[一个非常长的链接](https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/forever/and/ever)\n`, 'o.md');
await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
await sleep(1000);

const info = await page.evaluate(() => {
  const g = (sel) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e);
    return { sel, scrollW: e.scrollWidth, clientW: e.clientWidth, overflowX: s.overflowX, whiteSpace: s.whiteSpace, wordBreak: s.wordBreak, overflowWrap: s.overflowWrap }; };
  const pv = document.querySelector('.mdr-preview');
  return {
    preview: { scrollW: pv.scrollWidth, clientW: pv.clientWidth, overflowX: getComputedStyle(pv).overflowX },
    pre: g('.mdr-preview pre'), table: g('.mdr-preview table'),
    tableWrap: (() => { const t = document.querySelector('.mdr-preview table'); const p = t?.parentElement; if (!p) return null; const s = getComputedStyle(p);
      return { tag: p.tagName, cls: p.className, scrollW: p.scrollWidth, clientW: p.clientWidth, overflowX: s.overflowX }; })(),
    longWordP: (() => { const ps = [...document.querySelectorAll('.mdr-preview p')].find(p => p.textContent.includes('aaaaaaaa')); if (!ps) return null;
      const s = getComputedStyle(ps); return { scrollW: ps.scrollWidth, clientW: ps.clientWidth, overflowWrap: s.overflowWrap, wordBreak: s.wordBreak }; })(),
    linkP: (() => { const a = [...document.querySelectorAll('.mdr-preview a')].find(a => a.href.includes('/forever/')); if (!a) return null;
      const p = a.closest('p'); const s = getComputedStyle(a); return { aScrollW: a.scrollWidth, pClientW: p.clientWidth, overflowWrap: s.overflowWrap, wordBreak: s.wordBreak }; })(),
  };
});
console.log(JSON.stringify(info, null, 1));

await step('preview itself never scrolls horizontally', async () => {
  expect(info.preview.scrollW <= info.preview.clientW + 1, JSON.stringify(info.preview));
});
await step('a long code line is scrollable inside its <pre> (not silently clipped)', async () => {
  expect(info.pre, 'no <pre>');
  const clipped = info.pre.scrollW > info.pre.clientW + 1 && !/auto|scroll/.test(info.pre.overflowX);
  expect(!clipped, `the fence is ${info.pre.scrollW}px wide inside a ${info.pre.clientW}px box but overflow-x is "${info.pre.overflowX}" — the tail of every long code line is unreachable: ${JSON.stringify(info.pre)}`);
  return JSON.stringify(info.pre);
});
await step('a wide table is scrollable, not clipped', async () => {
  const t = info.table, w = info.tableWrap;
  const scrollable = (w && w.scrollW > w.clientW + 1 && /auto|scroll/.test(w.overflowX)) || (t && /auto|scroll/.test(t.overflowX));
  const overflowing = (w && w.scrollW > w.clientW + 1) || (t && t.scrollW > t.clientW + 1);
  expect(!overflowing || scrollable, `wide table overflows without a scroll container: table=${JSON.stringify(t)} wrap=${JSON.stringify(w)}`);
  return JSON.stringify({ t, w });
});
await step('long unbreakable words wrap instead of overflowing', async () => {
  expect(info.longWordP, 'paragraph not found');
  expect(info.longWordP.scrollW <= info.longWordP.clientW + 1, JSON.stringify(info.longWordP));
});
await step('long URLs wrap instead of overflowing', async () => {
  expect(info.linkP, 'link not found');
  expect(info.linkP.aScrollW <= info.linkP.pClientW + 1, JSON.stringify(info.linkP));
});
finish('16-overflow', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
