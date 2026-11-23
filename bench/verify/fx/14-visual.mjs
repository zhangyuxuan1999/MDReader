import { chromium } from '@playwright/test';
import fs from 'node:fs';
const BASE = 'http://localhost:5203/';
const OUT = '/Users/zyx/LocalDocuments/MDReader/bench/verify/fx/shots';
fs.mkdirSync(OUT, { recursive: true });

const DOC = `# MDReader 视觉检查 Visual Check

这是一段中文段落，用来检查 CJK 字体、行高与混排 Latin text 的排版效果。中文标点：「引号」、（括号）、——破折号。

## 二级标题 Level 2

> 引用块 blockquote：这是一段引用的中文文字，用于检查左边框与内边距。

- 无序列表项一
- 无序列表项二
  - 嵌套项
- [ ] 未完成任务
- [x] 已完成任务

1. 有序一
2. 有序二

| 列一 | 列二 Column | 数值 |
|---|---:|---:|
| 中文单元格 | mixed 混排 | 1234 |
| 第二行 | value | 5678 |

\`\`\`ts
interface Block { id: number; startLine: number; kind: BlockKind }
export function segment(lines: string[]): Block[] {
  // 中文注释 comment
  return lines.map((l, i) => ({ id: i, startLine: i + 1, kind: 0 }));
}
\`\`\`

行内代码 \`const x = 1\` 与**加粗**、*斜体*、~~删除线~~、[链接](https://example.com)。

数学公式：$E = mc^2$ 与块级：

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

### 三级标题

---

最后一段落。The quick brown fox jumps over the lazy dog. 0123456789.
`;

const shot = async (name, { width, height, theme, mode = 'split', extra }) => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.addInitScript((t) => { localStorage.setItem('mdr.theme', t); }, theme);
  await page.goto(`${BASE}?mode=${mode}`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate((t) => window.__mdr.loadText(t, '视觉检查.md'), DOC);
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
  await new Promise(r => setTimeout(r, 1200));
  if (extra) await extra(page);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  // gather typography metrics
  const metrics = await page.evaluate(() => {
    const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e);
      return { font: s.fontFamily.slice(0, 60), size: s.fontSize, lh: s.lineHeight, color: s.color, bg: s.backgroundColor }; };
    return {
      html: { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor },
      previewP: pick('.mdr-preview p'), h1: pick('.mdr-preview h1'), code: pick('.mdr-preview pre code'),
      inlineCode: pick('.mdr-preview p code'), table: pick('.mdr-preview table td'),
      cm: pick('.cm-content'), toc: pick('.mdr-toc__item'), status: pick('.mdr-statusbar'),
      katex: document.querySelectorAll('.mdr-preview .katex').length,
      hljsSpans: document.querySelectorAll('.mdr-preview .hljs-keyword, .mdr-preview .hljs-string').length,
      taskInputs: document.querySelectorAll('.mdr-preview input[type=checkbox]').length,
      tables: document.querySelectorAll('.mdr-preview table').length,
      overflowX: (() => { const p = document.querySelector('.mdr-preview'); return p.scrollWidth - p.clientWidth; })(),
    };
  });
  console.log(name, JSON.stringify(metrics));
  if (errs.length) console.log(`  ${name} ERRORS:`, [...new Set(errs)].slice(0,5).join(' | '));
  await browser.close();
  return file;
};

const scrollBottom = async (p) => { await p.evaluate(() => { const e = window.__mdr.app.preview.el; e.scrollTop = e.scrollHeight; const cm = window.__mdr.app.editor.view.scrollDOM; cm.scrollTop = cm.scrollHeight; }); await new Promise(r=>setTimeout(r,900)); };
await shot('bottom-light', { width: 1400, height: 900, theme: 'light', extra: scrollBottom });
await shot('bottom-dark', { width: 1400, height: 900, theme: 'dark', extra: scrollBottom });
await shot('1400x900-light', { width: 1400, height: 900, theme: 'light' });
await shot('1400x900-dark',  { width: 1400, height: 900, theme: 'dark' });
await shot('1000x700-light', { width: 1000, height: 700, theme: 'light' });
await shot('1000x700-dark',  { width: 1000, height: 700, theme: 'dark' });
await shot('1400x900-preview-light', { width: 1400, height: 900, theme: 'light', mode: 'preview' });
await shot('1400x900-edit-dark', { width: 1400, height: 900, theme: 'dark', mode: 'edit' });
await shot('1400x900-palette-light', { width: 1400, height: 900, theme: 'light', extra: async (p) => { await p.keyboard.press('Meta+Shift+p'); await new Promise(r=>setTimeout(r,400)); } });
await shot('1400x900-find-dark', { width: 1400, height: 900, theme: 'dark', extra: async (p) => { await p.click('.cm-content'); await p.keyboard.press('Meta+f'); await new Promise(r=>setTimeout(r,400)); } });
console.log('shots in', OUT);
