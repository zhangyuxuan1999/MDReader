// bench/verify/inline-verify-desktop.mjs — verifier: in-preview editing in the PACKAGED app (CONTRACT §11 + §10).
// Launches release/mac-arm64/MDReader.app (or MDR_APP) with an isolated --user-data-dir (never touches an installed,
// running MDReader), opens temp .md files, and checks: menu toggle + accelerator, the macOS edited dot on the FIRST
// preview edit, ⌘S bytes on disk, Enter split + ⌘S bytes, 编辑→撤销 inside a session, and whether the preview
// jumps when typing in a block scrolled far down (split mode). Quits the app, removes temp dirs.
import { electron } from '../electron/_electron.mjs'; // isolated profile + recent-documents stub, always
import { previewEditOn } from '../electron/r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_DIR = process.env.MDR_APP || path.join(ROOT, 'release', 'mac-arm64', 'MDReader.app');
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'MDReader');
if (!fs.existsSync(EXE)) { console.error(`no packaged app at ${APP_DIR}`); process.exit(2); }
let pass = 0; const failures = []; const meas = [];
const check = (name, cond, detail = '') => { if (cond) pass++; else failures.push(name); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const d = Date.now() + ms; let v; while (Date.now() < d) { v = await fn().catch(() => undefined); if (v) return v; await sleep(50); } return v; }

const DOC = '# 桌面预览编辑\n\n第一段落文字。\n\n第二段落用于回车拆分。\n';
const LONG = fs.readFileSync(path.join(ROOT, 'test-data/small.md'), 'utf8');
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-verify-desktop-'));
const userData = path.join(tmp, 'userData');
const f1 = path.join(tmp, '验证一.md'); const f2 = path.join(tmp, '长文档.md');
await fsp.writeFile(f1, DOC, 'utf8'); await fsp.writeFile(f2, LONG, 'utf8');
let app = null; const errors = [];
try {
  app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`] });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.waitForLoadState('domcontentloaded');
  const ud = await app.evaluate(({ app: a }) => a.getPath('userData'));
  if (!(fs.existsSync(ud) && fs.realpathSync(ud) === fs.realpathSync(userData))) throw new Error(`shared userData ${ud}`);
  const open = async (p, needle) => { await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, p); return until(() => page.evaluate((t) => [...document.querySelectorAll('.mdr-preview p')].some((x) => x.textContent.includes(t)), needle)); };
  const edited = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited());
  const title = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  const editing = () => page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing[contenteditable="true"]'));
  const clickText = async (needle, where = 'end') => {
    const pt = await page.evaluate(({ t, where }) => {
      const p = [...document.querySelectorAll('.mdr-preview p')].find((x) => x.textContent.includes(t));
      const r0 = p.getBoundingClientRect(); const v = document.querySelector('.mdr-preview').getBoundingClientRect();
      if (r0.top < v.top || r0.bottom > v.bottom) p.scrollIntoView({ block: 'center' });
      const n = document.createTreeWalker(p, 4).nextNode(); const i = n.data.indexOf(t) + (where === 'end' ? t.length - 1 : 0);
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const b = r.getBoundingClientRect();
      return { x: where === 'end' ? b.right - 1 : b.left + 1, y: b.top + b.height / 2 };
    }, { t: needle, where });
    await page.mouse.click(pt.x, pt.y); await sleep(120);
  };
  const caretAfter = (needle) => page.evaluate((t) => { const el = document.querySelector('.mdr-preview .is-editing'); const w = document.createTreeWalker(el, 4); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(t); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + t.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; }, needle);

  check('document opened', !!(await open(f1, '第一段落')));
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  await previewEditOn(app, page);
  const menu = await app.evaluate(({ Menu }) => { const it = Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit'); return { label: it?.label, accel: it?.accelerator, type: it?.type, checked: it?.checked }; });
  check('视图 → 预览可编辑 with ⇧⌘E accelerator', menu.label === '预览可编辑（实验性）' /* release decision 0.2.0 */ && /Shift\+CmdOrCtrl\+E|CmdOrCtrl\+Shift\+E/.test(menu.accel ?? ''), JSON.stringify(menu));
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit').click(); });
  await sleep(200);
  const offState = await page.evaluate(() => document.querySelector('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.togglePreviewEdit').click(); });
  await sleep(200);
  const onState = await page.evaluate(() => document.querySelector('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed'));
  check('menu toggles OFF then ON', offState === 'false' && onState === 'true', `${offState} → ${onState}`);

  // dirty dot on the first preview edit
  check('window not edited before any edit', (await edited()) === false);
  await clickText('第一段落文字。');
  check('session starts', await editing());
  check('click alone does not mark the window edited', (await edited()) === false);
  await caretAfter('第一段落文字。');
  const t0 = Date.now();
  await page.keyboard.type('改');
  const dot = await until(async () => (await edited()) === true, 3000);
  meas.push({ name: 'desktop: first preview keystroke → macOS edited dot', value: `${Date.now() - t0} ms`, target: 'appears', pass: !!dot });
  check('edited dot appears on the FIRST preview keystroke', !!dot, `${Date.now() - t0} ms, title «${await title()}»`);
  await page.keyboard.press('Meta+s');
  const disk1 = await until(async () => { const t = await fsp.readFile(f1, 'utf8'); return t.includes('改') ? t : null; }, 5000);
  check('⌘S bytes on disk exact', disk1 === DOC.replace('第一段落文字。', '第一段落文字。改'), JSON.stringify(disk1));
  check('edited dot cleared after ⌘S; session kept', (await until(async () => (await edited()) === false, 3000)) === true && (await editing()));

  // Enter split + ⌘S
  await page.keyboard.press('Escape'); await sleep(200);
  await clickText('第二段落用于回车拆分。');
  await caretAfter('第二段落');
  await page.keyboard.press('Enter');
  await sleep(300);
  await page.keyboard.type('xin');
  await sleep(300);
  await page.keyboard.press('Meta+s');
  const want2 = DOC.replace('第一段落文字。', '第一段落文字。改').replace('第二段落用于回车拆分。', '第二段落\n\nxin用于回车拆分。');
  const disk2 = await until(async () => { const t = await fsp.readFile(f1, 'utf8'); return t === want2 ? t : null; }, 5000);
  check('Enter split + typing + ⌘S → exact bytes', !!disk2, JSON.stringify(await fsp.readFile(f1, 'utf8')));

  // 编辑 → 撤销 inside a session (menu item)
  await page.keyboard.type('abc', { delay: 30 });
  await sleep(200);
  const undoItem = await app.evaluate(({ Menu }) => { const m = Menu.getApplicationMenu(); const e = m.items.find((i) => i.label === '编辑'); const u = e?.submenu.items.find((i) => /撤销/.test(i.label)); return u ? { label: u.label, accel: u.accelerator } : null; });
  await page.keyboard.press('Meta+z');
  await sleep(300);
  const afterUndo = await page.evaluate(() => window.__mdr ? null : document.querySelector('.mdr-preview .is-editing')?.textContent);
  check('⌘Z in a session (desktop) undoes typing', typeof afterUndo === 'string' && !afterUndo.includes('abc'), `menu ${JSON.stringify(undoItem)}; block now «${(afterUndo ?? '').trim()}»`);
  await page.keyboard.press('Escape'); await sleep(200);
  await page.keyboard.press('Meta+s'); await sleep(300);

  // long doc: preview jump while typing far down (split mode)
  check('long document opened', !!(await open(f2, '本文件由')));
  await sleep(800);
  const pb = await page.locator('.mdr-preview').boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 3000); await sleep(40); }
  await sleep(600);
  const pt = await page.evaluate(() => {
    const vh = document.querySelector('.mdr-preview').getBoundingClientRect();
    for (const s of document.querySelectorAll('.mdr-preview section.md-block:not(.is-pending)')) { const r = s.getBoundingClientRect(); const p = s.querySelector('p'); if (r.top > vh.top + 50 && r.bottom < vh.bottom - 50 && p && p.textContent.includes('性能测试的段落')) { const n = document.createTreeWalker(p, 4).nextNode(); const i = n.data.indexOf('性能测试'); const rg = document.createRange(); rg.setStart(n, i + 2); rg.setEnd(n, i + 3); const rr = rg.getBoundingClientRect(); return { x: rr.left + 1, y: rr.top + rr.height / 2 }; } }
    return null;
  });
  const mode = await page.evaluate(() => document.querySelector('.mdr-app')?.dataset.mode);
  await page.mouse.click(pt.x, pt.y); await sleep(150);
  const st0 = await page.evaluate(() => document.querySelector('.mdr-preview').scrollTop);
  await page.keyboard.type('xyz', { delay: 40 });
  await sleep(600);
  const st1 = await page.evaluate(() => document.querySelector('.mdr-preview').scrollTop);
  meas.push({ name: `desktop (${mode}): preview scroll drift typing 3 chars far down`, value: `${Math.round(st1 - st0)} px (${Math.round(st0)} → ${Math.round(st1)})`, target: '≈ 0', pass: Math.abs(st1 - st0) < 50 });
  check(`desktop ${mode}: preview stays put while typing far down`, Math.abs(st1 - st0) < 50, `scrollTop ${Math.round(st0)} → ${Math.round(st1)}`);
  await page.keyboard.press('Escape'); await sleep(200);
  // revert the long doc edit so quitting does not prompt
  await page.keyboard.press('Meta+s'); await sleep(400);

  check('no console / page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await app.evaluate(({ app: a }) => { a.quit(); }); await sleep(800);
} catch (err) {
  check('run', false, err instanceof Error ? err.stack : String(err));
} finally {
  await app?.close().catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
for (const m of meas) console.log(`MEAS  ${m.name} = ${m.value} (target ${m.target}) ${m.pass ? 'ok' : 'MISS'}`);
console.log(`\n[inline-verify-desktop] ${pass}/${pass + failures.length} checks passed`);
console.log('JSON ' + JSON.stringify({ pass, fail: failures.length, measurements: meas }));
process.exit(failures.length ? 1 : 0);
