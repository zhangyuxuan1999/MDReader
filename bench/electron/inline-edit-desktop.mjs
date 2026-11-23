// bench/electron/inline-edit-desktop.mjs — in-preview editing in the PACKAGED app (CONTRACT §11 + §10).
//
//   npm run app:build && node bench/electron/inline-edit-desktop.mjs
//
// Launches release/mac-arm64/MDReader.app with an isolated --user-data-dir (so it never shares the
// single-instance lock, localStorage or window state with an installed MDReader the user has open),
// opens a temp .md, checks 视图 → 预览可编辑 toggles the preview's editability, edits a paragraph in the
// preview, presses ⌘S and verifies the bytes on disk. Quits the app and removes the temp dirs.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = process.env.MDR_APP || path.join(ROOT, 'release', 'mac-arm64', 'MDReader.app');
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'MDReader');
if (!fs.existsSync(EXE)) { console.error(`no packaged app at ${APP_DIR} — run npm run app:build`); process.exit(2); }

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}

const PARA = '这是要在预览里修改的段落。';
const DOC = `# 预览编辑桌面验证\n\n${PARA}\n\n第二段保持不变，含 **粗体** 和 \`代码\`。\n`;
const ADDED = '桌面改动';
const EXPECTED = DOC.replace(PARA, PARA + ADDED);

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-inline-desktop-'));
const userData = path.join(tmpDir, 'userData');
const docPath = path.join(tmpDir, '预览编辑.md');
await fsp.writeFile(docPath, DOC, 'utf8');

let app = null;
const errors = [];
try {
  app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`] });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.waitForLoadState('domcontentloaded');
  const ud = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const same = fs.existsSync(ud) && fs.realpathSync(ud) === fs.realpathSync(userData);
  check('isolated userData (no single-instance clash with an installed app)', same, ud);
  if (!same) throw new Error('refusing to continue on the shared userData');

  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, docPath);
  const rendered = await until(() => page.evaluate((t) => [...document.querySelectorAll('.mdr-preview p')].some((p) => p.textContent.includes(t)), PARA));
  check('document opened and rendered', !!rendered);

  const menu = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    const view = m.items.find((i) => i.label === '视图');
    const item = m.getMenuItemById('view.togglePreviewEdit');
    return { inView: !!view && view.submenu.items.some((i) => i.id === 'view.togglePreviewEdit'), label: item?.label, accel: item?.accelerator };
  });
  check('视图 menu has 预览可编辑', menu.inView && menu.label === '预览可编辑（实验性）' /* release decision 0.2.0 */, `${menu.label} ${menu.accel}`);

  const pressed = () => page.evaluate(() => document.querySelector('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
  // Release decision for 0.2.0 (CONTRACT §11): a packaged app has no test hooks, so a fresh profile starts with
  // 预览可编辑 OFF; the script then turns it on itself through the menu item and continues as before (fix-release).
  check('toggle OFF by default (fresh profile; release decision 0.2.0)', (await pressed()) === 'false');
  check('menu click turns it ON (stored 1)', (await previewEditOn(app, page)) === 'turned-on' && (await page.evaluate(() => localStorage.getItem('mdr.previewEdit'))) === '1');
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit').click(); });
  check('menu click turns it OFF', (await until(async () => (await pressed()) === 'false', 3000)) === true);
  const clickPara = async () => {
    const pt = await page.evaluate((t) => {
      const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
      p.scrollIntoView({ block: 'center' });
      const r = document.createRange(); r.selectNodeContents(p);
      const rs = [...r.getClientRects()].filter((x) => x.width > 0); const last = rs[rs.length - 1];
      return { x: last.right - 2, y: last.top + last.height / 2 };
    }, PARA);
    await page.mouse.click(pt.x, pt.y);
    await sleep(120);
  };
  const editing = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing[contenteditable="true"]'));
  await clickPara();
  check('OFF: a click does not start a session', (await editing()) === false);
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit').click(); });
  check('menu click turns it back ON', (await until(async () => (await pressed()) === 'true', 3000)) === true);

  await clickPara();
  check('ON: a click starts a session', await editing());
  await page.evaluate(() => {
    const p = document.querySelector('.mdr-preview .is-editing p');
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.type(ADDED, { delay: 30 });
  await page.keyboard.press('Meta+s');
  const onDisk = await until(async () => { const t = await fsp.readFile(docPath, 'utf8'); return t.includes(ADDED) ? t : null; }, 5000);
  const bytes = await fsp.readFile(docPath);
  check('⌘S writes the serialized markdown to disk (exact bytes)', !!onDisk && Buffer.compare(bytes, Buffer.from(EXPECTED, 'utf8')) === 0,
    onDisk ? `${bytes.length} bytes` : 'file unchanged');
  check('the session survives ⌘S', await editing());
  const edited = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited());
  check('window not marked edited after save', edited === false);
  await page.keyboard.press('Escape');
  await sleep(300);
  check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.evaluate(({ app: a }) => { a.quit(); });
  await sleep(800);
} catch (err) {
  check('run', false, err instanceof Error ? err.stack : String(err));
} finally {
  await app?.close().catch(() => {});
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n[inline-edit-desktop] ${pass}/${pass + failures.length} checks passed`);
process.exit(failures.length ? 1 : 0);
