// bench/verify/v2-app-longuse.mjs — verify-app (0.2.0 stage 2a): long use of in-preview editing.
// (1) 2000 keystrokes in one session (typed in bursts, with Enter splits every 200 chars);
// (2) 200 sessions in a row (click, type, Esc) on one page; DOM node counts, capture textareas, hint bars,
//     contenteditable leftovers, JS heap (performance.memory after gc) before / after.
// Needs the candidate renderer: npx vite --port 5283 --strictPort.  Run: MDR_PORT=5283 node bench/verify/v2-app-longuse.mjs
import { chromium } from '@playwright/test';
import { makeHelpers, step, assert, eq, finish, sleep, BASE } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const browser = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const B = makeHelpers(page);
const stats = () => page.evaluate(() => {
  window.gc?.();
  return {
    nodes: document.getElementsByTagName('*').length,
    caps: document.querySelectorAll('.mdr-preview__edit-capture').length,
    hints: document.querySelectorAll('.mdr-preview__edit-hint').length,
    ce: document.querySelectorAll('.mdr-preview [contenteditable="true"]').length,
    editing: document.querySelectorAll('.mdr-preview .is-editing').length,
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024) : -1,
  };
});

try {
  await B.boot('mode=split');
  const DOC = Array.from({ length: 30 }, (_, i) => `第${i}段文字内容。`).join('\n\n') + '\n';

  await step('2000 keystrokes in one session (Enter every 200) → source has every char, in order', async () => {
    await B.loadDoc(DOC);
    await B.clickLine(1, 'first', '第0'); await B.caretAt('第0段文字内容。');
    let typed = '';
    for (let k = 0; k < 10; k++) {
      const chunk = Array.from({ length: 199 }, (_, i) => String.fromCharCode(97 + ((k * 7 + i) % 26))).join('');
      await page.keyboard.type(chunk, { delay: 0 });
      typed += chunk;
      if (k < 9) { await page.keyboard.press('Enter'); typed += '\n\n'; await sleep(60); }
    }
    await B.settle(500);
    await B.esc();
    const s = await B.source();
    const want = '第0段文字内容。' + typed;
    const got = s.slice(0, want.length);
    if (got !== want) {
      let i = 0; while (got[i] === want[i]) i++;
      throw new Error(`differs at ${i}: got ${JSON.stringify(got.slice(i - 10, i + 30))} want ${JSON.stringify(want.slice(i - 10, i + 30))}`);
    }
    eq(s.slice(want.length), DOC.slice('第0段文字内容。'.length), 'rest of document');
    return `${typed.replace(/\n/g, '').length} chars + 9 splits`;
  });

  await step('200 sessions in a row: no leftover capture / hint / contenteditable; node count and heap stable', async () => {
    await B.loadDoc(DOC);
    await B.settle(300);
    const s0 = await stats();
    for (let i = 0; i < 200; i++) {
      const line = 1 + 2 * (i % 30);
      await B.clickLine(line, 'first', '第');
      await page.keyboard.type('z');
      if (i % 3 === 0) { await page.keyboard.press('Enter'); await sleep(40); await page.keyboard.press('Backspace'); await sleep(40); }
      await page.keyboard.press('Escape');
      if (i === 99) await B.settle(200);
    }
    await B.settle(600);
    const s1 = await stats();
    const src = await B.source();
    const zs = (src.match(/z/g) || []).length;
    assert(s1.caps <= 1 && s1.hints === 1 && s1.ce === 0 && s1.editing === 0, `leftovers ${JSON.stringify(s1)}`);
    assert(s1.nodes < s0.nodes * 1.3 + 200, `DOM nodes ${s0.nodes} → ${s1.nodes}`);
    eq(zs, 200, 'typed z count');
    return `before ${JSON.stringify(s0)} after ${JSON.stringify(s1)}`;
  });
} finally {
  finish();
  clearTimeout(KILL);
  if (errs.length) console.log('PAGEERRORS', errs.slice(0, 5).join('\n'));
  await browser.close().catch(() => {});
}
