// bench/verify/v6-von-taskbs.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): Backspace at the start of a
// task item's text (right after its checkbox) in a session: what one press and a second press do, in a tight task list,
// in one inside a quote, and in a loose one. Prints, per case and press, the source during the session, the li's inner
// HTML around the box and the checkbox states, and after Esc the source.
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-taskbs.mjs        (tree; 5493 = the pre-r5 copy)
// Global timeout T_MS (default 100 s). Writes nothing into the tree.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const DOCS = {
  tight: 'intro\n\n- [ ] one first\n- [x] Lead $x$ two\n- [ ] three end\n\nnext\n',
  plain: 'intro\n\n- [ ] one first\n- [x] Lead plain two\n- [ ] three end\n\nnext\n',
  quote: 'intro\n\n> - [x] one first\n> - [ ] Lead $x$ two\n> - [x] three end\n\nnext\n',
  loose: 'intro\n\n- [x] one first\n\n- [ ] Lead $x$ two\n\n- [x] three end\n\nnext\n',
};
const selectAt = (page, needle, k) => page.evaluate(({ needle, k }) => {
  const el = document.querySelector('.mdr-preview .is-editing');
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, [data-mdr-ui]') ? 2 : 1) });
  for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) { getSelection().setBaseAndExtent(n, i + k, n, i + k); return J(n.data.slice(0, i + k)); } }
  throw new Error('selectAt ' + needle);
  function J(x) { return JSON.stringify(x); }
}, { needle, k });
const liHtml = (page) => page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const li = [...el.querySelectorAll('li')].find((x) => x.textContent.includes('Lead')); return li ? li.innerHTML.replace(/<span class="md-math"[\s\S]*?<\/span><\/span><\/span>/g, '[M]').slice(0, 160) : null; });
const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-preview li input[type="checkbox"]')].map((b) => b.checked));

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 100_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [n, doc] of Object.entries(DOCS)) {
    await prepare(A, doc);
    await clickText(page, 'two', 1); await sleep(400);
    const live = await sessionOn(page);
    const before = await selectAt(page, 'Lead', 0);
    const html0 = await liHtml(page);
    await page.keyboard.press('Backspace'); await A.settle(350);
    const s1 = await A.source(); const html1 = await liHtml(page); const b1 = await boxes(page);
    await page.keyboard.press('Backspace'); await A.settle(350);
    const s2 = await A.source(); const html2 = await liHtml(page); const b2 = await boxes(page);
    await page.keyboard.press('Escape'); await A.settle(300);
    const s3 = await A.source();
    console.log(`RESULT ${n} live=${live} textBefore=${before}\n  li0=${J(html0)}\n  press1 src=${show(s1)} li=${J(html1)} boxes=${J(b1)}\n  press2 src=${show(s2)} li=${J(html2)} boxes=${J(b2)}\n  esc src=${show(s3)}`);
    check(`${n}: the first Backspace changes the source`, s1 !== doc, show(s1));
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
