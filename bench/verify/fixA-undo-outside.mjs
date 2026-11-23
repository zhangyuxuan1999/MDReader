// bench/verify/fixA-undo-outside.mjs — fixer-A browser check for decision U2 and the low finding on editor-only
// shortcuts inside a session (CONTRACT §11):
//   1. preview-only mode, type in a block, Esc, nothing focused → ⌘Z undoes the burst, ⇧⌘Z redoes it; the mode
//      stays 预览, the preview does not scroll, the editor does not take focus.
//   2. the same from the toolbar (focus on a toolbar button) in split mode.
//   3. ⌘1 inside a session → a hint toast, the source unchanged, the session still live.
// Run: MDR_PORT=5271 node bench/verify/fixA-undo-outside.mjs   (own vite on MDR_PORT, killed at exit; global timeout)
import { startServer, stopServer, openBrowser, step, assert, finish, sleep, check, readRoot } from './inline-verify-lib.mjs';

const GLOBAL_MS = Number(process.env.MDR_TIMEOUT_MS) || 180_000;
const killer = setTimeout(() => { console.log('FAIL  global timeout'); stopServer(); process.exit(2); }, GLOBAL_MS);

await startServer();
const B = await openBrowser();
const { page } = B;
const SMALL = readRoot('test-data/small.md');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Clicks into the first paragraph containing `needle` (scrolls it into view first) and returns its line. */
async function clickInto(needle) {
  const line = SMALL.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const pt = await B.textPoint(line);
  await page.mouse.click(pt.x, pt.y);
  await sleep(150);
  assert(await B.editing(), 'no session');
  return line;
}
const st = () => page.evaluate(() => ({
  st: window.__mdr.app.preview.el.scrollTop,
  mode: window.__mdr.app.layout.getMode(),
  editorFocused: window.__mdr.app.editor.hasFocus(),
  text: window.__mdr.app.getText(),
}));

try {
  await B.boot('mode=split');
  await B.loadDoc(SMALL, 'small.md');
  await step('preview-only, after Esc, nothing focused: ⌘Z undoes the burst, ⇧⌘Z redoes it; no mode switch, scroll or focus', async () => {
    await page.evaluate(() => window.__mdr.mode('preview'));
    await sleep(300);
    await clickInto('The quick brown fox');
    await page.keyboard.type('xyz', { delay: 30 });
    await B.settle(300);
    await page.keyboard.press('Escape');
    await B.settle(300);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    const a = await st();
    assert(a.text.includes('xyz'), 'typing did not reach the source');
    await page.keyboard.press(`${MOD}+z`);
    await B.settle(300);
    const b = await st();
    assert(b.text === SMALL, `⌘Z did not restore the original text (contains xyz: ${b.text.includes('xyz')})`);
    assert(b.mode === 'preview', `mode switched to ${b.mode}`);
    assert(!b.editorFocused, 'editor took focus');
    assert(Math.abs(b.st - a.st) < 50, `preview scrolled ${Math.round(b.st - a.st)} px`);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await B.settle(300);
    const c = await st();
    assert(c.text === a.text, '⇧⌘Z did not redo');
    assert(c.mode === 'preview' && !c.editorFocused, 'redo switched mode or focused the editor');
    return `scroll delta ${Math.round(b.st - a.st)} px`;
  });
  await step('split, focus on a toolbar button: ⌘Z undoes through the document history', async () => {
    await page.evaluate(() => window.__mdr.mode('split'));
    await sleep(300);
    const before = (await st()).text;
    await clickInto('The quick brown fox');
    await page.keyboard.type('QQ', { delay: 30 });
    await B.settle(300);
    await page.keyboard.press('Escape');
    await B.settle(300);
    await page.locator('.mdr-toolbar__btn[data-cmd="view.toggleToc"]').focus();
    await page.keyboard.press(`${MOD}+z`);
    await B.settle(300);
    const after = await st();
    assert(after.text === before, 'not undone');
    assert(!after.editorFocused, 'editor took focus');
  });
  await step('⌘1 inside a session: a hint toast, nothing written, the session stays', async () => {
    const before = (await st()).text;
    await clickInto('The quick brown fox');
    await page.keyboard.press(`${MOD}+1`);
    await sleep(200);
    const toast = await page.evaluate(() => document.querySelector('.mdr-toasts')?.textContent ?? '');
    const after = await st();
    const editing = await B.editing();
    await page.keyboard.press('Escape');
    assert(toast.includes('预览编辑中不可用'), `no hint toast (toasts: "${toast}")`);
    assert(after.text === before, 'the source changed');
    assert(editing, 'the session ended');
    return toast.trim().slice(0, 60);
  });
  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  clearTimeout(killer);
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();
