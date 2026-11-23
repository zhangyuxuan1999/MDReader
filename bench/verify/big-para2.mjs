// bench/verify/big-para2.mjs — 1 MB paragraph diagnostics: when does the giant block mount, what blocks the main
// thread meanwhile, and is the ~450 ms keystroke cost the editor's or the preview's?
// Run: node bench/verify/big-para2.mjs   (dev server on :5202)
import { openApp, harness, sleep } from './lib.mjs';

const H = harness('bigpara2');
const app = await openApp();
const { page } = app;
await page.evaluate(() => {
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime | 0, dur: e.duration | 0 }); }).observe({ type: 'longtask', buffered: true });
  window.__samples = [];
  window.__mdr.app.bus.on('perf:sample', (s) => { if (s.ms > 20) window.__samples.push({ t: performance.now() | 0, name: s.name, ms: s.ms | 0 }); });
});

const unit = '这是一段很长的中文文本，用于测试 **加粗** 和 *斜体* 以及 `code` 和 [链接](https://example.com) 的渲染性能。The quick brown fox jumps over the lazy dog. ';
let para = '';
while (para.length < 1_000_000) para += unit;
const doc = `# Big paragraph\n\n${para}\n\n## After\n\ntail\n`;

const t0 = Date.now();
await page.evaluate(async (d) => { window.__t0 = performance.now(); await window.__mdr.loadText(d, 'para1mb.md'); }, doc);
const timeline = [];
let mountedAt = null;
while (Date.now() - t0 < 60_000) {
  const s = await page.evaluate(() => {
    const b = document.querySelectorAll('.md-block')[1];
    return { t: (performance.now() - window.__t0) | 0, cls: b?.className ?? 'none', lt: window.__lt.length, ltMax: Math.max(0, ...window.__lt.map((x) => x.dur)), samples: window.__samples.length };
  });
  timeline.push(s);
  if (!/is-pending|is-slow/.test(s.cls) && s.cls !== 'none') { mountedAt = s.t; break; }
  await sleep(500);
}
const diag = await page.evaluate(() => ({ longTasks: window.__lt.slice(0, 40), samples: window.__samples.slice(0, 40) }));
console.log('timeline:', JSON.stringify(timeline.filter((_, i) => i % 4 === 0 || i === timeline.length - 1)));
console.log('long tasks:', JSON.stringify(diag.longTasks));
console.log('perf samples > 20 ms:', JSON.stringify(diag.samples));
H.measure('1 MB paragraph: loadText → giant block content mounted', mountedAt === null ? 'never (60 s)' : `${mountedAt} ms`, 'informational; spec: PLAIN mount deferred 500 ms after stable', mountedAt !== null && mountedAt < 3000);

// keystroke cost: split mode (preview visible) vs edit mode (preview hidden)
const measureTyping = async (mode) => {
  await page.evaluate((m) => window.__mdr.mode(m), mode);
  await sleep(300);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3, 5); window.__lat = []; window.__lt.length = 0; });
  await page.evaluate(() => { if (!window.__latHook) { window.__latHook = true; window.addEventListener('keydown', () => { const t = performance.now(); requestAnimationFrame(() => window.__lat.push(performance.now() - t)); }, true); } });
  await page.keyboard.type('abcde', { delay: 80 });
  await sleep(1500);
  return page.evaluate(() => ({ lat: window.__lat.map((x) => x | 0), longTasks: window.__lt.map((x) => x.dur) }));
};
const edit = await measureTyping('edit');
const split = await measureTyping('split');
console.log('edit mode typing:', JSON.stringify(edit));
console.log('split mode typing:', JSON.stringify(split));
H.measure('1 MB paragraph: keystroke → next frame, edit mode (preview hidden) max', `${Math.max(...edit.lat)} ms`, '< 16 ms', Math.max(...edit.lat) < 16);
H.measure('1 MB paragraph: keystroke → next frame, split mode max', `${Math.max(...split.lat)} ms`, '< 16 ms', Math.max(...split.lat) < 16);
H.measure('1 MB paragraph: long tasks while typing 5 chars, split mode', `${split.longTasks.length} (max ${Math.max(0, ...split.longTasks)} ms)`, 'P7: ≤ 1 > 100 ms', split.longTasks.filter((d) => d > 100).length <= 1);

// does the preview eventually show the typed text, and how long after the last keystroke?
const tShow = Date.now();
const shown = await page.waitForFunction(() => { const b = document.querySelectorAll('.md-block')[1]; return !!b && b.textContent.includes('abcde') && !b.classList.contains('is-slow'); }, null, { timeout: 30_000 }).then(() => true).catch(() => false);
H.measure('1 MB paragraph: last keystroke → preview shows typed text', shown ? `${Date.now() - tShow + 1500} ms (incl. 1.5 s wait)` : 'never (30 s)', 'informational', shown);

if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
if (app.consoleErrors.length) H.fail('console errors', { errors: app.consoleErrors.slice(0, 5) }); else H.pass('no console errors');
await app.browser.close();
H.summary();
console.log('__RESULT__' + JSON.stringify({ findings: H.findings, measurements: H.measurements }));
