// bench/verify/r5-ca-boxprobe.mjs — challenge-atoms (stage 2f, fix round 5): P-G (d) "screen = source" after a Delete join
// in a task list whose second item holds a display formula. Delete at the end of "first" moves "Lead $$E=mc^2$$ two" and
// its [x] box into the first item; fix-atoms' dropForeignBoxes should remove the moved box from the session DOM at the
// next commit. Prints the session DOM of the first item after the join (outerHTML, the checkboxes and whether each is
// inside an li), the source while the session is live, and whether the box is still on screen.
// Run: MDR_PORT=5465 MDR_BASE_PORT=5476 node bench/verify/r5-ca-boxprobe.mjs [display|inline]   Global timeout 100 s.
import { sleep, globalTimeout, openAt, prepare, CP, show, clickText } from './v5-ptr-lib.mjs';

const kind = process.argv[2] || 'display';
const A_ = kind === 'display' ? '$$E=mc^2$$' : '$x^2$';
const DOC = `- [ ] one first\n- [x] Lead ${A_} two\n- [ ] three end\n\nnext\n`;
let A = null;
const stop = globalTimeout(100_000, async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  await prepare(A, DOC);
  await clickText(page, 'two', 1); await sleep(400);
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const tw = document.createTreeWalker(el, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('first'); if (i >= 0) { getSelection().setBaseAndExtent(n, i + 5, n, i + 5); return; } }
  });
  await page.keyboard.press('Delete');
  await sleep(800);
  const dom = await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    if (!el) return { live: false };
    const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]')).map((b) => ({ checked: b.checked, inLi: !!b.closest('li'), parent: b.parentElement?.tagName, liFirstBox: b.closest('li')?.querySelector('input[type="checkbox"]') === b }));
    const li = el.querySelector('li');
    return { live: true, boxes, li: li ? li.outerHTML.replace(/<span class="katex[\s\S]*?<\/math>/g, '[katex…]').slice(0, 900) : null };
  });
  const live = await A.source();
  await page.keyboard.press('Escape'); await A.settle(400);
  const after = await A.source();
  console.log(JSON.stringify(dom, null, 1));
  console.log('source during the session', show(live));
  console.log('source after Esc        ', show(after));
  console.log(`RESULT ${kind}: boxes in session DOM after the join = ${dom.boxes ? dom.boxes.length : 'n/a'} (expected 2: the first item's own and the third item's)`);
} finally { stop(); await A?.close(); }
