// bench/verify/review-enter-profile.mjs — attributes the per-Enter main-thread cost (see review-enter-toc.mjs) with
// the CDP sampling profiler: self time per function during 30 Enter keystrokes at the top of large.md, plus a
// direct timing of toc.setOutline's DOM rebuild + offset refresh via instrumented offsetTop reads.
// Run: node bench/verify/review-enter-profile.mjs
import { openPage, gotoApp, loadDoc, waitIdle, sleep, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const N = Number(process.env.N || 30);
const { browser, page, cdp, errors } = await openPage();
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await sleep(800);
  // instrument: count offsetTop reads on TOC anchors and time nav.replaceChildren
  await page.evaluate(() => {
    const nav = document.querySelector('.mdr-toc');
    window.__toc = { offsetReads: 0, rebuilds: 0, rebuildMs: 0, outlineMsgs: 0 };
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { if (this.classList.contains('mdr-toc__item')) window.__toc.offsetReads++; return d.get.call(this); } });
    const orig = nav.replaceChildren.bind(nav);
    nav.replaceChildren = (...a) => { const t = performance.now(); window.__toc.rebuilds++; const r = orig(...a); window.__toc.rebuildMs += performance.now() - t; return r; };
    window.__mdr.app.bus.on('outline:changed', () => { window.__toc.outlineMsgs++; });
  });
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(3, 0); window.__mdr.app.editor.focus(); });
  await sleep(400);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t0 = await page.evaluate(() => performance.now());
  for (let i = 0; i < N; i++) { await page.keyboard.press('Enter'); await sleep(150); }
  await sleep(400);
  const { profile } = await cdp.send('Profiler.stop');
  const toc = await page.evaluate(() => window.__toc);
  // aggregate self time by function (url:function)
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const dt = profile.timeDeltas[i] / 1000;
    total += dt;
    const cf = n.callFrame;
    const file = (cf.url || '').split('/').slice(-2).join('/').split('?')[0];
    const key = `${cf.functionName || '(anon)'} @ ${file || '(native)'}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + dt);
  }
  const top = Array.from(self.entries()).sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`profile total ${r1(total)} ms over ${N} Enter keystrokes; top self-time:`);
  for (const [k, v] of top) console.log(`  ${r1(v).toString().padStart(7)} ms  ${k}`);
  // total time attributed to toc.ts / layout-forcing getters
  let tocMs = 0, layoutMs = 0;
  for (const [k, v] of self) { if (k.includes('toc.ts')) tocMs += v; if (/offsetTop|offsetHeight|clientHeight|scrollIntoView|\(garbage|\(program\)/.test(k) && false) layoutMs += v; }
  console.log('TOC instrumentation:', toc, 'per Enter: rebuild', r1(toc.rebuildMs / N), 'ms, offsetTop reads', Math.round(toc.offsetReads / N));
  report(`review-enter-profile ${DOC}`, [
    { name: 'outline messages / TOC rebuilds per Enter keystroke', value: `${toc.outlineMsgs} / ${toc.rebuilds} for ${N} keystrokes`, target: '0 (no heading changed)', pass: toc.rebuilds === 0 },
    { name: 'TOC anchor offsetTop reads per Enter (forced layout on keystroke path)', value: `${Math.round(toc.offsetReads / N)}`, target: '0', pass: toc.offsetReads === 0 },
    { name: 'self time in src/preview/toc.ts during the burst', value: `${r1(tocMs)} ms (${r1(tocMs / N)} ms per keystroke) of ${r1(total)} ms sampled`, target: '≈ 0', pass: tocMs / N < 1 },
  ]);
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}
