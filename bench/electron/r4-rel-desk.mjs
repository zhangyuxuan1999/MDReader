// bench/electron/r4-rel-desk.mjs — fix-release (round 4): the release configuration of 0.2.0 in the desktop shell
// (release decision for 0.2.0, CONTRACT §11) on a candidate directory with a PRODUCTION renderer (no test hooks).
//   MDR_APP_DIR=<scratch>/cand MDR_REL_TMP=<scratch dir> node bench/electron/r4-rel-desk.mjs
// <scratch>/cand = a production build as dist/, plus electron/ and package.json of the tree.
// Checks: the menu item 视图 → 预览可编辑（实验性） (id, label, accelerator); OFF at the first start of a fresh profile;
// a click into the preview starts no session; ON through the menu item (stored 1, a click starts a session, typing
// reaches the source); still ON after a restart with the same profile; OFF again through ⌘⇧E (stored 0); still OFF
// after a second restart. Launch only through ./_electron.mjs; the profile is passed explicitly so it survives
// the restarts and is removed at the end with the temp documents. No full screen involved. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR || '';
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_REL_TMP || os.tmpdir(), 'r4-rel-desk-')));
const PROFILE = path.join(TMP, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
let app = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await a.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.session.flushStorageData(); }); } catch { /* */ }
  await sleep(300);
  try { await Promise.race([a.evaluate(({ app: x }) => { x.exit(0); }), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([a.close().catch(() => {}), sleep(4000)]);
  if (pid) for (let i = 0; i < 30; i++) { try { process.kill(pid, 0); } catch { return; } if (i === 10) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);

const DOC = '# 发布检查\n\n甲段落文字，用来点击。\n\n乙段落文字。\n';
const FILE = path.join(TMP, 'r4-rel.md');
fs.writeFileSync(FILE, DOC, 'utf8');

async function launch() {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.waitForSelector('[data-cmd="view.togglePreviewEdit"]', { timeout: 20000 });
  await sleep(800);
  return page;
}
const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page) => page.evaluate(() => localStorage.getItem('mdr.previewEdit'));
const editing = (page) => page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable="true"]').length);
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const until = async (fn, ms = 3000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
async function openDoc(page) {
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  // a restored draft makes the document dirty: answer the replace question with 丢弃
  return until(() => page.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
    if (b) b.click();
    return [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent === '甲段落文字，用来点击。');
  }), 8000);
}
async function clickPara(page) {
  const pt = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes('甲段落'));
    const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  });
  await page.mouse.click(pt.x, pt.y);
  await sleep(400);
}

try {
  // 1. first start, fresh profile
  let page = await launch();
  console.log(`target ${APP_DIR} (version ${await app.evaluate(({ app: a }) => a.getVersion())})`);
  const menu = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    const view = m.items.find((i) => i.label === '视图');
    const it = m.getMenuItemById('view.togglePreviewEdit');
    return { inView: !!view && view.submenu.items.some((i) => i.id === 'view.togglePreviewEdit'), label: it?.label, accel: it?.accelerator, type: it?.type };
  });
  check('menu: 视图 holds view.togglePreviewEdit, label 预览可编辑（实验性）, accelerator Shift+CmdOrCtrl+E', menu.inView && menu.label === '预览可编辑（实验性）' && menu.accel === 'Shift+CmdOrCtrl+E', JSON.stringify(menu));
  check('no test hooks (production renderer)', await page.evaluate(() => window.__mdr === undefined));
  check('first start: OFF (button not pressed, nothing stored)', (await pressed(page)) === 'false' && (await stored(page)) === null, `${await pressed(page)} ${await stored(page)}`);
  check('document opened', await openDoc(page));
  await sleep(600);
  await clickPara(page);
  check('OFF: a click into the preview starts no session', (await editing(page)) === 0);
  // 2. ON through the menu item
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit').click(); });
  check('menu item turns it ON (button pressed, stored 1)', await until(async () => (await pressed(page)) === 'true') && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
  check('the toast reads 预览可编辑（实验性）：开', (await toasts(page)).includes('预览可编辑（实验性）：开'), JSON.stringify(await toasts(page)));
  await clickPara(page);
  check('ON: a click starts a session', (await editing(page)) === 1);
  await page.keyboard.type('Q');
  await sleep(700);
  const typed = (await source(page)).split('\n').filter((l) => l.includes('Q'));
  check('ON: typing reaches the source', typed.length === 1 && typed[0].replace('Q', '') === '甲段落文字，用来点击。', JSON.stringify(typed));
  await page.keyboard.press('Escape');
  await sleep(300);
  await quit();
  // 3. restart, same profile: still ON
  page = await launch();
  check('after a restart with the same profile: still ON (stored 1)', (await pressed(page)) === 'true' && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
  // 4. OFF through ⌘⇧E
  await page.keyboard.press('Meta+Shift+KeyE');
  check('⌘⇧E turns it OFF (button not pressed, stored 0)', await until(async () => (await pressed(page)) === 'false') && (await stored(page)) === '0', `${await pressed(page)} ${await stored(page)}`);
  check('the toast reads 预览可编辑：关', (await toasts(page)).includes('预览可编辑：关'), JSON.stringify(await toasts(page)));
  await quit();
  // 5. restart again: still OFF
  page = await launch();
  check('after a second restart: still OFF (stored 0)', (await pressed(page)) === 'false' && (await stored(page)) === '0', `${await pressed(page)} ${await stored(page)}`);
  check('document opened (second restart)', await openDoc(page));
  await sleep(600);
  await clickPara(page);
  check('OFF after the restart: a click starts no session', (await editing(page)) === 0);
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 400));
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`r4-rel-desk: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
