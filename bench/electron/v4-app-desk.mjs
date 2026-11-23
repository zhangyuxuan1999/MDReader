// bench/electron/v4-app-desk.mjs — verify-app (0.2.0 stage 2d): the emptied-block session (U9 / U18, round 3)
// inside the desktop dev shell, through the real application menu (编辑→撤销 / 重做, 格式→标题 2, 文件→保存) and
// an OS document (open-file) arriving while the emptied element is live. Prints RESULT lines (values).
//   candidate: MDR_DEV_URL=http://localhost:5436/ node bench/electron/v4-app-desk.mjs [case-prefix]
// Dev shell = electron/ of the tree (MDR_SHELL_DIR to change). Launch only through ./_electron.mjs (isolated
// profile). Documents in a temp dir under MDR_V4_TMP (default: os tmpdir), removed at exit. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.resolve(ROOT, process.env.MDR_SHELL_DIR || '.');
const TMP = fs.mkdtempSync(path.join(process.env.MDR_V4_TMP || os.tmpdir(), 'v4desk-'));
const only = process.argv[2] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
let app = null;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await app?.evaluate(({ app: a }) => a.exit(0)); } catch { /* */ } process.exit(3); }, 110_000);
const menuClick = (id) => app.evaluate(({ Menu }, mid) => { const it = Menu.getApplicationMenu().getMenuItemById(mid); if (!it) return false; it.click(); return true; }, id);
const DOC = ['甲段落文字。', '', '乙段落文字。', '', '丙段落文字。', ''].join('\n');
const LISTS = ['- aaa', '', '乙段落文字。', '', '- zzz', ''].join('\n');
const TIGHT = ['# 标题', '乙段落文字。', '', '丙段落文字。', ''].join('\n');
const write = (name, text) => { const p = path.join(TMP, name); fs.writeFileSync(p, text, 'utf8'); return p; };

try {
  app = await electron.launch({ args: [DIR], env: { ...process.env, MDR_DEV_URL: process.env.MDR_DEV_URL || 'http://localhost:5436/' } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  for (let i = 0; i < 300 && !(await page.evaluate(() => !!window.__mdr?.app).catch(() => false)); i++) await sleep(100);
  await sleep(1500);
  const src = () => page.evaluate(() => window.__mdr.app.getText());
  const dialogs = () => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
  const clickDialog = (label) => page.evaluate((label) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; }, label);
  const view = () => page.evaluate(() => {
    const pv = document.querySelector('.mdr-preview');
    const blocks = [...pv.querySelectorAll('.md-block')].filter((e) => !e.parentElement.closest('.md-block'));
    const ids = blocks.map((e) => e.dataset.id);
    return { shown: blocks.map((e) => e.textContent.trim().slice(0, 8)), editing: pv.querySelector('.is-editing')?.textContent.trim() ?? null, dup: ids.length - new Set(ids).size };
  });
  const openPath = async (p) => {
    await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, p);
    for (let i = 0; i < 60; i++) { if ((await src().catch(() => '')) === fs.readFileSync(p, 'utf8')) break; await sleep(100); }
    await page.evaluate(() => window.__mdr.waitIdle()); await sleep(500);
  };
  const point = (needle) => page.evaluate((needle) => {
    const w = document.createTreeWalker(document.querySelector('.mdr-preview'), NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2);
      const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
    }
    return null;
  }, needle);
  async function emptied(needle) {
    for (let i = 0; i < 3; i++) {
      const p = await point(needle);
      if (p) { await page.mouse.click(p.x, p.y); await sleep(250); }
      if (await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'))) break;
      await sleep(400);
    }
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace');
  }
  const reset = async (name, text) => {
    await page.keyboard.press('Escape').catch(() => {});
    await clickDialog('取消');
    await page.evaluate(() => window.__mdr.loadText('', 'blank.md'));
    await sleep(200);
    const p = write(name, text);
    await openPath(p);
    return p;
  };
  const t = async (name, fn) => { if (only && !name.startsWith(only)) return; try { out(name, await fn()); } catch (e) { out(name, `ERROR ${String(e.message).split('\n')[0]}`); } };

  for (const [dn, doc] of [['para', DOC], ['lists', LISTS], ['tight', TIGHT]]) {
    await t(`G1 ${dn} emptied, menu 撤销, type Q`, async () => {
      await reset(`g1-${dn}.md`, doc);
      await emptied('乙段落');
      await sleep(700);
      const del = await src();
      await menuClick('edit.undo'); await sleep(900);
      const u = await src();
      const v1 = await view();
      await page.keyboard.type('Q'); await sleep(700);
      return { del, undoIsDoc: u === doc, v1, afterQ: await src(), v2: await view() };
    });
    await t(`G2 ${dn} emptied, menu 撤销 + 重做, type Q`, async () => {
      await reset(`g2-${dn}.md`, doc);
      await emptied('乙段落');
      await sleep(700);
      const del = await src();
      await menuClick('edit.undo'); await sleep(700);
      await menuClick('edit.redo'); await sleep(900);
      const r = await src();
      const v1 = await view();
      await page.keyboard.type('Q'); await sleep(700);
      return { redoIsDel: r === del, v1, afterQ: await src(), v2: await view() };
    });
    await t(`G3 ${dn} emptied, type Q, menu 保存 at 0 ms`, async () => {
      const p = await reset(`g3-${dn}.md`, doc);
      await emptied('乙段落');
      await sleep(80);
      await page.keyboard.type('Q');
      await menuClick('file.save'); await sleep(1300);
      const disk = fs.readFileSync(p, 'utf8');
      const s = await src();
      const edited = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited());
      return { diskEqSrc: disk === s, disk, edited };
    });
    await t(`G4 ${dn} emptied, menu 标题 2`, async () => {
      await reset(`g4-${dn}.md`, doc);
      await emptied('乙段落');
      await sleep(700);
      const del = await src();
      await menuClick('edit.heading2'); await sleep(900);
      return { del, after: await src(), v: await view() };
    });
    await t(`G5 ${dn} emptied + Q typed, OS sends another document: question, 丢弃`, async () => {
      await reset(`g5-${dn}.md`, doc);
      await emptied('乙段落');
      await sleep(60);
      await page.keyboard.type('Q');
      const other = write(`g5-other-${dn}.md`, '# OTHER\n\nother body\n');
      await app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); }, other);
      await sleep(1200);
      const q = await dialogs();
      await clickDialog('丢弃'); await sleep(1500);
      const s = await src();
      const v = await view();
      const title = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { t: w.getTitle(), edited: w.isDocumentEdited() }; });
      return { q, isOther: s === '# OTHER\n\nother body\n', hasQ: s.includes('Q'), v, title };
    });
  }
} finally {
  clearTimeout(KILL);
  try { await app?.close(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}
