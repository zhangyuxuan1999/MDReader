// bench/verify/big-para.mjs — 1 MB single paragraph: where does the settle time go, and does typed text show up?
// Run: node bench/verify/big-para.mjs   (dev server on :5202)
import { openApp, harness, sleep } from './lib.mjs';

const H = harness('bigpara');
const app = await openApp();
const { page } = app;

const unit = '这是一段很长的中文文本，用于测试 **加粗** 和 *斜体* 以及 `code` 和 [链接](https://example.com) 的渲染性能。The quick brown fox jumps over the lazy dog. ';
let para = '';
while (para.length < 1_000_000) para += unit;
const doc = `# Big paragraph\n\n${para}\n\n## After\n\ntail\n`;

const phases = {};
let t = Date.now();
await page.evaluate(async (d) => { await window.__mdr.loadText(d, 'para1mb.md'); }, doc);
phases.loadText = Date.now() - t;
t = Date.now();
await page.evaluate(() => window.__mdr.waitIdle());
phases.workerIdle = Date.now() - t;
t = Date.now();
await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && !b.classList.contains('is-pending') && !b.classList.contains('is-slow'); }, null, { timeout: 120_000 });
phases.bigBlockMounted = Date.now() - t;
const state = await page.evaluate(() => Array.from(document.querySelectorAll('.md-block')).map((b) => ({ id: b.dataset.id, cls: b.className, tag: b.firstElementChild?.tagName, cls2: b.firstElementChild?.className, len: b.textContent.length })));
console.log('phases (ms):', JSON.stringify(phases), 'blocks:', JSON.stringify(state));
H.measure('1 MB paragraph: loadText → worker idle', `${phases.loadText + phases.workerIdle} ms`, 'informational (P3 idle < 20 s)', phases.loadText + phases.workerIdle < 20_000);
H.measure('1 MB paragraph: idle → big block mounted', `${phases.bigBlockMounted} ms`, 'informational', true);

// typing at the start of the big paragraph
await page.evaluate(() => window.__mdr.app.editor.gotoLine(3, 1));
await page.evaluate(() => { window.__lat = []; window.addEventListener('keydown', () => { const t0 = performance.now(); requestAnimationFrame(() => window.__lat.push(performance.now() - t0)); }, true); });
t = Date.now();
await page.keyboard.type('XYZ', { delay: 60 });
const typed = await page.waitForFunction(() => document.querySelectorAll('.md-block')[1]?.textContent.startsWith('XYZ'), null, { timeout: 15_000 }).then(() => true).catch(() => false);
const typeMs = Date.now() - t;
const lat = await page.evaluate(() => window.__lat.slice().sort((a, b) => a - b));
console.log('keystroke→rAF latency ms:', lat);
H.measure('1 MB paragraph: type 3 chars → preview shows them', typed ? `${typeMs} ms` : 'never (15 s)', 'informational', typed);
if (!typed) H.fail('1 MB paragraph: typed text never appears in the preview', await page.evaluate(() => ({ cls: document.querySelectorAll('.md-block')[1]?.className, head: document.querySelectorAll('.md-block')[1]?.textContent.slice(0, 40) })));
else H.pass('1 MB paragraph: typed text appears', `${typeMs} ms`);
H.measure('1 MB paragraph: keystroke → next frame max', `${Math.max(...lat).toFixed(0)} ms`, '< 16 ms (P7-like, giant block)', Math.max(...lat) < 16);

// stats must still be right for the giant block
const st = await page.evaluate(() => ({ chars: document.querySelector('[data-stat="chars"]')?.textContent, words: document.querySelector('[data-stat="words"]')?.textContent }));
const text = await page.evaluate(() => window.__mdr.app.getText());
console.log('stats:', st, 'len', text.length);
if (Number(st.chars.match(/\d+/)[0]) !== text.length) H.fail('1 MB paragraph: char count', { st, len: text.length }); else H.pass('1 MB paragraph: char count');

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
if (app.consoleErrors.length) H.fail('console errors', { errors: app.consoleErrors.slice(0, 5) }); else H.pass('no console errors');
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
