// bench/verify/fix2-p2-flushdirty.mjs — fix-flows-2 (0.2.0 stage 2b), check item 7: every path that asks
// "is the document dirty" first flushes the preview session, so text typed within the last frame counts.
// Each case types into a preview session with document.execCommand('insertText') (an input event, the
// session's flush is one frame away) and asks the question IN THE SAME TASK, before any frame.
// Needs a running renderer: npx vite --port 5314 --strictPort ; run: MDR_PORT=5314 node bench/verify/fix2-p2-flushdirty.mjs
import { openBrowser, step, assert, finish, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 90_000);
const B = await openBrowser();
const { page } = B;
const DOC = '甲段落文字。\n\n乙段落文字。\n';

async function session() {
  await B.loadDoc(DOC, 'clean.md');
  await B.clickLine(1, 'first', '甲段');
  await B.caretAt('甲段落文字。');
  assert(await B.editing(), 'no session');
}
const typeThen = (what) => page.evaluate((w) => {
  document.execCommand('insertText', false, 'Z');
  const before = window.__mdr.app.getText();
  const out = { before };
  if (w === 'new') window.__mdr.app.registry.run('file.new');
  if (w === 'open') window.__mdr.app.registry.run('file.open');
  if (w === 'beforeunload') {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    out.prevented = e.defaultPrevented;
  }
  return out;
}, what);
const dialog = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const clickBtn = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l); b?.click(); return !!b; }, label);

try {
  await B.boot('mode=split');
  for (const run of [1, 2]) {
    await step(`run ${run}: type in a session, 新建 in the same task → the discard question comes up, 取消 keeps the text`, async () => {
      await session();
      const r = await typeThen('new');
      assert(!r.before.includes('Z'), `precondition: the keystroke was already in the source before the question (${JSON.stringify(r.before)})`);
      await sleep(300);
      const d = await dialog();
      assert(d.some((t) => t.includes('放弃')), `no discard question: ${JSON.stringify(d)}`);
      assert(await clickBtn('取消'), 'no 取消');
      await sleep(200);
      const s = await B.source();
      assert(s.startsWith('甲段落文字。Z'), `text lost: ${JSON.stringify(s)}`);
      return JSON.stringify(s.split('\n')[0]);
    });
    await step(`run ${run}: type in a session, 打开… in the same task → the discard question comes up first`, async () => {
      await session();
      await page.evaluate(() => { window.showOpenFilePicker = async () => { throw new DOMException('cancel', 'AbortError'); }; });
      await typeThen('open');
      await sleep(300);
      const d = await dialog();
      assert(d.some((t) => t.includes('放弃')), `no discard question: ${JSON.stringify(d)}`);
      await clickBtn('取消');
      await sleep(200);
    });
    await step(`run ${run}: type in a session, beforeunload in the same task → prevented (the browser asks)`, async () => {
      await session();
      const r = await typeThen('beforeunload');
      assert(r.prevented === true, `beforeunload not prevented: ${JSON.stringify(r)}`);
      await B.esc();
    });
  }
} finally {
  finish();
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
}
