// bench/verify/fix2-i1-empty.mjs — fix-session-1 (stage 2b): decision U9 in a real browser (an emptied block).
// Needs a renderer on MDR_PORT (npx vite --port 5302 --strictPort). Run: MDR_PORT=5302 node bench/verify/fix2-i1-empty.mjs
// Checks: one frame after the block is emptied the deletion is in the source (no extra blank line), the document is
// dirty, the session stays on the emptied element; typing there writes a new block at the same place and the session
// continues on it; ⌘Z brings the deleted block back; the only block of a document; Esc leaves it without a write.
import { openBrowser, check, sleep, finish, ensureServer } from './v2-app-lib.mjs';

await ensureServer();
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const B = await openBrowser();
const { page } = B;
const J = JSON.stringify;
const live = () => page.evaluate(() => {
  const e = document.querySelector('.mdr-preview .is-editing');
  return e ? { text: e.textContent.trim(), focused: document.activeElement === e } : null;
});
async function empty(doc, needle) {
  await B.loadDoc(doc, 'e.md');
  const L = doc.split('\n').findIndex((l) => l.includes(needle)) + 1;
  await B.clickLine(L, 'first', needle.slice(0, 2));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await sleep(80);
}
try {
  await B.boot('mode=split');
  const DOC = '# 标题\n\n甲段落文字。\n\n乙段落文字。\n';

  await empty(DOC, '甲段落');
  let src = await B.source();
  let st = await live();
  const title = await page.evaluate(() => document.title);
  const editorText = await page.evaluate(() => window.__mdr.app.editor.view.state.doc.toString());
  check('emptied: the deletion is in the source one frame later, no blank line left', src === '# 标题\n\n乙段落文字。\n', J(src));
  check('emptied: the editor pane shows it and the document is dirty', editorText === src && /●/.test(title), J({ title }));
  check('emptied: the session stays on the emptied element (focused)', !!st && st.text === '' && st.focused, J(st));
  await page.keyboard.type('新段');
  await B.settle(300);
  src = await B.source();
  st = await live();
  check('typed into the emptied element: a new block at the same place', src === '# 标题\n\n新段\n\n乙段落文字。\n', J(src));
  check('…and the session continues on it', !!st && st.text === '新段' && st.focused, J(st));
  await page.keyboard.type('！');
  await B.settle(250);
  src = await B.source();
  check('…typing goes on in it', src === '# 标题\n\n新段！\n\n乙段落文字。\n', J(src));
  const blocks = await page.evaluate(() => document.querySelectorAll('.mdr-preview section.md-block').length);
  check('no leftover emptied wrapper', blocks === 3, String(blocks));
  await B.esc();

  await empty(DOC, '甲段落');
  await page.keyboard.press('ControlOrMeta+z');
  await B.settle(300);
  src = await B.source();
  st = await live();
  check('⌘Z in the emptied element brings the block back', src === DOC, J(src));
  check('…with the session on it', !!st && st.text === '甲段落文字。', J(st));
  await B.esc();

  await empty('唯一段落。\n', '唯一');
  src = await B.source();
  st = await live();
  check('the only block emptied: an empty document, the session still on the element', src === '' && !!st, J({ src, st }));
  await page.keyboard.type('重写');
  await B.settle(300);
  src = await B.source();
  st = await live();
  check('…typed again: the document holds it, session on it', src.startsWith('重写') && !!st && st.text === '重写', J({ src, st }));
  await B.esc();

  await empty(DOC, '乙段落');
  const n0 = await page.evaluate(() => window.__mdr.version());
  await B.esc();
  src = await B.source();
  const n1 = await page.evaluate(() => window.__mdr.version());
  check('Esc on the emptied element writes nothing more', src === '# 标题\n\n甲段落文字。\n' && n1 === n0, J({ src, n0, n1 }));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('script ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  finish();
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
}
