// bench/verify/05-visual.mjs — screenshots at 1400x900 and 1000x700, light + dark, plus overlays;
// computed-style checks (fonts, line-height, contrast).  Run: node bench/verify/05-visual.mjs
import { mkdirSync } from 'node:fs';
import { launch, open, loadText, placeCursor, step, expect, check, finish, sleep, getFailures, BASE } from './lib.mjs';

const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/ux/shots';
mkdirSync(OUT, { recursive: true });
const { browser, context, page, errors } = await launch();

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
await open(page, '');

for (const theme of ['light', 'dark']) {
  for (const [w, h] of [[1400, 900], [1000, 700]]) {
    await step(`screenshot split ${theme} ${w}x${h}`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((t) => localStorage.setItem('mdr.theme', t), theme);
      await open(page, '?doc=/test-data/small.md&mode=split');
      await placeCursor(page, 12, 3);
      await sleep(300);
      await shot(`split-${theme}-${w}x${h}`);
    });
  }
}
await page.setViewportSize({ width: 1400, height: 900 });
await step('screenshot preview mode dark + edit mode light', async () => {
  await page.click('.mdr-toolbar__btn[data-cmd="view.mode.preview"]');
  await sleep(200);
  await shot('preview-dark-1400x900');
  await page.evaluate(() => localStorage.setItem('mdr.theme', 'light'));
  await open(page, '?doc=/test-data/small.md&mode=edit');
  await sleep(200);
  await shot('edit-light-1400x900');
});
await step('screenshot overlays: palette, search panel, dialog, toast, dragover (light)', async () => {
  await open(page, '?doc=/test-data/small.md&mode=split');
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await page.keyboard.type('标');
  await sleep(100);
  await shot('palette-light');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+f');
  await page.waitForSelector('.cm-search');
  await page.locator('.cm-search input[name="search"]').fill('性能');
  await sleep(150);
  await shot('search-light');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Alt+g');
  await page.waitForSelector('.cm-goto-line');
  await shot('gotoline-light');
  await page.keyboard.press('Escape');
  await page.keyboard.type('x');
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await page.waitForSelector('.mdr-dialog');
  await shot('dialog-light');
  await page.click('.mdr-dialog__btn:has-text("取消")');
  await page.evaluate(() => window.__mdr.app.bus.emit('toast', { text: '发现未保存的草稿，是否恢复？', actions: [{ label: '恢复', run() {} }, { label: '丢弃', run() {} }] }));
  await page.evaluate(() => window.__mdr.app.bus.emit('toast', { text: '保存失败：需要重新授权访问该文件', kind: 'error' }));
  await sleep(250);
  await shot('toasts-light');
  await page.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
  await page.evaluate(() => document.querySelector('.mdr-app').classList.add('is-dragover'));
  await shot('dragover-light');
  await page.evaluate(() => document.querySelector('.mdr-app').classList.remove('is-dragover'));
  await page.click('.mdr-toolbar__file');
  await sleep(150);
  await shot('recent-menu-light');
  await page.keyboard.press('Escape');
});
await step('screenshot overlays dark: palette + dialog + toasts', async () => {
  await page.evaluate(() => localStorage.setItem('mdr.theme', 'dark'));
  await open(page, '?doc=/test-data/small.md&mode=split');
  await page.click('.cm-content');
  await page.keyboard.press('Meta+Shift+p');
  await page.waitForSelector('.mdr-palette:not([hidden])');
  await sleep(100);
  await shot('palette-dark');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+f');
  await page.waitForSelector('.cm-search');
  await page.locator('.cm-search input[name="search"]').fill('性能');
  await sleep(150);
  await shot('search-dark');
  await page.keyboard.press('Escape');
  await page.keyboard.type('x');
  await page.click('.mdr-toolbar__btn[data-cmd="file.new"]');
  await page.waitForSelector('.mdr-dialog');
  await page.evaluate(() => window.__mdr.app.bus.emit('toast', { text: '发现未保存的草稿，是否恢复？', actions: [{ label: '恢复', run() {} }, { label: '丢弃', run() {} }] }));
  await sleep(250);
  await shot('dialog-toast-dark');
  await page.click('.mdr-dialog__btn:has-text("取消")');
});
await step('screenshot rich content (code, table, math, quote, task list, html) light+dark', async () => {
  const doc = `# 富文本 Rich content\n\n中文段落与 English 混排，**加粗**、*斜体*、\`code\`、[链接](https://example.com)、~~删除~~。这是一个很长的中文段落，用来检查中日韩文字的行高与换行是否合理，字距是否均匀，标点是否挤压。The quick brown fox jumps over the lazy dog.\n\n## 代码\n\n\`\`\`ts\nexport function add(a: number, b: number): number {\n  // 注释 comment\n  const s = "字符串";\n  return a + b;\n}\n\`\`\`\n\n## 表格\n\n| 列一 | Column 2 | 数值 |\n|---|---|---:|\n| 甲 | alpha | 1.0 |\n| 乙 | beta | 22.5 |\n\n## 公式\n\n行内 $E = mc^2$ 与块级：\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n## 引用与列表\n\n> 引用块：性能是一种特性。\n\n- 项目一\n  - 嵌套项目\n- [ ] 待办\n- [x] 已完成\n\n1. 第一\n2. 第二\n\n<details><summary>HTML 折叠</summary>内容</details>\n\n---\n\n![image](https://example.com/x.png)\n`;
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('mdr.theme', t), theme);
    await open(page, '?mode=split');
    await loadText(page, doc, 'rich.md');
    await sleep(600);
    await shot(`rich-${theme}`);
  }
});
await step('Computed styles: fonts, sizes, line-height, CJK', async () => {
  const s = await page.evaluate(() => {
    const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
    const pv = cs('.mdr-preview__body p');
    const cm = cs('.cm-content');
    const code = cs('.mdr-preview__body pre code');
    const toc = cs('.mdr-toc__item');
    const status = cs('.mdr-statusbar');
    return {
      previewFont: pv?.fontFamily, previewSize: pv?.fontSize, previewLH: pv?.lineHeight,
      cmFont: cm?.fontFamily, cmSize: cm?.fontSize, cmLH: cm?.lineHeight,
      codeFont: code?.fontFamily, codeSize: code?.fontSize,
      tocSize: toc?.fontSize, statusSize: status?.fontSize,
      h1: cs('.mdr-preview__body h1')?.fontSize, h2: cs('.mdr-preview__body h2')?.fontSize,
      katex: !!document.querySelector('.katex'), hljs: !!document.querySelector('.hljs-keyword'), table: !!document.querySelector('.mdr-preview__body table'),
      checkbox: [...document.querySelectorAll('.mdr-preview__body input[type=checkbox]')].map((i) => ({ checked: i.checked, disabled: i.disabled })),
      details: !!document.querySelector('.mdr-preview__body details'),
      img: document.querySelector('.mdr-preview__body img')?.getAttribute('loading'),
    };
  });
  expect(s.previewFont?.includes('PingFang'), `preview font ${s.previewFont}`);
  expect(parseFloat(s.previewLH) / parseFloat(s.previewSize) >= 1.6, `preview line-height ${s.previewLH} / ${s.previewSize}`);
  expect(s.katex && s.hljs && s.table, `katex=${s.katex} hljs=${s.hljs} table=${s.table}`);
  expect(s.checkbox.length === 2 && !s.checkbox[0].disabled, `checkboxes ${JSON.stringify(s.checkbox)}`);
  return JSON.stringify(s);
});
await step('Contrast: fg/bg of key surfaces in both themes', async () => {
  const lum = (rgb) => { const m = rgb.match(/\d+(\.\d+)?/g).map(Number); const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  const out = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('mdr.theme', t), theme);
    await open(page, '?doc=/test-data/small.md&mode=split');
    await sleep(200);
    const c = await page.evaluate(() => {
      const g = (sel, prop = 'color') => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
      const bg = (sel) => { let e = document.querySelector(sel); while (e) { const b = getComputedStyle(e).backgroundColor; if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b; e = e.parentElement; } return getComputedStyle(document.body).backgroundColor; };
      return {
        previewText: [g('.mdr-preview__body p'), bg('.mdr-preview__body p')],
        editorText: [g('.cm-content'), bg('.cm-content')],
        gutter: [g('.cm-gutterElement'), bg('.cm-gutters')],
        status: [g('.mdr-statusbar'), bg('.mdr-statusbar')],
        toc: [g('.mdr-toc__item'), bg('.mdr-toc__item')],
        tocActive: [g('.mdr-toc__item.is-active') ?? g('.mdr-toc__item'), bg('.mdr-toc__item')],
        code: [g('.mdr-preview__body pre code'), bg('.mdr-preview__body pre')],
        link: [g('.mdr-preview__body a'), bg('.mdr-preview__body p')],
        muted: [g('.mdr-toolbar__file'), bg('.mdr-toolbar')],
        toolbarBtn: [g('.mdr-toolbar__btn'), bg('.mdr-toolbar__btn')],
      };
    });
    for (const [k, [fg, b]] of Object.entries(c)) {
      if (!fg || !b) continue;
      const r = ratio(fg, b);
      out.push(`${theme}.${k}=${r.toFixed(2)}`);
      check(`contrast ${theme} ${k} ≥ 4.5 (AA)`, r >= 4.5, `${r.toFixed(2)} (${fg} on ${b})`);
    }
  }
  return out.join(' ');
});

finish('05-visual', errors);
await browser.close();
process.exit(getFailures() ? 1 : 0);
