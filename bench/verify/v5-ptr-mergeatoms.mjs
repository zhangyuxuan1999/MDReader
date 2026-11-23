// bench/verify/v5-ptr-mergeatoms.mjs — verify-session-pointer: the browser's OWN merge of two line boxes inside one
// session block (Backspace at the start of a paragraph / item / quote paragraph whose previous box is in the same
// block, Delete at the end of the box before) with an inline formula or an image in the moved box. After the merge the
// source must hold every formula's TeX and every image exactly as before (only the join itself may change: K8 / K5),
// and no style attribute the document did not hold. Keys only, at human speed.
// Run (Vite of the tree on MDR_PORT, default 5482): node bench/verify/v5-ptr-mergeatoms.mjs [name-substring]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const filter = process.argv[2] || '';
const C = [
  // [name, doc, click needle (k=2), keys before the merge key, merge key]
  ['quote-paras-bs', '> first para words\n>\n> Lead $x$ second\n\nnext\n', 'second', ['Home'], 'Backspace'],
  ['quote-paras-del', '> first para words\n>\n> Lead $x$ second\n\nnext\n', 'words', ['End'], 'Delete'],
  ['loose-item-paras-bs', '- item first\n\n  Lead $x$ para two\n\nnext\n', 'para two', ['Home'], 'Backspace'],
  ['loose-items-bs', '- item first\n\n- Lead $x$ item two\n\nnext\n', 'item two', ['Home'], 'Backspace'],
  ['tight-items-bs', '- item first\n- Lead $x$ item two\n\nnext\n', 'item two', ['Home'], 'Backspace'],
  ['tight-items-del', '- item first\n- Lead $x$ item two\n\nnext\n', 'first', ['End'], 'Delete'],
  ['nested-item-bs', '- item first\n  - Lead $x$ nested\n\nnext\n', 'nested', ['Home'], 'Backspace'],
  ['ordered-bs', '1. item first\n2. Lead $x$ item two\n\nnext\n', 'item two', ['Home'], 'Backspace'],
  ['quote-image-bs', '> first para words\n>\n> Lead ![i](x.png) second\n\nnext\n', 'second', ['Home'], 'Backspace'],
  ['items-image-bs', '- item first\n- Lead ![i](x.png) two\n\nnext\n', 'two', ['Home'], 'Backspace'],
  ['hardbreak-bs-control', 'first line  \nLead $x$ second\n\nnext\n', 'second', ['Home'], 'Backspace'],
];
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
const texOf = (s) => (s.match(/\$[^$\n]*\$|!\[[^\]]*\]\([^)]*\)/g) || []).join(' ');
try {
  A = await openAt(CP, false);
  for (const [name, doc, click, pre, key] of C) {
    if (filter && !name.includes(filter)) continue;
    try {
      await prepare(A, doc);
      await clickText(A.page, click, 2); await sleep(350);
      for (const k of pre) { await A.page.keyboard.press(k); await sleep(120); }
      const live = await sessionOn(A.page);
      await A.page.keyboard.press(key); await sleep(700); await A.settle(150);
      await A.page.keyboard.press('Escape'); await A.settle(250);
      const src = await A.source();
      const ok = live && texOf(src) === texOf(doc) && !/style=/.test(src);
      check(name, ok, `live=${live} atoms=${J(texOf(src))} want=${J(texOf(doc))} src=${show(src)}`);
    } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;
