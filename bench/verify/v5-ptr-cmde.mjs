// bench/verify/v5-ptr-cmde.mjs — verify-session-pointer: what ⌘E / ⌘B pressed in the PREVIEW without a live session
// (after Esc, or after a drag across blocks) does, on the candidate (switch ON and stored "0") and on 0.1.1, and
// whether the keys that follow (Shift+ArrowDown, ⌘V) then change the source. Prints the focus and the source after
// each step; compares the candidate with 0.1.1.
// Run (candidate MDR_PORT 5482, baseline MDR_BASE_PORT 5492): node bench/verify/v5-ptr-cmde.mjs
import { sleep, globalTimeout, J, check, summary, openAt, runSteps, prepare, results, CP, BP } from './v5-ptr-lib.mjs';

const DOC = '# Head Aaa with $x^2$ formula\n\nPara Bbb **bold Ccc** and [link Ddd](http://e.x/) end.\n\nThird Eee para.\n\nLast Rrr para ~~del~~ `code Sss`.\n';
const C = [
  ['drag-cross-cmde', [['drag', ['del', 1], [' end', 2], { steps: 6 }], ['key', 'Meta+e', { after: 250 }]]],
  ['esc-cmde', [['click', ['Third', 2]], ['key', 'Escape', { after: 300 }], ['key', 'Meta+e', { after: 250 }]]],
  ['esc-cmdb', [['click', ['Third', 2]], ['key', 'Escape', { after: 300 }], ['key', 'Meta+b', { after: 250 }]]],
  ['drag-cross-cmde-shiftdown-paste', [['drag', ['del', 1], [' end', 2], { steps: 6 }], ['key', 'Meta+e', { after: 250 }], ['key', 'Shift+ArrowDown', { after: 60 }], ['key', 'Shift+ArrowDown', { after: 60 }], ['pasteAny', 'PASTED'], ]],
];
let A = null, Bs = null, O = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); await Bs?.close(); await O?.close(); });
const facts = (page) => page.evaluate(() => ({ active: (document.activeElement?.className || document.activeElement?.tagName || '').toString().slice(0, 40), src: window.__mdr.app.getText(), editing: !!document.querySelector('.mdr-preview .is-editing') }));
async function run(B, steps, baseline) {
  for (const st of steps) {
    if (st[0] === 'pasteAny') { await B.page.evaluate((t) => navigator.clipboard.writeText(t), st[1]); await B.page.keyboard.press('Meta+v'); await sleep(300); }
    else await runSteps(B.page, [st], { baseline });
  }
  await sleep(300);
  return facts(B.page);
}
try {
  A = await openAt(CP, false);
  Bs = await openAt(BP, true);
  O = await openAt(CP, false);
  await O.page.evaluate(() => { localStorage.setItem('mdr.previewEdit', '0'); });
  await O.page.reload(); await O.page.waitForFunction(() => !!window.__mdr); await sleep(400);
  for (const [name, steps] of C) {
    await prepare(A, DOC); await prepare(Bs, DOC); await prepare(O, DOC);
    await O.page.evaluate(() => window.__mdr.app.preview.setPreviewEditable?.(false));
    const a = await run(A, steps, false), b = await run(Bs, steps, true), o = await run(O, steps, true);
    check(name, a.src === b.src && a.active === b.active, `ON: active=${a.active} src=${J(a.src.slice(0, 90))} | OFF: active=${o.active} src=${J(o.src.slice(0, 90))} | 0.1.1: active=${b.active} src=${J(b.src.slice(0, 90))}`);
  }
  summary();
} finally { stop(); await A?.close(); await Bs?.close(); await O?.close(); }
process.exitCode = results.fail ? 1 : 0;
