// bench/verify/v3-rev-g16.mjs — verify-review (stage 2c, 0.2.0): G16 by variation (r1 check, rule 12).
// G16: something of a session that is still pending (a resume with queued keys) survived a document
// replacement. The fix (CONTRACT §11, G16): bus 'doc:loaded' drops pending resumes, waiting clicks and toggles,
// previewEdit.commit() always ends. The r1 repro used a Backspace merge, an undo and a split. Variations here:
//   click   a U7 click that WAITS for a write still in flight (pending click resume, keys queued) — then a new document
//   toggle  a task checkbox clicked while a write is in flight (pendingToggle, replayed later) — then a new document
//   paste   a paste that made paragraphs (pasteSplit → the resume waits for a minimum structure version) — then a new document
// The worker's structure deltas and HTML are delayed 400 ms (as v2-rev-browser.mjs race did) to widen the window.
// Run from the project root:  MDR_PORT=5387 node bench/verify/v3-rev-g16.mjs [case …]
// Starts its own Vite on MDR_PORT and kills only that port at exit. Global timeout 100 s.
import { startServer, stopServer, openBrowser, check, note, sleep, results } from './inline-verify-lib.mjs';

const want = new Set(process.argv.slice(2));
const on = (c) => want.size === 0 || want.has(c);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(3); }, 100_000);
await startServer();
const B = await openBrowser();
const { page } = B;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const A = 'alpha one two three\n\nbeta four five six\n\n- [ ] gamma task\n';
const N = 'NEW DOC first para\n\nNEW DOC second para\n\n- [ ] NEW task\n';
const slow = (on) => page.evaluate((on) => {
  const pv = window.__mdr.app.preview;
  if (!window.__origDelta) {
    window.__origDelta = pv.applyStructureDelta.bind(pv);
    window.__origHtml = pv.applyHtml.bind(pv);
    pv.applyStructureDelta = (m) => { if (window.__delay) { setTimeout(() => window.__origDelta(m), 400); return true; } return window.__origDelta(m); };
    pv.applyHtml = (m) => { if (window.__delay) setTimeout(() => window.__origHtml(m), 400); else window.__origHtml(m); };
  }
  window.__delay = on;
}, on);
async function replaceAndCheck(label) {
  await page.evaluate(async (N) => { window.__delay = false; await window.__mdr.loadText(N, 'other.md'); }, N);
  await sleep(1300);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  const after = await B.source();
  const ed = await B.editing();
  check(`${label}: the newly opened document is untouched`, after === N, `source now ${JSON.stringify(after)}`);
  check(`${label}: no session runs in it by itself`, ed === null, JSON.stringify(ed));
  await page.keyboard.press('Escape');
  await sleep(200);
}

try {
  await B.boot('mode=split');

  if (on('click')) {
    await slow(false);
    await B.loadDoc(A, 'g16-click.md');
    await B.clickLine(1, 'first', 'two');
    await B.caretAt('three');
    await slow(true);
    await page.keyboard.type('X');                  // a write of ours, delayed
    await sleep(60);
    const pt = await B.textPoint(3, 'first', 'five');
    await page.mouse.click(pt.x, pt.y);            // ends session 1 (writes), the click WAITS (U7)
    await sleep(20);
    const resuming = await page.evaluate(() => document.activeElement?.className ?? '');
    note('click: focus while the click waits', resuming);
    await page.keyboard.type('QQ');                 // queued for the session the click asked for
    await replaceAndCheck('click');
  }

  if (on('toggle')) {
    await slow(false);
    await B.loadDoc(A, 'g16-toggle.md');
    await B.clickLine(1, 'first', 'two');
    await B.caretAt('three');
    await slow(true);
    await page.keyboard.type('X');
    await sleep(60);
    const box = await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      const el = pv.elementOfBlock(pv.blockAtLine(5).id);
      const r = el.querySelector('input').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);          // the toggle waits for our write (pendingToggle)
    await sleep(20);
    await replaceAndCheck('toggle');
  }

  if (on('paste')) {
    await slow(false);
    await B.loadDoc(A, 'g16-paste.md');
    await B.clickLine(3, 'first', 'four');
    await B.caretAt('four');
    await slow(true);
    await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'P1 pasted\n\nP2 pasted\n\nP3 pasted');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(60);                                // the frame writes the paste; the resume waits (minVersion)
    note('paste: focus while the resume waits', await page.evaluate(() => document.activeElement?.className ?? ''));
    await page.keyboard.type('QQ');
    await replaceAndCheck('paste');
  }
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
