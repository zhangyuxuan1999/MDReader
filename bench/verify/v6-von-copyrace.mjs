// bench/verify/v6-von-copyrace.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): the session's clipboard
// path takes the P-G stamps off every element a COPY touches and puts them back in a 0 ms timer (settleClipboard). If a
// join arrives before that timer (machine-speed ⌘C, ←, Backspace: the browser handles input before timers), Chromium
// re-creates the moved formula while it carries no stamp, and the formula has no annotation after the re-creation.
// Per run: a tight list "- one first / - Lead $x^2$ two", the second item's text selected (the formula inside), then
// ⌘C, ArrowLeft, Backspace sent back to back (and, as a control, with 120 ms between them). Prints the source, the
// toasts and whether the session is still on.
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-copyrace.mjs [runs]
// Global timeout T_MS (default 110 s). Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const RUNS = Number(process.argv[2] ?? 6);
const DOC = '- one first\n- Lead $x^2$ two words\n- three\n';
const EXP = '- one firstLead $x^2$ two words\n- three\n';
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const { page } = A;
  await page.evaluate(() => { window.__toasts = []; window.__mdr.app.bus.on('toast', (t) => window.__toasts.push(t.text)); });
  for (const mode of ['burst', 'paced']) {
    for (let r = 0; r < RUNS; r++) {
      await prepare(A, DOC);
      await page.evaluate(() => { window.__toasts.length = 0; });
      await clickText(page, 'words', 2); await sleep(400);
      const live = await sessionOn(page);
      await page.evaluate(() => {
        const el = document.querySelector('.mdr-preview .is-editing');
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math') ? 2 : 1) });
        let a = null, b = null;
        for (let t = w.nextNode(); t; t = w.nextNode()) { if (t.data.includes('Lead')) a = [t, t.data.indexOf('Lead')]; if (t.data.includes('two')) b = [t, t.data.indexOf('two') + 3]; }
        getSelection().setBaseAndExtent(a[0], a[1], b[0], b[1]);
      });
      if (mode === 'burst') await Promise.all([page.keyboard.press('Meta+c'), page.keyboard.press('ArrowLeft'), page.keyboard.press('Backspace')]);
      else { await page.keyboard.press('Meta+c'); await sleep(120); await page.keyboard.press('ArrowLeft'); await sleep(120); await page.keyboard.press('Backspace'); }
      await sleep(400); await A.settle(300);
      const during = await A.source();
      const on = await sessionOn(page);
      await page.keyboard.press('Escape'); await A.settle(300);
      const src = await A.source();
      const ts = await page.evaluate(() => window.__toasts.slice());
      check(`${mode}-${r}`, live && src === EXP && ts.length === 0, `live=${live} onAfter=${on} toasts=${J(ts)} during=${show(during)} src=${show(src)}`);
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
