// bench/verify/review-layoutreads.mjs — counts layout-forcing DOM reads attributed to MDReader's own
// modules (not CodeMirror) on the per-keystroke and per-scroll paths. SPEC §5.3/§5.4/§6 require zero
// offsetTop / getBoundingClientRect on those paths (only scrollTop/clientHeight in updateWindow/evict).
// Run: node bench/verify/review-layoutreads.mjs   (own dev server on :5205)
import { openPage, gotoApp, waitIdle, sleep } from './review-lib.mjs';

const { browser, page, errors } = await openPage();

await page.addInitScript(() => {
  window.__reads = [];
  window.__count = false;
  const note = (kind) => {
    if (!window.__count) return;
    const st = new Error().stack || '';
    // keep only frames from our own source files (vite serves them as /src/...)
    const mine = st.split('\n').filter((l) => /\/src\/(preview|editor|app|shared|worker)\//.test(l));
    if (mine.length === 0) return;
    window.__reads.push({ kind, at: mine[0].trim() });
  };
  const wrapGetter = (proto, prop, kind) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, { ...d, get() { note(kind); return d.get.call(this); } });
  };
  wrapGetter(HTMLElement.prototype, 'offsetTop', 'offsetTop');
  wrapGetter(HTMLElement.prototype, 'offsetHeight', 'offsetHeight');
  wrapGetter(HTMLElement.prototype, 'offsetWidth', 'offsetWidth');
  wrapGetter(Element.prototype, 'clientHeight', 'clientHeight');
  wrapGetter(Element.prototype, 'scrollHeight', 'scrollHeight');
  const gbcr = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { note('getBoundingClientRect'); return gbcr.call(this); };
  const ih = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...ih,
    set(v) { note('innerHTML'); return ih.set.call(this, v); },
  });
});

await gotoApp(page, 'mode=split');
await page.evaluate(() => window.__mdr.loadUrl('/test-data/medium.md'));
await waitIdle(page);
await sleep(500);

const summarise = (reads) => {
  const by = new Map();
  for (const r of reads) {
    const k = `${r.kind} @ ${r.at.replace(/^\s*at\s*/, '').replace(/\?t=\d+/, '')}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]);
};

// ---- typing path
await page.click('.cm-content');
await page.evaluate(() => { window.__reads = []; window.__count = true; });
await page.keyboard.type('性能测试性能测试性能测试abcdefghij', { delay: 25 });
await sleep(400);
const typing = await page.evaluate(() => { window.__count = false; return window.__reads.slice(); });
console.log('\n--- 32-keystroke burst: layout reads attributed to src/ ---');
for (const [k, n] of summarise(typing)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`  total = ${typing.length}`);

// ---- scroll path
await page.evaluate(() => { window.__reads = []; window.__count = true; });
for (let i = 0; i < 20; i++) { await page.mouse.move(1100, 450); await page.mouse.wheel(0, 900); await sleep(60); }
await sleep(500);
const scrolling = await page.evaluate(() => { window.__count = false; return window.__reads.slice(); });
console.log('\n--- 20 wheel steps: layout reads attributed to src/ ---');
for (const [k, n] of summarise(scrolling)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`  total = ${scrolling.length}`);

console.log('\nerrors:', errors.slice(0, 10));
console.log('__RESULT__' + JSON.stringify({ typing: summarise(typing), scrolling: summarise(scrolling) }));
await browser.close();
