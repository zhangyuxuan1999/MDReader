// bench/verify/v4-app-cancel.mjs — verify-app (0.2.0 stage 2d). The discard question (新建 / a file drop) answered
// 取消 while the user was typing — in a preview session, or in the editor pane: is the typing place back, i.e.
// does the next key land in the document where the user was? Prints RESULT lines.
//   Candidate:  MDR_PORT=5436 node bench/verify/v4-app-cancel.mjs
//   Baseline:   MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-cancel.mjs   (editor cases only)
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOC = '甲段落文字。\n\n乙段落文字 beta。\n\n丙段落文字。\n';
const answer = (label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label);
  if (!b) return false; b.click(); return true;
}, label);
const TRIGGERS = {
  new: () => page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); }),
  drop: () => page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['# D\n'], 'c.md', { type: 'text/markdown' }));
    const el = document.querySelector('.mdr-preview');
    for (const e of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(e, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 600, clientY: 300 }));
  }),
};
try {
  await B.boot('mode=split');
  const shim = await shimBaseline(page);
  const hasEdit = !shim.includes('elementOfBlock');
  for (const where of hasEdit ? ['session', 'editor', 'session-click'] : ['editor']) {
    for (const [tn, trig] of Object.entries(TRIGGERS)) {
      try {
        await page.keyboard.press('Escape');
        await answer('取消');
        await B.loadDoc(DOC);
        await sleep(600);
        if (where.startsWith('session')) {
          await B.clickLine(3, 'first', '乙段');
          await B.caretAt('beta');
        } else {
          await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 10 } }); });
        }
        await page.keyboard.type('XY');
        await sleep(300);
        await trig();
        await sleep(900);
        const q = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].length);
        await answer('取消'); await sleep(400);
        const active = await page.evaluate(() => (document.activeElement?.tagName ?? '') + '.' + String(document.activeElement?.className ?? '').split(' ')[0]);
        await page.keyboard.type('Z'); await B.settle(300);
        const s = await B.source();
        out(`${where} ${tn}`, { q, activeAfterCancel: active, z: s.includes('XYZ') ? 'after XY' : s.includes('Z') ? 'elsewhere' : 'lost', session: await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing')) });
      } catch (e) { out(`${where} ${tn}`, `ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
