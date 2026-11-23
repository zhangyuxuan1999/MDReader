// bench/verify/fix2-i1-pointer.mjs — fix-session-1 (stage 2b): decision U7 in a real browser.
// Needs a renderer on MDR_PORT (npx vite --port 5302 --strictPort). Run: MDR_PORT=5302 node bench/verify/fix2-i1-pointer.mjs
// Checks: the caret lands where the user clicked (mid-text, line end, padding) and typing goes there at machine
// speed; double / triple click select a word / the paragraph; a drag inside one block starts the session with the
// selection kept (typing replaces it); a drag across blocks starts none; a drag that starts inside the session's
// block and leaves it ends the session and selects across blocks; ⌘A twice; a click right after typing elsewhere.
import { openBrowser, check, note, sleep, finish, ensureServer } from './v2-app-lib.mjs';

await ensureServer();

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const B = await openBrowser();
const { page } = B;
const DOC = '# 标题\n\n第一段落文字 alpha beta。\n\n第二段落文字 gamma delta。\n\n第三段落文字 epsilon。\n';
const rect = (needle, from, to) => page.evaluate(({ needle, from, to }) => {
  const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = n.data.indexOf(needle); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + from); r.setEnd(n, i + to);
    const b = r.getBoundingClientRect(); return { l: b.left, r: b.right, y: b.top + b.height / 2, t: b.top, b: b.bottom };
  }
  return null;
}, { needle, from, to });
const state = () => page.evaluate(() => {
  const e = document.querySelector('.mdr-preview .is-editing');
  const s = getSelection();
  return { editing: e ? e.textContent.trim() : null, focused: !!e && document.activeElement === e, sel: s.toString() };
});
try {
  await B.boot('mode=split');

  // 1. caret where clicked: between "alpha" and " beta" (right half of the 'a'), then type at machine speed
  await B.loadDoc(DOC);
  let a = await rect('alpha', 4, 5);
  await page.mouse.click(a.r - 1, a.y);
  await page.keyboard.type('X');
  await B.settle(300);
  let src = await B.source();
  check('click mid-text: caret where clicked, typed at once', src.includes('alphaX beta'), JSON.stringify(src.split('\n')[2]));
  await B.esc();

  // 2. click right of the line end (in the empty area of the block) → caret at the end
  await B.loadDoc(DOC);
  a = await rect('epsilon。', 7, 8);
  await page.mouse.click(a.r + 120, a.y);
  await page.keyboard.type('E');
  await B.settle(300);
  src = await B.source();
  check('click right of the line end: caret at the end', src.includes('epsilon。E'), JSON.stringify(src.split('\n')[6]));
  await B.esc();

  // 3. double click selects a word (and typing replaces it), triple click the paragraph
  await B.loadDoc(DOC);
  a = await rect('gamma', 1, 2);
  await page.mouse.dblclick(a.l, a.y);
  await sleep(150);
  let st = await state();
  check('double click: word selected inside a session', st.sel.trim() === 'gamma' && st.editing !== null && st.focused, JSON.stringify(st));
  await page.keyboard.type('G');
  await B.settle(300);
  src = await B.source();
  check('double click then type: the word is replaced', src.includes('第二段落文字 G delta'), JSON.stringify(src.split('\n')[4]));
  await B.esc();
  await B.loadDoc(DOC);
  a = await rect('gamma', 1, 2);
  await page.mouse.click(a.l, a.y, { clickCount: 3 });
  await sleep(150);
  st = await state();
  check('triple click: the paragraph is selected', st.sel.includes('第二段落文字 gamma delta。'), JSON.stringify(st));
  await B.esc();

  // 4. drag inside one block → session with the selection; typing replaces it
  await B.loadDoc(DOC);
  a = await rect('alpha', 0, 1);
  let b = await rect('beta', 3, 4);
  await page.mouse.move(a.l + 1, a.y); await page.mouse.down();
  await page.mouse.move(b.r - 1, b.y, { steps: 6 }); await page.mouse.up();
  await sleep(120);
  st = await state();
  check('drag inside one block: session with the selection kept', st.editing !== null && st.sel.replace(/\s+/g, ' ') === 'alpha beta', JSON.stringify(st));
  await page.keyboard.type('Z');
  await B.settle(300);
  src = await B.source();
  check('drag inside one block then type: selection replaced', src.includes('第一段落文字 Z。'), JSON.stringify(src.split('\n')[2]));
  await B.esc();

  // 5. drag across blocks → no session, selection across
  await B.loadDoc(DOC);
  a = await rect('第一段落', 0, 1);
  b = await rect('第三段落', 2, 3);
  await page.mouse.move(a.l + 1, a.y); await page.mouse.down();
  await page.mouse.move(b.r, b.y, { steps: 8 }); await page.mouse.up();
  await sleep(120);
  st = await state();
  check('drag across blocks: no session, the selection spans them', st.editing === null && st.sel.includes('第二段落文字'), JSON.stringify(st));

  // 6. drag that starts inside the session's block and leaves it
  await B.loadDoc(DOC);
  a = await rect('alpha', 0, 1);
  await page.mouse.click(a.l + 1, a.y);
  await page.keyboard.type('Q');
  await sleep(30);
  a = await rect('第一段落', 1, 2);
  b = await rect('第三段落', 2, 3);
  await page.mouse.move(a.l + 1, a.y); await page.mouse.down();
  await page.mouse.move(a.r + 20, a.y, { steps: 3 });
  await page.mouse.move(b.r, b.y, { steps: 8 }); await page.mouse.up();
  await sleep(150);
  st = await state();
  src = await B.source();
  note('drag out of the session block', JSON.stringify(st));
  check('drag out of the session block: the session ended and its typed text is written', st.editing === null && src.includes('Qalpha'), JSON.stringify({ st, line: src.split('\n')[2] }));
  check('drag out of the session block: the selection extends over the other blocks', st.sel.includes('第二段落文字'), JSON.stringify(st.sel));

  // 7. ⌘A twice
  await B.loadDoc(DOC);
  a = await rect('gamma', 1, 2);
  await page.mouse.click(a.l, a.y);
  await page.keyboard.press('ControlOrMeta+a');
  st = await state();
  check('⌘A once: the block content', st.editing !== null && st.sel.trim() === '第二段落文字 gamma delta。', JSON.stringify(st));
  await page.keyboard.press('ControlOrMeta+a');
  st = await state();
  check('⌘A twice: no session, the whole preview', st.editing === null && st.sel.includes('第一段落') && st.sel.includes('第三段落'), JSON.stringify({ editing: st.editing, len: st.sel.length }));

  // 8. type in one block and click another 0 ms later, type at once
  await B.loadDoc(DOC);
  a = await rect('alpha', 4, 5);
  await page.mouse.click(a.r - 1, a.y);
  await page.keyboard.type('1\n2');          // Enter: a split, the structure on its way
  b = await rect('epsilon', 6, 7);
  await page.mouse.click(b.r - 1, b.y);
  await page.keyboard.type('3');
  await B.settle(400);
  src = await B.source();
  check('click right after a split elsewhere: typing lands where clicked', src.includes('epsilon3'), JSON.stringify(src));
  // U13 (lead, stage 2c): Enter before a plain space drops that space, so the new paragraph is "2beta…" (was "2 beta").
  check('…and the split was written', src.includes('alpha1\n\n2beta'), JSON.stringify(src));
  await B.esc();
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('script ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
  finish();
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
}
