// bench/electron/v5-sw-desk.mjs — verify-switch (round 4 verification): the switch in the desktop shell.
//   MDR_APP_DIR=release/staging-0.2.0.noindex MDR_BASE_DIR=release/baseline-0.1.1.noindex MDR_SW_TMP=<scratch dir>
//   node bench/electron/v5-sw-desk.mjs
// 1. a profile CREATED BY 0.1.1 (the baseline shell, theme toggled, a document opened), then the candidate shell on the
//    same profile: OFF, nothing stored for the switch, the 0.1.1 settings kept, a click starts no session;
// 2. ON through the menu item; a session; text typed and the menu item clicked at once (OFF): the text is in the
//    source, nothing editable is left, the toast reads 关;
// 3. ON again, a session with typed text, then the window is closed (the shell's close question): the question is
//    asked although the text was typed in the preview; 取消 keeps the text; the switch is still ON after a restart.
// Launch only through ./_electron.mjs with an explicit profile in MDR_SW_TMP (removed at the end). No full screen.
// Global timeout 110 s. Writes nothing into the tree.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR || '';
const BASE_DIR = process.env.MDR_BASE_DIR || '';
if (!APP_DIR || !BASE_DIR) { console.error('set MDR_APP_DIR and MDR_BASE_DIR'); process.exit(64); }
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_SW_TMP || os.tmpdir(), 'v5-sw-desk-')));
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

const DOC = '# 开关检查\n\n甲段落文字，用来点击。\n\n乙段落文字。\n';
const FILE = path.join(TMP, 'v5-sw.md');
fs.writeFileSync(FILE, DOC, 'utf8');

async function launch(dir) {
  app = await electron.launch({ args: [dir, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(900);
  return page;
}
const pressed = (page) => page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
const stored = (page, k = 'mdr.previewEdit') => page.evaluate((k) => localStorage.getItem(k), k);
const editing = (page) => page.evaluate(() => document.querySelectorAll('.mdr-preview [contenteditable]').length);
const source = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));
const dialogText = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.replace(/\s+/g, ' ')).join(' | '));
const until = async (fn, ms = 3000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
const menuClick = () => app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit').click(); });
async function openDoc(page) {
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, FILE);
  return until(() => page.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
    if (b) b.click();
    return [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes('甲段落'));
  }), 8000);
}
async function clickPara(page, needle = '甲段落') {
  const pt = await page.evaluate((t) => {
    const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
    const n = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
    const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3);
    const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
  }, needle);
  await page.mouse.click(pt.x, pt.y);
  await sleep(400);
}

try {
  // 1. a profile created by 0.1.1
  let page = await launch(BASE_DIR);
  console.log(`baseline version ${await app.evaluate(({ app: a }) => a.getVersion())}`);
  check('0.1.1: document opened', await openDoc(page));
  await page.click('[data-cmd="view.toggleTheme"]').catch(() => {});
  await sleep(300);
  const baseTheme = await stored(page, 'mdr.theme');
  const baseKeys = await page.evaluate(() => Object.keys(localStorage).sort().join(','));
  console.log(`  0.1.1 stored keys: ${baseKeys} theme=${baseTheme}`);
  await quit();
  page = await launch(APP_DIR);
  console.log(`candidate version ${await app.evaluate(({ app: a }) => a.getVersion())}`);
  check('candidate on the 0.1.1 profile: OFF, nothing stored for the switch', (await pressed(page)) === 'false' && (await stored(page)) === null, `${await pressed(page)} ${await stored(page)}`);
  check('candidate on the 0.1.1 profile: the theme setting kept', (await stored(page, 'mdr.theme')) === baseTheme, `${await stored(page, 'mdr.theme')} vs ${baseTheme}`);
  check('candidate: document opened', await openDoc(page));
  await clickPara(page);
  check('candidate OFF: a click starts no session', (await editing(page)) === 0);
  // 2. ON by the menu item, a session, typing, OFF by the menu item at once
  await menuClick();
  check('menu item: ON', await until(async () => (await pressed(page)) === 'true') && (await stored(page)) === '1');
  await clickPara(page);
  check('ON: a session', (await editing(page)) === 1);
  await page.keyboard.type('MQ');
  await menuClick();
  await sleep(900);
  const s2 = await source(page);
  check('menu item at once after typing: OFF, the typed text in the source', (await pressed(page)) === 'false' && s2.includes('甲段MQ落') && (await stored(page)) === '0', JSON.stringify(s2));
  check('OFF: nothing editable left', (await editing(page)) === 0);
  check('OFF toast 预览可编辑：关', (await toasts(page)).includes('预览可编辑：关'), JSON.stringify(await toasts(page)));
  // 3. ON again, a session with typed text, then the window's close: the question
  await menuClick();
  await until(async () => (await pressed(page)) === 'true');
  await clickPara(page, '乙段落');
  await page.keyboard.type('WZ');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  const asked = await until(async () => (await dialogText(page)).includes('取消'), 4000);
  const dt = await dialogText(page);
  check('window close during a session: the close question is asked', asked, dt.slice(0, 120));
  if (asked) {
    await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '取消'); b?.click(); });
    await sleep(600);
  }
  const s3 = await source(page);
  check('取消: the text typed in the preview is kept', s3.includes('乙段WZ落') || s3.includes('乙WZ段落') || /WZ/.test(s3), JSON.stringify(s3));
  check('取消: the window is still there and nothing editable is left', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1 && (await editing(page)) === 0, String(await editing(page)));
  await quit();
  page = await launch(APP_DIR);
  check('restart after a session: still ON (stored 1)', (await pressed(page)) === 'true' && (await stored(page)) === '1', `${await pressed(page)} ${await stored(page)}`);
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 400));
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`v5-sw-desk: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
