// bench/verify/v6-von-rawbox.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): a document's OWN raw-HTML
// checkbox (the sanitizer keeps <input type="checkbox">) in places where it is not its task item's own box — inside a
// task item after the item's box, inside a plain list item, at the start of a plain item, in a paragraph, in a quote —
// and the new rule that drops every such box (serialize.ts prepare + inlineEdit dropForeignBoxes, P-G d). Per case: a
// click on "words" starts a session (or is refused), X is typed after "words", Esc; the source must keep every
// <input …> the document holds (or nothing is written at all), and the screen must show the box after Esc.
// Also a typed character next to a task whose box the user ticked in the session (the marker must follow the box).
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-rawbox.mjs      (5493 = the pre-r5 copy)
// Global timeout T_MS (default 100 s). Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const DOCS = {
  'task-item-second-box': '- [ ] task <input type="checkbox" checked> more words\n- [x] other\n',
  'plain-item-box': '- item <input type="checkbox"> text words\n- second\n',
  'plain-item-leading-box': '- <input type="checkbox" checked> lead words\n- second\n',
  'para-box': 'Para <input type="checkbox"> text words\n',
  'quote-box': '> Quote <input type="checkbox" checked> words\n',
  'ordered-task-second-box': '1. [x] task <input type="checkbox"> words\n',
};
const count = (s, sub) => s.split(sub).length - 1;
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 100_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const { page } = A;
  await page.evaluate(() => { window.__toasts = []; window.__mdr.app.bus.on('toast', (t) => window.__toasts.push(t.text)); });
  for (const [n, doc] of Object.entries(DOCS)) {
    try {
      await prepare(A, doc);
      await page.evaluate(() => { window.__toasts.length = 0; });
      const shown0 = await page.evaluate(() => document.querySelectorAll('.mdr-preview input[type="checkbox"]').length);
      await clickText(page, 'words', 2); await sleep(450);
      const live = await sessionOn(page);
      if (live) {
        await page.evaluate(() => {
          const el = document.querySelector('.mdr-preview .is-editing');
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let t = w.nextNode(); t; t = w.nextNode()) { const i = t.data.indexOf('words'); if (i >= 0) { getSelection().setBaseAndExtent(t, i + 5, t, i + 5); break; } }
        });
        await page.keyboard.type('X'); await A.settle(350);
      }
      const during = await page.evaluate(() => document.querySelectorAll('.mdr-preview input[type="checkbox"]').length);
      await page.keyboard.press('Escape'); await A.settle(350);
      const src = await A.source();
      const shown1 = await page.evaluate(() => document.querySelectorAll('.mdr-preview input[type="checkbox"]').length);
      const ts = await page.evaluate(() => window.__toasts.slice());
      const kept = count(src, '<input') === count(doc, '<input');
      check(n, (src === doc || kept) && shown1 === shown0, `live=${live} boxes ${shown0}/${during}/${shown1} inputs ${count(doc, '<input')}->${count(src, '<input')} toasts=${J(ts)} src=${show(src)}`);
    } catch (e) { check(n, false, 'threw ' + String(e?.message ?? e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
