// bench/verify/p6-eviction.mjs — does the preview keep a tall (5k-line) code block mounted while the
// user is looking at its middle? Part 1: no typing — scroll the preview into the middle of the block
// and watch its classes/children for 4 s. Part 2: put the cursor mid-block in the editor (split mode,
// sync scrolls the preview there) and type 10 chars; record the block's class/children timeline and
// how long it is empty (0 children) while visible.
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, report, dumpErrors, sleep, fmt } from './common.mjs';

const makeDoc = (fenceLines) => {
  const paras = (n, p) => Array.from({ length: n }, (_, i) => `段落 ${p}-${i} 这是一些中文文本 with some English words, line ${i}.\n`).join('\n');
  const fence = '```ts\n' + Array.from({ length: fenceLines }, (_, i) => `export function fn${i}(a: number, b: string): string { return b + a * ${i}; } // line ${i}`).join('\n') + '\n```\n';
  return `# Fence test ${fenceLines}\n\n${paras(200, 'a')}\n${fence}\n${paras(200, 'b')}`;
};
const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  const n = 5000;
  await page.goto(`${BASE}/?mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await page.evaluate((t) => window.__mdr.loadText(t, 'fence5k.md'), makeDoc(n));
  await waitFirstVisible(page, 60_000);
  await waitIdle(page);
  const fenceStart = 2 + 200 * 2 + 1;
  const mid = fenceStart + Math.floor(n / 2);
  const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), mid);
  const watch = (id) => page.evaluate((id) => {
    const el = document.querySelector(`.md-block[data-id="${id}"]`);
    window.__tl = []; window.__t0 = performance.now();
    const push = (why) => window.__tl.push({ t: performance.now() - window.__t0, why, cls: el.className.replace('md-block', '').trim() || '-', children: el.children.length, h: el.getBoundingClientRect().height | 0, top: el.getBoundingClientRect().top | 0, scrollTop: window.__mdr.app.preview.el.scrollTop | 0, H: window.__mdr.app.preview.el.clientHeight });
    push('start');
    new MutationObserver(() => push('mut')).observe(el, { attributes: true, childList: true });
    window.__push = push;
  }, id);
  const readTl = () => page.evaluate(() => { window.__push('end'); return window.__tl; });
  const fmtTl = (tl) => tl.map((x) => `${x.t.toFixed(0)}:${x.cls}/${x.children}(top ${x.top},h ${x.h},st ${x.scrollTop})`).join('  ');

  // Part 1: preview scrolled to the middle of the block, no typing
  await page.evaluate((l) => window.__mdr.app.preview.scrollToLine(l, 0, 'instant'), mid);
  await sleep(1500);
  await watch(b.id);
  await sleep(4000);
  const tl1 = await readTl();
  const empty1 = tl1.filter((x) => x.children === 0);
  console.log(`[evict no-typing] block ${b.id} (${b.lineCount} lines) preview at line ${mid}: ${tl1.length} events; ${fmtTl(tl1.slice(0, 12))}${tl1.length > 12 ? ' …' : ''}`);
  const vis1 = await page.evaluate((l) => ({ visible: window.__mdr.app.preview.isLineVisible(l), top: window.__mdr.app.preview.topVisible() }), mid);
  report('P6/eviction: tall block stays mounted while the viewport is inside it (no typing)', `${empty1.length} empty states in 4 s; visible=${vis1.visible}; last state ${tl1.at(-1).cls}/${tl1.at(-1).children}`, 'never empty', empty1.length === 0);

  // Part 2: cursor mid-block in editor, type 10 chars
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), mid);
  await sleep(1500);
  await watch(b.id);
  await page.keyboard.type(' // abc def', { delay: 100 });
  await sleep(3000);
  const tl2 = await readTl();
  // time the block was empty (children 0) while its box intersected the viewport
  let emptyMs = 0;
  for (let i = 1; i < tl2.length; i++) { const p = tl2[i - 1]; if (p.children === 0 && p.top < p.H && p.top + p.h > 0) emptyMs += tl2[i].t - p.t; }
  console.log(`[evict typing] ${tl2.length} events; ${fmtTl(tl2.slice(0, 16))}${tl2.length > 16 ? ' …' : ''}`);
  const finalState = await page.evaluate((id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return { cls: el.className, children: el.children.length, hasTyped: el.textContent.includes('// abc def') }; }, b.id);
  console.log(`[evict typing] final: ${JSON.stringify(finalState)}; total time empty while on screen ≈ ${emptyMs.toFixed(0)} ms`);
  report('P6/eviction: old content stays visible while typing inside a giant block (SPEC §5.5)', `empty-while-visible ≈ ${emptyMs.toFixed(0)} ms; final ${finalState.cls}/${finalState.children} typed=${finalState.hasTyped}`, '0 ms empty, final mounted with typed text', emptyMs < 50 && finalState.children > 0 && finalState.hasTyped);
} finally {
  dumpErrors(errors);
  await browser.close();
}
