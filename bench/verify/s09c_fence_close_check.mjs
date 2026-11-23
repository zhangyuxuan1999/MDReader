// s09c — isolate the s09 "unclosedFenceTop" result: after typing ``` + Enter on the last line, is the
// fence actually closed in the editor text (closeBrackets may have altered it)? Compare keyboard typing
// with a direct dispatch of the same text. Run: node bench/verify/s09c_fence_close_check.mjs
import { launch, open, settle, structureCheck, makeChecker, report, sleep } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
const DOC = '```\n' + '# H\n\npara\n\n- a\n- b\n\n'.repeat(5000);
try {
  await open(page, '?mode=split');
  await settle(page, 30000);

  // (a) keyboard: type "js" at line 1 col 3, then ``` + Enter at the last (empty) line
  await page.evaluate(async (d) => { await window.__mdr.loadText(d, 'unclosed.md'); }, DOC);
  await settle(page, 60000);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(1, 3); ed.focus(); });
  await page.keyboard.type('js', { delay: 0 });
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(ed.lineCount(), 0); ed.focus(); });
  await page.keyboard.type('```\n', { delay: 0 });
  let tail = await page.evaluate(() => JSON.stringify(window.__mdr.app.editor.getText().slice(-40)));
  let head = await page.evaluate(() => JSON.stringify(window.__mdr.app.editor.getText().slice(0, 12)));
  let s = await settle(page, 90000);
  let sc = await structureCheck(page);
  console.log('(a) keyboard: head', head, 'tail', tail, 'blocks', sc.blocks, 'settled', s.ok);
  C.check('(a) keyboard-typed closing fence at EOF → still one (now closed) block', sc.blocks === 1, { head, tail, blocks: sc.blocks });

  // (b) dispatch "```\n" at the end directly
  await page.evaluate(async (d) => { await window.__mdr.loadText(d, 'unclosed2.md'); }, DOC);
  await settle(page, 60000);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: v.state.doc.length, insert: '```\n' } }); });
  tail = await page.evaluate(() => JSON.stringify(window.__mdr.app.editor.getText().slice(-40)));
  s = await settle(page, 90000);
  sc = await structureCheck(page);
  console.log('(b) dispatch: tail', tail, 'blocks', sc.blocks, 'settled', s.ok);
  C.check('(b) dispatched closing fence at EOF → one block', sc.blocks === 1, { tail, blocks: sc.blocks });

  // (c) keyboard: type ``` at the last line of a doc WITHOUT the js info string
  await page.evaluate(async (d) => { await window.__mdr.loadText(d, 'unclosed3.md'); }, DOC);
  await settle(page, 60000);
  await page.evaluate(() => { const ed = window.__mdr.app.editor; ed.gotoLine(ed.lineCount(), 0); ed.focus(); });
  await page.keyboard.press('`'); await page.keyboard.press('`'); await page.keyboard.press('`');
  tail = await page.evaluate(() => JSON.stringify(window.__mdr.app.editor.getText().slice(-20)));
  console.log('(c) after three ` presses, tail', tail);
  await page.keyboard.press('Enter');
  tail = await page.evaluate(() => JSON.stringify(window.__mdr.app.editor.getText().slice(-20)));
  s = await settle(page, 90000);
  sc = await structureCheck(page);
  console.log('(c) after Enter, tail', tail, 'blocks', sc.blocks);
  C.check('(c) plain ``` typed on the last line → one block', sc.blocks === 1, { tail, blocks: sc.blocks });

  // (d) 50k headings: TOC count without disturbing a heading
  await page.evaluate(async () => { let t = ''; for (let i = 0; i < 50000; i++) t += `${'#'.repeat(1 + (i % 6))} Heading ${i}\n`; await window.__mdr.loadText(t, 'h.md'); });
  s = await settle(page, 60000);
  await sleep(800);
  const toc = await page.evaluate(() => ({ items: document.querySelectorAll('.mdr-toc__item').length, collapsed: !!document.querySelector('.mdr-toc--collapsed'), expandBtn: !!document.querySelector('.mdr-toc__expand') }));
  C.check('(d) TOC has 50000 entries and is collapsed', toc.items === 50000 && toc.collapsed && toc.expandBtn, toc);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
} catch (e) {
  C.check('script completed', false, String(e && e.stack || e));
} finally {
  report('s09c fence close check', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}
