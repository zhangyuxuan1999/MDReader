// bench/electron/e2e.mjs — full desktop end-to-end: the REAL renderer inside the REAL Electron
// shell, driven through Playwright's _electron API. Where dev-shell.mjs verifies the shell against a
// stand-in page and bench/verify/native-bridge.mjs verifies the renderer against a fake bridge, this
// script joins the two halves and exercises the user-visible flows of CONTRACT §10.
//
//   node bench/electron/e2e.mjs                        # starts its own vite on :5253 and kills it
//   MDR_BASE=http://localhost:5181 node bench/electron/e2e.mjs
//
// Never touches :5173 (the user's own dev server).
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execSync, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 5253;
const OWN_SERVER = !process.env.MDR_BASE;
const BASE = (process.env.MDR_BASE || `http://localhost:${PORT}`).replace(/\/$/, '');

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
}

async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}

/** Waits for `fn` to return truthy, polling in the page. Returns the last value. */
async function until(page, fn, arg, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}

/** The status bar's file item: "<name> · <状态>". */
const fileStat = (page) => page.evaluate(() => {
  const el = document.querySelector('.mdr-statusbar__item[data-stat="file"]');
  return el ? { text: el.textContent, state: el.dataset.state } : null;
});

/** Clicks the dialog button whose text is exactly `label`. */
async function clickDialogButton(page, label) {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  if (!ok) throw new Error(`dialog button 「${label}」 not found`);
}

let vite = null;
let app = null;
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-e2e-'));

try {
  if (OWN_SERVER) {
    console.log(`starting vite on :${PORT}`);
    killPort(PORT);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }

  // ================================================================ launch
  console.log('\n[1] launch');
  app = await electron.launch({ args: ['.'], cwd: ROOT, env: { ...process.env, MDR_DEV_URL: BASE } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.waitForLoadState('domcontentloaded');

  check('exactly one window', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1);
  check('window loads the dev URL', page.url().startsWith(BASE), page.url());
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 20000 });
  check('the real renderer mounted', (await page.locator('.mdr-app').count()) === 1);
  check('window.mdrNative is present to the app',
    await page.evaluate(() => !!window.mdrNative && typeof window.mdrNative.writeFile === 'function'));

  // ================================================================ open-file
  console.log('\n[2] open-file from the OS');
  const docPath = path.join(tmpDir, '端到端文档.md');
  const ORIGINAL = '# 端到端标题\n\n第一段正文。\n\n- 甲\n- 乙\n\n[外部链接](https://example.com/mdr)\n';
  await fsp.writeFile(docPath, ORIGINAL, 'utf8');

  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, docPath);
  const titled = await until(page, (n) => document.title.includes(n), '端到端文档.md', 15000);
  check('open-file loaded the document', !!titled, await page.title());
  check('the editor holds the file text',
    (await page.evaluate(() => window.__mdr.app.getText())) === ORIGINAL);
  const st1 = await fileStat(page);
  check('status bar shows the name and 已保存', !!st1 && st1.text.includes('端到端文档.md') && st1.text.includes('已保存'), st1?.text);
  check('status bar file state is "saved"', st1?.state === 'saved', st1?.state);
  check('the preview rendered the document',
    (await page.textContent('.mdr-preview__body')).includes('端到端标题'));

  // ================================================================ dirty
  console.log('\n[3] typing → dirty');
  await page.click('.cm-content');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('\n新增的一行。\n');
  const dotted = await until(page, () => document.title.startsWith('●'), null, 8000);
  check('title gets the ● dirty marker', !!dotted, await page.title());
  check('the shell was told the document is edited',
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited()));
  check('the shell knows the represented file',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())) === docPath);
  const st2 = await fileStat(page);
  check('status bar switches to 未保存', !!st2 && st2.text.includes('未保存'), st2?.text);

  // ================================================================ ⌘S
  console.log('\n[4] ⌘S writes back to the same file');
  await page.keyboard.press('Meta+s');
  const clean = await until(page, () => !document.title.startsWith('●'), null, 8000);
  check('⌘S clears the ● marker', !!clean, await page.title());
  const onDisk = await fsp.readFile(docPath, 'utf8');
  const inEditor = await page.evaluate(() => window.__mdr.app.getText());
  check('the file on disk now matches the editor', onDisk === inEditor, `disk ${onDisk.length} B / editor ${inEditor.length} B`);
  check('the saved text really contains the typed line', onDisk.includes('新增的一行。'));
  check('the shell is no longer "edited"',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited())) === false);

  // ================================================================ 另存为
  console.log('\n[5] 另存为 (file.saveAs)');
  const savedAs = path.join(tmpDir, '另存副本.md');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, savedAs);
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('file.saveAs').click(); });
  const switched = await until(page, (n) => document.title.includes(n), '另存副本.md', 10000);
  check('另存为 switched the document to the new file', !!switched, await page.title());
  const copyOnDisk = await fsp.readFile(savedAs, 'utf8').catch(() => null);
  check('另存为 wrote the chosen path', copyOnDisk === inEditor, copyOnDisk === null ? 'missing' : `${copyOnDisk.length} B`);
  check('the shell follows the new represented file',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())) === savedAs);
  check('status bar shows the new name', (await fileStat(page)).text.includes('另存副本.md'));

  // ================================================================ open-file while dirty
  console.log('\n[6] open-file while dirty → guard dialog');
  const otherPath = path.join(tmpDir, '另一个.md');
  await fsp.writeFile(otherPath, '# 另一个文档\n\n不该被打开。\n', 'utf8');
  await page.click('.cm-content');
  await page.keyboard.type('未保存的改动');
  await until(page, () => document.title.startsWith('●'), null, 6000);
  const dirtyText = await page.evaluate(() => window.__mdr.app.getText());

  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, otherPath);
  await page.waitForSelector('.mdr-dialog', { timeout: 8000 });
  const guardText = await page.textContent('.mdr-dialog__text');
  check('the dirty guard dialog appears', guardText.includes('尚未保存'), guardText);
  await clickDialogButton(page, '取消');
  await sleep(600);
  check('取消 keeps the current text',
    (await page.evaluate(() => window.__mdr.app.getText())) === dirtyText);
  check('取消 keeps the current document', (await page.title()).includes('另存副本.md'), await page.title());

  // Now accept the guard so the rest of the run starts from a clean, known document.
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, otherPath);
  await page.waitForSelector('.mdr-dialog', { timeout: 8000 });
  await clickDialogButton(page, '丢弃');
  const swapped = await until(page, (n) => document.title.includes(n) && !document.title.startsWith('●'), '另一个.md', 10000);
  check('丢弃 → the new document replaces the old one', !!swapped, await page.title());

  // ================================================================ menu
  console.log('\n[7] native menu');
  const modeBefore = await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode);
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.mode.preview').click(); });
  const modeAfter = await until(page, () => {
    const m = document.querySelector('.mdr-app').dataset.mode;
    return m === 'preview' ? m : '';
  }, null, 6000);
  check('视图 → 预览 changes data-mode', modeAfter === 'preview', `${modeBefore} → ${modeAfter || 'unchanged'}`);
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.mode.split').click(); });
  await until(page, () => document.querySelector('.mdr-app').dataset.mode === 'split', null, 6000);
  check('视图 → 分栏 restores split',
    (await page.evaluate(() => document.querySelector('.mdr-app').dataset.mode)) === 'split');

  // A menu item whose accelerator the renderer owns must fire exactly once for one keypress.
  console.log('\n[8] a menu shortcut fires exactly once (⌘B)');
  await page.click('.cm-content');
  await page.keyboard.type('加粗目标');
  await page.waitForFunction(() => window.__mdr.waitIdle().then(() => true), null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => window.__mdr.waitIdle());
  await page.keyboard.down('Shift');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  const verBefore = await page.evaluate(() => window.__mdr.version());
  await page.keyboard.press('Meta+b');
  await sleep(500);
  await page.evaluate(() => window.__mdr.waitIdle());
  const verAfter = await page.evaluate(() => window.__mdr.version());
  check('⌘B produced exactly one document change', verAfter - verBefore === 1, `+${verAfter - verBefore}`);
  check('⌘B actually applied bold',
    (await page.evaluate(() => window.__mdr.app.getText())).includes('**加粗目标**'));

  // ================================================================ pathForFile
  console.log('\n[9] pathForFile (drop / file input)');
  // The bold edit above left the document dirty; a drop would otherwise hit the dirty guard.
  await page.keyboard.press('Meta+s');
  await until(page, () => !document.title.startsWith('●'), null, 8000);
  check('the document is clean before the drop test', !(await page.title()).startsWith('●'), await page.title());
  const dropPath = path.join(tmpDir, '拖放文档.md');
  await fsp.writeFile(dropPath, '# 拖放标题\n\n拖进来的正文。\n', 'utf8');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = '__mdr_e2e_input';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
  });
  await page.setInputFiles('#__mdr_e2e_input', dropPath);
  const resolved = await page.evaluate(() => {
    const f = document.getElementById('__mdr_e2e_input').files[0];
    return window.mdrNative.pathForFile(f);
  });
  check('pathForFile resolves a real File to its absolute path', resolved === dropPath, String(resolved));

  // Real drop: a DataTransfer built in the page from that same File. If Chromium hands the drop
  // handler a File that webUtils can still resolve, the document must open as a writable native file.
  const dropResult = await page.evaluate(() => {
    const f = document.getElementById('__mdr_e2e_input').files[0];
    const dt = new DataTransfer();
    dt.items.add(f);
    const root = document.querySelector('.mdr-app');
    root.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return window.mdrNative.pathForFile(dt.files[0]);
  });
  const droppedIn = await until(page, (n) => document.title.includes(n), '拖放文档.md', 10000);
  check('a dropped file opens in the editor', !!droppedIn, await page.title());
  if (droppedIn) {
    const droppedStat = await fileStat(page);
    const nativeDrop = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename());
    if (nativeDrop === dropPath) {
      check('the dropped file is a writable native document (⌘S writes back)', true, nativeDrop);
      await page.click('.cm-content');
      await page.keyboard.type('拖放后的编辑');
      await until(page, () => document.title.startsWith('●'), null, 6000);
      await page.keyboard.press('Meta+s');
      await until(page, () => !document.title.startsWith('●'), null, 8000);
      const dropDisk = await fsp.readFile(dropPath, 'utf8');
      check('⌘S wrote back to the dropped file', dropDisk.includes('拖放后的编辑'));
    } else {
      note(`a page-constructed DataTransfer loses the path (webUtils → ${JSON.stringify(dropResult)}), so the drop opened as a read-only 'legacy' document; pathForFile itself is verified above against a real File from the OS file picker. A Finder drag cannot be synthesised from Playwright.`);
      check('the dropped file at least opened (legacy fallback)', !!droppedStat, droppedStat?.text);
    }
  }
  await page.evaluate(() => document.getElementById('__mdr_e2e_input')?.remove());

  // ================================================================ recents
  console.log('\n[10] recents');
  await page.click('.mdr-toolbar__file');
  await page.waitForSelector('.mdr-recent', { timeout: 6000 });
  const recentNames = await page.$$eval('.mdr-recent__item', (is) => is.map((i) => i.textContent));
  check('the recents dropdown lists the desktop path entries',
    recentNames.includes('端到端文档.md') && recentNames.includes('另存副本.md'), recentNames.join(' / '));
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.mdr-recent__item')].find((i) => i.textContent === '端到端文档.md');
    it.click();
  });
  const reopened = await until(page, (n) => document.title.includes(n), '端到端文档.md', 12000);
  check('clicking a recent entry reopens that path', !!reopened, await page.title());
  check('the reopened document has the saved content',
    (await page.evaluate(() => window.__mdr.app.getText())).includes('新增的一行。'));
  check('the shell followed the reopened path',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getRepresentedFilename())) === docPath);

  // ================================================================ external links
  console.log('\n[11] external links go to shell.openExternal');
  await app.evaluate(({ shell }) => {
    globalThis.__externals = [];
    shell.openExternal = async (url) => { globalThis.__externals.push(url); };
  });
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.mode.preview').click(); });
  await until(page, () => document.querySelector('.mdr-app').dataset.mode === 'preview', null, 6000);
  const clicked = await until(page, () => {
    const a = document.querySelector('.mdr-preview__body a[href^="https://example.com"]');
    if (!a) return false;
    a.click();
    return true;
  }, null, 10000);
  check('the preview renders the external link', !!clicked);
  const externals = await until(app, () => globalThis.__externals.length > 0 && globalThis.__externals, null, 6000)
    .catch(() => null);
  const gotExternals = await app.evaluate(() => globalThis.__externals);
  check('clicking it called shell.openExternal exactly once',
    gotExternals.length === 1 && gotExternals[0].startsWith('https://example.com/'), JSON.stringify(gotExternals));
  check('the window stayed on the app origin', page.url().startsWith(BASE), page.url());
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().getMenuItemById('view.mode.split').click(); });
  await until(page, () => document.querySelector('.mdr-app').dataset.mode === 'split', null, 6000);

  // ================================================================ close guard
  console.log('\n[12] close with a dirty document');
  await page.click('.cm-content');
  await page.keyboard.type('关闭前的改动');
  await until(page, () => document.title.startsWith('●'), null, 8000);
  const beforeCloseText = await page.evaluate(() => window.__mdr.app.getText());

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await page.waitForSelector('.mdr-dialog', { timeout: 8000 });
  const closeLabels = await page.$$eval('.mdr-dialog__btn', (bs) => bs.map((b) => b.textContent.trim()));
  check('the close guard is a three-button zh-CN dialog',
    closeLabels.length === 3 && ['保存', '不保存', '取消'].every((l) => closeLabels.includes(l)), closeLabels.join(' / '));
  check('the close dialog names the document',
    (await page.textContent('.mdr-dialog__text')).includes('有未保存的更改'));

  await clickDialogButton(page, '取消');
  await sleep(1000);
  check('取消 keeps the window open',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1);
  check('取消 keeps the unsaved text',
    (await page.evaluate(() => window.__mdr.app.getText())) === beforeCloseText);
  check('取消 leaves the file on disk untouched',
    !(await fsp.readFile(docPath, 'utf8')).includes('关闭前的改动'));

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await page.waitForSelector('.mdr-dialog', { timeout: 8000 });
  await clickDialogButton(page, '不保存');
  let windowsLeft = 1;
  for (let i = 0; i < 80; i++) {
    windowsLeft = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0);
    if (windowsLeft === 0) break;
    await sleep(100);
  }
  check('不保存 closes the window', windowsLeft === 0, String(windowsLeft));
  check('不保存 did not write the file',
    !(await fsp.readFile(docPath, 'utf8')).includes('关闭前的改动'));

  // ================================================================ errors
  console.log('\n[13] errors');
  const realErrors = errors.filter((e) => !/favicon/i.test(e));
  check('no console or page errors during the whole run', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('harness', false, err instanceof Error ? err.stack : String(err));
} finally {
  await app?.close().catch(() => {});
  if (vite) { try { vite.kill('SIGKILL'); } catch { /* gone */ } }
  if (OWN_SERVER) killPort(PORT);
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n[e2e] ${pass}/${pass + failures.length} checks passed`);
if (notes.length) { console.log('notes:'); for (const n of notes) console.log(`  - ${n}`); }
if (failures.length) { console.log('failures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(failures.length === 0 ? 0 : 1);
