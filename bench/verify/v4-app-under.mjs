// bench/verify/v4-app-under.mjs — verify-app (0.2.0 stage 2d). The emptied-block session (U9 / U18, round 3:
// goneKey, leaveGone, goneVersion, keepsRemoved) against the rest of the app: the menu's 撤销 / 重做 and format
// commands (registry.run, as the desktop menu sends them), ⌘Z / ⇧⌘Z keys, save, 新建, toggling 预览可编辑,
// mode switches. After each step: the source, the preview's visible blocks, ghosts and duplicate ids, and where
// the next typed text lands. Prints RESULT lines.
//   MDR_PORT=5436 node bench/verify/v4-app-under.mjs [filter]
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOCS = {
  para: ['甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', ''].join('\n'),
  tight: ['# 标题', '乙段落文字。', '', '丙段落文字。', ''].join('\n'),
  list: ['甲段落文字。', '', '- 乙段落文字。', '- 乙二', '', '丙段落文字。', ''].join('\n'),
  last: ['甲段落文字。', '', '乙段落文字。', ''].join('\n'),
  first: ['乙段落文字。', '', '丙段落文字。', ''].join('\n'),
  firstList: ['- 乙段落文字。', '- 乙二', '', '丙段落文字。', ''].join('\n'),
  firstHeading: ['## 乙段落文字。', '', '丙段落文字。', ''].join('\n'),
};
const view = () => page.evaluate(() => {
  const pv = document.querySelector('.mdr-preview');
  const blocks = [...pv.querySelectorAll(':scope .md-block')].filter((e) => !e.parentElement.closest('.md-block'));
  const ids = blocks.map((e) => e.dataset.id);
  return {
    shown: blocks.map((e) => e.textContent.trim().slice(0, 10)),
    editing: pv.querySelector('.is-editing')?.textContent.trim().slice(0, 10) ?? null,
    dup: ids.length - new Set(ids).size,
    title: document.title,
  };
});
const reg = (id) => page.evaluate((c) => { void window.__mdr.app.registry.run(c); }, id);
const answer = (label) => page.evaluate((label) => {
  const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label);
  if (!b) return false; b.click(); return true;
}, label);
async function emptyB(doc) {
  await page.keyboard.press('Escape');
  await answer('取消');
  await B.loadDoc(doc);
  await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); });
  await sleep(700);
  const line = doc.split('\n').findIndex((l) => l.includes('乙段落')) + 1;
  await B.clickLine(line, 'first', '乙段');
  await sleep(150);
  await page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Backspace');
  await B.settle(300);
}
const probe = async (k, fn) => { if (only && !k.startsWith(only)) return; try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };
try {
  await B.boot('mode=split');
  for (const [dn, doc] of Object.entries(DOCS)) {
    await probe(`U1 ${dn} emptied, menu 撤销, type Q`, async () => {
      await emptyB(doc);
      const v0 = { src: await B.source(), ...(await view()) };
      await reg('edit.undo'); await B.settle(400);
      const v1 = { srcIsDoc: (await B.source()) === doc, ...(await view()) };
      await page.keyboard.type('Q'); await B.settle(300);
      const s2 = await B.source();
      return { v0, v1, afterQ: s2 === doc ? 'unchanged' : s2, v2: await view() };
    });
    await probe(`U2 ${dn} emptied, menu 撤销 then 重做, type Q`, async () => {
      await emptyB(doc);
      const del = await B.source();
      await reg('edit.undo'); await B.settle(300);
      await reg('edit.redo'); await B.settle(400);
      const v1 = { srcIsDel: (await B.source()) === del, ...(await view()) };
      await page.keyboard.type('Q'); await B.settle(300);
      return { del, v1, afterQ: await B.source(), v2: await view() };
    });
    await probe(`U3 ${dn} emptied, ⌘Z key, type Q`, async () => {
      await emptyB(doc);
      await page.keyboard.press('ControlOrMeta+z'); await B.settle(400);
      const v1 = { srcIsDoc: (await B.source()) === doc, ...(await view()) };
      await page.keyboard.type('Q'); await B.settle(300);
      return { v1, afterQ: await B.source(), v2: await view() };
    });
    await probe(`U4 ${dn} emptied, toolbar 加粗, type Q`, async () => {
      await emptyB(doc);
      await page.click('.mdr-toolbar button[data-cmd="edit.bold"]'); await B.settle(300);
      await page.keyboard.type('Q'); await B.settle(300);
      return { afterQ: await B.source(), v: await view() };
    });
    await probe(`U7 ${dn} emptied, toolbar H2, type Q`, async () => {
      await emptyB(doc);
      const del = await B.source();
      await page.click('.mdr-toolbar button[data-cmd="edit.heading2"]'); await B.settle(400);
      const afterH = await B.source();
      const v1 = await view();
      await page.keyboard.type('Q'); await B.settle(300);
      return { del, afterH, v1, afterQ: await B.source() };
    });
    await probe(`U8 ${dn} typed XY in a session, toolbar H2`, async () => {
      await page.keyboard.press('Escape');
      await B.loadDoc(doc);
      await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); });
      await sleep(700);
      const line = doc.split('\n').findIndex((l) => l.includes('乙段落')) + 1;
      await B.clickLine(line, 'first', '乙段');
      await B.caretAt('乙段');
      await page.keyboard.type('XY');
      await page.click('.mdr-toolbar button[data-cmd="edit.heading2"]'); await B.settle(400);
      return { afterH: await B.source(), v: await view() };
    });
    await probe(`U5 ${dn} emptied, ⌘S, type Q`, async () => {
      await emptyB(doc);
      const del = await B.source();
      await page.keyboard.press('ControlOrMeta+s'); await sleep(900);
      await answer('取消');
      const v1 = await view();
      await page.keyboard.type('Q'); await B.settle(300);
      return { del, v1, afterQ: await B.source(), v2: await view() };
    });
    await probe(`U6 ${dn} emptied, toggle 预览可编辑 off and on`, async () => {
      await emptyB(doc);
      await page.keyboard.press('ControlOrMeta+Shift+e'); await B.settle(400);
      const v1 = { src: await B.source(), ...(await view()) };
      await page.keyboard.press('ControlOrMeta+Shift+e'); await B.settle(300);
      return { v1, v2: await view() };
    });
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
