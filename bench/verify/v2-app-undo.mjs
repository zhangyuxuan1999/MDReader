// bench/verify/v2-app-undo.mjs — verify-app (0.2.0 stage 2a): keyboard ⌘Z / ⇧⌘Z routing (decision U2) with
// the focus in each UI text field and elsewhere. Prints RESULT lines (values) for diffing; same script on both.
// Candidate: MDR_BASE_URL=http://localhost:5283 node bench/verify/v2-app-undo.mjs
// Baseline:  MDR_BASE_URL=http://127.0.0.1:5293 node bench/verify/v2-app-undo.mjs
import { openBrowser, sleep } from './v2-app-lib.mjs';

await (await import('./v2-app-lib.mjs')).ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOC = '# 标题\n\n第一行文字。\n\n第二行文字。\n\n## 小节\n\n尾。\n';
const first = async () => (await B.source()).split('\n')[2];
const act = () => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}.${String(a.className).split(' ')[0]}${'value' in a ? `=${JSON.stringify(a.value)}` : ''}` : null; });
async function prep() {
  await B.loadDoc(DOC);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }); });
  await page.keyboard.type('ABC'); await sleep(650);
}
const probe = async (k, fn) => { try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };

try {
  await B.boot('mode=split');
  await probe('find field: type xyz, Cmd-Z', async () => {
    await prep();
    await page.keyboard.press('ControlOrMeta+f'); await sleep(250);
    await page.keyboard.type('xyz'); await sleep(100);
    await page.keyboard.press('ControlOrMeta+z'); await sleep(250);
    return { doc: await first(), active: await act() };
  });
  await probe('goto-line dialog input: type 12, Cmd-Z', async () => {
    await prep();
    const id = await page.evaluate(() => window.__mdr.app.registry.list().find((c) => /goto|gotoLine/i.test(c.id))?.id);
    await page.evaluate((id) => window.__mdr.app.registry.run(id), id); await sleep(300);
    await page.keyboard.type('12'); await sleep(100);
    await page.keyboard.press('ControlOrMeta+z'); await sleep(250);
    const r = { id, doc: await first(), active: await act() };
    await page.keyboard.press('Escape');
    return r;
  });
  await probe('toolbar button focused: Cmd-Z, then Shift-Cmd-Z', async () => {
    await prep();
    await page.focus('.mdr-toolbar button');
    await page.keyboard.press('ControlOrMeta+z'); await sleep(250);
    const u = await first();
    await page.keyboard.press('ControlOrMeta+Shift+z'); await sleep(250);
    return { afterUndo: u, afterRedo: await first(), active: await act() };
  });
  await probe('nothing focused (body): Cmd-Z', async () => {
    await prep();
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('ControlOrMeta+z'); await sleep(250);
    return { doc: await first(), active: await act() };
  });
  await probe('discard dialog up (新建 on dirty doc), focus on dialog: Cmd-Z', async () => {
    await prep();
    void page.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(300);
    const dlg = await page.evaluate(() => document.querySelectorAll('.mdr-dialog').length);
    await page.keyboard.press('ControlOrMeta+z'); await sleep(250);
    const r = { dialogs: dlg, doc: await first(), active: await act() };
    await page.keyboard.press('Escape'); await sleep(200);
    return r;
  });
  await probe('preview-only mode, after Esc from nothing: Cmd-Z', async () => {
    await prep();
    await page.evaluate(() => window.__mdr.mode('preview')); await sleep(300);
    await page.keyboard.press('ControlOrMeta+z'); await sleep(300);
    const r = { doc: await first(), mode: await page.evaluate(() => document.querySelector('.mdr-app')?.dataset.mode), active: await act() };
    await page.evaluate(() => window.__mdr.mode('split')); await sleep(200);
    return r;
  });
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
}
