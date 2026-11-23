// bench/verify/v3-rev-leaks.mjs — verify-review (stage 2c, 0.2.0): listener / element / heap growth across many
// edit sessions (click, type, Esc; every 4th one empties its block and types into the emptied wrapper — the U9
// ghost path) and many document loads. Counts, before and after, via the DevTools protocol:
//   event listeners on window, document and the preview root; capture textareas, hint bars, ghost holders, link
//   inputs in the DOM; JS heap after a forced GC.
// Run from the project root:  MDR_PORT=5387 [MDR_SESSIONS=120] [MDR_DOCS=40] node bench/verify/v3-rev-leaks.mjs
// Starts its own Vite on MDR_PORT and kills only that port at exit. Global timeout 115 s.
import { startServer, stopServer, openBrowser, check, note, sleep, results } from './inline-verify-lib.mjs';

const SESSIONS = Number(process.env.MDR_SESSIONS) || 120;
const DOCS = Number(process.env.MDR_DOCS) || 40;
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 115_000);
await startServer();
const B = await openBrowser();
const { page, context } = B;
const cdp = await context.newCDPSession(page);

async function listeners(expr) {
  const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
  const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  const by = {};
  for (const l of ls) by[l.type] = (by[l.type] ?? 0) + 1;
  return { n: ls.length, by };
}
async function snapshot() {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await page.evaluate(() => ({
    caps: document.querySelectorAll('.mdr-preview__edit-capture').length,
    hints: document.querySelectorAll('.mdr-preview__edit-hint').length,
    ghosts: document.querySelectorAll('.md-ghost-holder').length,
    linkInputs: document.querySelectorAll('.mdr-preview__link-input').length,
    editing: document.querySelectorAll('.mdr-preview .is-editing').length,
    nodes: document.getElementsByTagName('*').length,
  }));
  return {
    win: await listeners('window'), doc: await listeners('document'), root: await listeners("document.querySelector('.mdr-preview')"),
    heapMB: Math.round(heap.usedSize / 1048576 * 10) / 10, dom,
  };
}

const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} with some words to click on.`);
const docA = paras.join('\n\n') + '\n';
try {
  await B.boot('mode=split');
  await B.loadDoc(docA, 'leak.md');
  // one warm-up round so lazily created things exist before the first count
  await B.clickLine(1, 'first', 'words');
  await page.keyboard.type('w');
  await B.esc();
  await B.loadDoc(docA, 'leak.md');
  const s0 = await snapshot();
  note('before', JSON.stringify(s0));
  let done = 0;
  for (let i = 0; i < SESSIONS; i++) {
    const k = i % 20;
    const line = 2 * k + 1;
    try {
      await B.clickLine(line, 'first', 'words');
      if (i % 4 === 3) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        await page.keyboard.press('Backspace');
        await sleep(80);
        await page.keyboard.type(`N${i}`);
      } else {
        await page.keyboard.type('z');
      }
      await page.keyboard.press('Escape');
      await sleep(40);
      done++;
    } catch (e) { note(`session ${i}`, `skipped: ${e.message.slice(0, 80)}`); }
    if (i % 20 === 19) { await page.evaluate(() => window.__mdr.waitIdle()); await B.loadDoc(docA, 'leak.md'); }
  }
  await page.evaluate(() => window.__mdr.waitIdle());
  for (let d = 0; d < DOCS; d++) await B.loadDoc(`# Doc ${d}\n\n` + paras.slice(0, 5 + (d % 7)).join('\n\n') + '\n', `d${d}.md`);
  await B.loadDoc(docA, 'leak.md');
  await sleep(500);
  const s1 = await snapshot();
  note('after', JSON.stringify(s1));
  note('sessions done', `${done}/${SESSIONS}, documents ${DOCS}`);
  check('window listeners do not grow', s1.win.n <= s0.win.n, `${s0.win.n} → ${s1.win.n} ${JSON.stringify(s1.win.by)}`);
  check('document listeners do not grow', s1.doc.n <= s0.doc.n, `${s0.doc.n} → ${s1.doc.n} ${JSON.stringify(s1.doc.by)}`);
  check('preview root listeners do not grow', s1.root.n <= s0.root.n, `${s0.root.n} → ${s1.root.n}`);
  check('one capture element, one hint bar, no ghost holder, no link input left', s1.dom.caps <= 1 && s1.dom.hints <= 1 && s1.dom.ghosts === 0 && s1.dom.linkInputs === 0 && s1.dom.editing === 0, JSON.stringify(s1.dom));
  check('heap after GC grows less than 15 MB', s1.heapMB - s0.heapMB < 15, `${s0.heapMB} → ${s1.heapMB} MB`);
} catch (err) {
  console.log('ERROR', err && err.stack ? err.stack : err);
  results.fail++;
} finally {
  clearTimeout(killer);
  await B.browser.close().catch(() => {});
  stopServer();
  console.log(`RESULT ${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}
