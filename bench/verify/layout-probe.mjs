// bench/verify/layout-probe.mjs — attribution for the 33 s main-thread task seen in big-para2.mjs:
// how long does Chromium take to lay out a 1 MB single-line CJK/latin text under the preview's CSS
// (`pre.md-code--plain code { white-space: pre-wrap }` inside `overflow-wrap: anywhere`)? Standalone page, no app.
// Run: node bench/verify/layout-probe.mjs
import { chromium } from '@playwright/test';

const unit = '这是一段很长的中文文本，用于测试 **加粗** 和 *斜体* 以及 `code` 和 [链接](https://example.com) 的渲染性能。The quick brown fox jumps over the lazy dog. ';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.setContent('<div id="root" style="width:600px;font:16px/1.75 -apple-system, PingFang SC, sans-serif"></div>');
const variants = [
  ['pre>code pre-wrap + overflow-wrap:anywhere (app CSS)', 'pre', 'white-space:pre-wrap;overflow-wrap:anywhere'],
  ['pre>code pre-wrap + overflow-wrap:break-word', 'pre', 'white-space:pre-wrap;overflow-wrap:break-word'],
  ['pre>code pre-wrap + word-break:break-all', 'pre', 'white-space:pre-wrap;word-break:break-all'],
  ['p normal + overflow-wrap:anywhere', 'p', 'overflow-wrap:anywhere'],
  ['p normal + overflow-wrap:break-word', 'p', 'overflow-wrap:break-word'],
];
for (const size of [100_000, 300_000, 1_000_000]) {
  let text = '';
  while (text.length < size) text += unit;
  for (const [name, tag, css] of variants) {
    const ms = await page.evaluate(({ text, tag, css }) => {
      const root = document.getElementById('root');
      root.replaceChildren();
      const el = document.createElement(tag);
      el.style.cssText = css + ';margin:0';
      if (tag === 'pre') { const c = document.createElement('code'); c.style.cssText = css; c.textContent = text; el.appendChild(c); } else el.textContent = text;
      root.appendChild(el);
      const t0 = performance.now();
      const h = el.getBoundingClientRect().height; // forces layout
      return { ms: performance.now() - t0, h };
    }, { text, tag, css });
    console.log(`${(size / 1000) | 0} KB  ${name}: layout ${ms.ms.toFixed(0)} ms (height ${ms.h | 0}px)`);
    if (ms.ms > 20_000) break;
  }
}
await browser.close();
