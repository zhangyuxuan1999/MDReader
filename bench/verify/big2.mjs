// bench/verify/big2.mjs — 1 MB single paragraph: PLAIN fallback (spec maxHtmlChars) and whether typed text
// eventually shows up (giant guard: 500 ms settle). Waits up to 15 s instead of checking right at idle.
// Run: node bench/verify/big2.mjs   (dev server on :5202)
import { openApp2, loadSettled, harness, finish, sleep } from './lib2.mjs';

const H = harness('big2');
const app = await openApp2();
const { page } = app;

const unit = '这是一段很长的中文文本，用于测试 **加粗** 和 *斜体* 以及 `code` 和 [链接](https://example.com) 的渲染性能。The quick brown fox jumps over the lazy dog. ';
let para = '';
while (para.length < 1_000_000) para += unit;
const doc = `# Big paragraph\n\n${para}\n\n## After\n\ntail\n`;
await loadSettled(page, doc, 'para1mb.md', { mountAll: false });
await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && !b.classList.contains('is-pending') && !b.classList.contains('is-slow'); }, null, { timeout: 30_000 });
const before = await page.evaluate(() => { const b = document.querySelectorAll('.md-block')[1]; return { cls: b.className, pieces: b.querySelectorAll('.md-plain__piece').length, textLen: b.textContent.length, first: b.firstElementChild?.className }; });
console.log('1 MB paragraph mounted:', JSON.stringify(before));
H.measure('1 MB paragraph rendered as PLAIN (raw markdown text, no inline markup)', before.first?.includes('md-plain') ? 'yes (spec maxHtmlChars=200000)' : 'no', 'spec-conformant, informational', true);

await page.evaluate(() => window.__mdr.app.editor.gotoLine(3, 20));
await page.keyboard.type('XYZ');
const t0 = Date.now();
const shown = await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && b.textContent.includes('XYZ') && !b.classList.contains('is-stale') && !b.classList.contains('is-slow'); }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
const after = await page.evaluate(() => { const b = document.querySelectorAll('.md-block')[1]; return { cls: b.className, hasTyped: b.textContent.includes('XYZ'), pieces: b.querySelectorAll('.md-plain__piece').length }; });
if (!shown) H.fail('1 MB paragraph: typed text never appears in the preview within 15 s', after);
else { H.pass('1 MB paragraph: typed text appears', `${Date.now() - t0} ms`); H.measure('1 MB paragraph: keystroke → preview shows typed text', `${Date.now() - t0} ms`, 'informational', true); }

// type a burst and check that the block is consistent at the end
await page.keyboard.type('ABCDEFGHIJ', { delay: 30 });
const shown2 = await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && b.textContent.includes('XYZABCDEFGHIJ') && !b.classList.contains('is-stale') && !b.classList.contains('is-slow'); }, null, { timeout: 15_000 }).then(() => true).catch(() => false);
if (!shown2) H.fail('1 MB paragraph: burst-typed text never appears within 15 s', await page.evaluate(() => document.querySelectorAll('.md-block')[1]?.className));
else H.pass('1 MB paragraph: burst-typed text appears');
const txt = await page.evaluate(() => ({ editor: window.__mdr.app.editor.getText().length, preview: document.querySelectorAll('.md-block')[1]?.textContent.length }));
console.log('lengths:', JSON.stringify(txt));

finish(H, app);
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
