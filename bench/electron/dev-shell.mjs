// bench/electron/dev-shell.mjs — drives the Electron shell with Playwright's _electron API and
// checks every guarantee of CONTRACT §10 that lives in the shell.
//
//   node bench/electron/dev-shell.mjs              # starts its own vite on :5251 and kills it again
//   MDR_BASE=http://localhost:5181 node bench/electron/dev-shell.mjs   # reuse a running server
//
// Never touches :5173 (the user's own dev server).
//
// Two launches:
//   A) MDR_DEV_URL = <base>/bench/electron/harness.html — a renderer stand-in that uses nothing but
//      window.mdrNative. The shell's own behaviour (bridge, menu, IPC, open-file queue, close/quit
//      guard) is verified here, with no real App.ts answering resolveClose() first.
//   B) MDR_DEV_URL = <base> — the real renderer, to prove it boots inside the shell.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 5251;
const OWN_SERVER = !process.env.MDR_BASE;
const BASE = (process.env.MDR_BASE || `http://localhost:${PORT}`).replace(/\/$/, '');
const HARNESS_URL = `${BASE}/bench/electron/harness.html`;

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const note = (s) => {
  notes.push(s);
  console.log(`  note ${s}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

const launch = (devUrl) =>
  electron.launch({ args: ['.'], cwd: ROOT, env: { ...process.env, MDR_DEV_URL: devUrl } });

let vite = null;
let app = null;
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-shell-'));

try {
  if (OWN_SERVER) {
    console.log(`starting vite on :${PORT}`);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }

  // ================================================================ A) shell harness
  console.log(`\n=== A) shell against ${HARNESS_URL}`);
  app = await launch(HARNESS_URL);
  let page = await app.firstWindow();
  const harnessErrors = [];
  page.on('pageerror', (e) => harnessErrors.push(String(e)));
  await page.waitForLoadState('domcontentloaded');

  // ---------------------------------------------------------------- 1. window
  console.log('\n[1] window');
  const title = await page.title();
  const winInfo = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const b = w.getBounds();
    return { count: BrowserWindow.getAllWindows().length, title: w.getTitle(), width: b.width, height: b.height, url: w.webContents.getURL() };
  });
  check('exactly one window', winInfo.count === 1, String(winInfo.count));
  check('loads MDR_DEV_URL', winInfo.url === HARNESS_URL, winInfo.url);
  check('window title follows document.title', winInfo.title === title && title === 'MDReader 外壳测试页', `${winInfo.title} / ${title}`);
  check('default size 1400×900', winInfo.width === 1400 && winInfo.height === 900, `${winInfo.width}×${winInfo.height}`);

  // ---------------------------------------------------------------- 2. bridge surface
  console.log('\n[2] window.mdrNative (src/shared/native.ts)');
  const surface = await page.evaluate(() => {
    const n = window.mdrNative;
    if (!n) return null;
    const types = {};
    for (const k of [
      'platform', 'version', 'openDialog', 'saveDialog', 'readFile', 'writeFile', 'pathForFile',
      'onOpenFile', 'onCommand', 'resolveClose', 'setDocumentState', 'addRecent',
    ]) types[k] = typeof n[k];
    return { types, platform: n.platform, version: n.version, keys: Object.keys(n).length };
  });
  check('window.mdrNative exists', !!surface);
  if (surface) {
    for (const [k, t] of Object.entries(surface.types)) {
      const want = k === 'platform' || k === 'version' ? 'string' : 'function';
      check(`mdrNative.${k} is ${want}`, t === want, t);
    }
    check('platform is darwin', surface.platform === 'darwin', surface.platform);
    check('version comes from package.json', /^\d+\.\d+\.\d+/.test(surface.version), surface.version);
    check('bridge exposes exactly the 12 MdrNative members', surface.keys === 12, String(surface.keys));
  }
  check('contextIsolation: no node globals leak into the renderer',
    await page.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'));

  // ---------------------------------------------------------------- 3. menu
  console.log('\n[3] native menu');
  const menu = await app.evaluate(({ Menu }) => {
    const dump = (items) => items.map((i) => ({
      id: i.id, label: i.label, role: i.role, accelerator: i.accelerator,
      registerAccelerator: i.registerAccelerator, submenu: i.submenu ? dump(i.submenu.items) : undefined,
    }));
    const m = Menu.getApplicationMenu();
    return m ? dump(m.items) : null;
  });
  check('application menu installed', !!menu);
  const flat = [];
  (function walk(items) { for (const i of items || []) { flat.push(i); walk(i.submenu); } })(menu || []);
  const roles = new Set(flat.map((i) => (i.role || '').toLowerCase()).filter(Boolean));
  check('top level is zh-CN',
    JSON.stringify((menu || []).map((m) => m.label)) === JSON.stringify(['MDReader', '文件', '编辑', '格式', '视图', '窗口']),
    JSON.stringify((menu || []).map((m) => m.label)));
  const EXPECTED = [
    'file.new', 'file.open', 'file.save', 'file.saveAs', 'file.exportHtml',
    'edit.find', 'edit.gotoLine', 'edit.bold', 'edit.italic', 'edit.code', 'edit.link',
    'edit.heading1', 'edit.heading2', 'edit.heading3', 'edit.heading4', 'edit.heading5', 'edit.heading6',
    'edit.paragraph', 'edit.toggleTask', 'view.mode.edit', 'view.mode.split', 'view.mode.preview',
    'view.cycleMode', 'view.toggleToc', 'view.toggleTheme', 'view.palette', 'view.mountAll',
  ];
  const menuIds = flat.map((i) => i.id).filter(Boolean);
  check('every CommandId has a menu item', EXPECTED.every((id) => menuIds.includes(id)),
    EXPECTED.filter((id) => !menuIds.includes(id)).join(','));
  const bound = flat.filter((i) => EXPECTED.includes(i.id) && i.id !== 'file.new');
  check('renderer-bound accelerators are NOT registered natively',
    bound.every((i) => i.registerAccelerator === false),
    bound.filter((i) => i.registerAccelerator !== false).map((i) => i.id).join(','));
  check('⌘N (the one command the renderer leaves unbound) IS registered',
    flat.find((i) => i.id === 'file.new')?.registerAccelerator === true);
  for (const r of ['recentdocuments', 'close', 'cut', 'copy', 'paste', 'pasteandmatchstyle', 'selectall', 'minimize', 'zoom', 'front', 'quit', 'about', 'hide']) {
    check(`role ${r} present`, roles.has(r));
  }
  // 撤销 / 重做 are custom items, not roles (fix round 2): AppKit's redo role reaches Chromium's Redo
  // editor command, which cannot drive CodeMirror 6's history — the menu item did nothing at all.
  // The renderer runs CodeMirror's undo/redo for them (src/app/native.ts).
  for (const [id, label] of [['edit.undo', '撤销'], ['edit.redo', '重做']]) {
    const item = flat.find((i) => i.id === id);
    check(`「${label}」 is a custom item with an unregistered accelerator`,
      !!item && !!item.accelerator && item.registerAccelerator === false,
      JSON.stringify(item || null));
  }
  check('undo / redo are NOT AppKit roles any more', !roles.has('undo') && !roles.has('redo'));
  check('reload / devtools roles present in dev', roles.has('toggledevtools') && roles.has('reload'));

  // exactly-once command delivery
  await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const i of items) {
        if (i.id === 'file.save') return i;
        if (i.submenu) { const f = find(i.submenu.items); if (f) return f; }
      }
      return null;
    };
    find(Menu.getApplicationMenu().items).click();
  });
  await sleep(200);
  let cmds = await page.evaluate(() => window.__cmds);
  check('menu click delivers the CommandId exactly once',
    cmds.filter((c) => c === 'file.save').length === 1, JSON.stringify(cmds));

  await page.evaluate(() => { window.__cmds.length = 0; });
  await page.keyboard.press('Meta+KeyS');
  await page.keyboard.press('Meta+Shift+KeyP');
  await page.keyboard.press('Meta+KeyB');
  await sleep(250);
  cmds = await page.evaluate(() => window.__cmds);
  check('⌘S / ⇧⌘P / ⌘B do not fire natively (the renderer owns them)', cmds.length === 0, JSON.stringify(cmds));

  await page.evaluate(() => { window.__offCmd(); window.__cmds.length = 0; });
  await app.evaluate(({ Menu }) => {
    const find = (items) => { for (const i of items) { if (i.id === 'file.open') return i; if (i.submenu) { const f = find(i.submenu.items); if (f) return f; } } return null; };
    find(Menu.getApplicationMenu().items).click();
  });
  await sleep(200);
  check('onCommand unsubscribe removes the listener', (await page.evaluate(() => window.__cmds)).length === 0);
  await page.evaluate(() => {
    window.__offCmd = window.mdrNative.onCommand((id) => {
      window.__cmds.push(id);
      if (id === 'app.closeRequested' && window.__autoResolve) window.mdrNative.resolveClose(window.__autoResolve);
    });
  });

  // ---------------------------------------------------------------- 4. file IPC
  console.log('\n[4] readFile / writeFile / dialogs');
  const docPath = path.join(tmpDir, '测试文档.md');
  await fsp.writeFile(docPath, '# 标题一\n\n第一段内容。\n', 'utf8');

  const read = await page.evaluate((p) => window.mdrNative.readFile(p), docPath);
  check('readFile returns {path,name,text,lastModified}',
    read.path === docPath && read.name === '测试文档.md' && read.text.startsWith('# 标题一') && read.lastModified > 0,
    JSON.stringify({ ...read, text: read.text.slice(0, 12) }));

  const written = await page.evaluate(([p, t]) => window.mdrNative.writeFile(p, t), [docPath, '# 标题一\n\n改过的内容。\n']);
  check('writeFile returns a fresh mtime', typeof written.lastModified === 'number' && written.lastModified > 0);
  check('writeFile roundtrip hits the same file', (await fsp.readFile(docPath, 'utf8')).includes('改过的内容'));
  check('atomic write leaves no temp file', (await fsp.readdir(tmpDir)).every((f) => !f.includes('.mdr-')));
  const mode = (await fsp.stat(docPath)).mode & 0o777;
  check('atomic write preserves the file mode', mode === 0o644, mode.toString(8));

  const errNoent = await page.evaluate((p) => window.mdrNative.readFile(p).then(() => null, (e) => e), path.join(tmpDir, 'nope.md'));
  check('readFile(missing) rejects with {code:ENOENT}', errNoent?.code === 'ENOENT', JSON.stringify(errNoent));
  const errDir = await page.evaluate((p) => window.mdrNative.readFile(p).then(() => null, (e) => e), tmpDir);
  check('readFile(directory) rejects with {code:EISDIR}', errDir?.code === 'EISDIR', JSON.stringify(errDir));
  const errRel = await page.evaluate(() => window.mdrNative.readFile('relative.md').then(() => null, (e) => e));
  check('readFile(relative) is rejected by the argument guard', typeof errRel?.code === 'string', JSON.stringify(errRel));
  const errWrite = await page.evaluate(() => window.mdrNative.writeFile('/no/such/dir/x.md', 'x').then(() => null, (e) => e));
  check('writeFile into a missing directory rejects with {code:ENOENT}', errWrite?.code === 'ENOENT', JSON.stringify(errWrite));
  const errPerm = await page.evaluate(() => window.mdrNative.writeFile('/System/x.md', 'x').then(() => null, (e) => e));
  check('writeFile into a read-only location rejects with a NativeFileError',
    errPerm && ['EACCES', 'EIO', 'UNKNOWN', 'ENOENT'].includes(errPerm.code), JSON.stringify(errPerm));

  const savePath = path.join(tmpDir, '另存为.md');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, savePath);
  check('saveDialog returns the chosen path',
    (await page.evaluate(() => window.mdrNative.saveDialog('未命名.md', null))) === savePath);
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  check('saveDialog returns null when cancelled',
    (await page.evaluate(() => window.mdrNative.saveDialog('未命名.md', null))) === null);

  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, docPath);
  const opened = await page.evaluate(() => window.mdrNative.openDialog());
  check('openDialog reads the chosen file', opened?.path === docPath && opened.text.includes('改过的内容'), JSON.stringify(opened?.path));
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  check('openDialog returns null when cancelled', (await page.evaluate(() => window.mdrNative.openDialog())) === null);

  // ---------------------------------------------------------------- 5. open-file
  console.log('\n[5] open-file delivery');
  const second = path.join(tmpDir, '第二个.md');
  await fsp.writeFile(second, '# 第二\n', 'utf8');
  await page.evaluate(() => { window.__openedFiles.length = 0; });
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, docPath);
  await sleep(200);
  check('open-file reaches an onOpenFile subscriber',
    (await page.evaluate(() => window.__openedFiles)).includes(docPath));

  await app.evaluate(({ app: a }, ps) => { for (const p of ps) a.emit('open-file', { preventDefault() {} }, p); }, [second, docPath]);
  await sleep(200);
  const delivered = await page.evaluate(() => window.__openedFiles);
  check('multiple open-file events arrive in order',
    delivered.slice(-2)[0] === second && delivered.slice(-1)[0] === docPath, JSON.stringify(delivered.slice(-2)));

  await page.evaluate(() => { window.__openedFiles.length = 0; });
  await app.evaluate(({ app: a }) => { a.emit('open-file', { preventDefault() {} }, 'relative/path.md'); });
  await sleep(150);
  check('a relative open-file path is dropped by the guard',
    (await page.evaluate(() => window.__openedFiles)).length === 0);

  await page.evaluate(() => { window.__offOpen(); window.__openedFiles.length = 0; });
  await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, second);
  await sleep(150);
  check('onOpenFile unsubscribe removes the listener',
    (await page.evaluate(() => window.__openedFiles)).length === 0);

  // ---------------------------------------------------------------- 6. document state
  console.log('\n[6] setDocumentState / addRecent');
  await page.evaluate((p) => window.mdrNative.setDocumentState({ path: p, name: '测试文档.md', dirty: true }), docPath);
  await sleep(150);
  let macState = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { edited: w.isDocumentEdited(), represented: w.getRepresentedFilename() };
  });
  check('dirty → macOS edited dot', macState.edited === true);
  check('path → representedFilename', macState.represented === docPath, macState.represented);
  await page.evaluate(() => window.mdrNative.setDocumentState({ path: null, name: '未命名.md', dirty: false }));
  await sleep(150);
  macState = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { edited: w.isDocumentEdited(), represented: w.getRepresentedFilename() };
  });
  check('clean untitled → no edited dot, no represented file', macState.edited === false && macState.represented === '');
  await page.evaluate((p) => window.mdrNative.addRecent(p), docPath);
  check('addRecent(path) is accepted', true);

  // ---------------------------------------------------------------- 7. quit guard
  console.log('\n[7] before-quit guard');
  await page.evaluate((p) => {
    window.__autoResolve = null;
    window.__cmds.length = 0;
    window.mdrNative.setDocumentState({ path: p, name: '测试文档.md', dirty: true });
  }, docPath);
  await sleep(150);
  await app.evaluate(({ app: a }) => a.quit());
  await sleep(400);
  let alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  cmds = await page.evaluate(() => window.__cmds);
  check('quit while dirty is prevented', alive === 1, String(alive));
  check("renderer gets 'app.closeRequested' on quit", cmds.includes('app.closeRequested'), JSON.stringify(cmds));
  await page.evaluate(() => { window.mdrNative.resolveClose('cancel'); window.__cmds.length = 0; });
  await sleep(400);
  alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check("resolveClose('cancel') aborts the quit", alive === 1, String(alive));

  // ---------------------------------------------------------------- 8. close guard
  console.log('\n[8] window close guard');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await sleep(400);
  alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  cmds = await page.evaluate(() => window.__cmds);
  check('close while dirty is prevented', alive === 1, String(alive));
  check("renderer gets 'app.closeRequested' on close", cmds.includes('app.closeRequested'), JSON.stringify(cmds));
  await page.evaluate(() => { window.mdrNative.resolveClose('cancel'); window.__cmds.length = 0; });
  await sleep(300);
  check("resolveClose('cancel') keeps the window",
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1);

  // a clean document closes straight away
  await page.evaluate(() => window.mdrNative.setDocumentState({ path: null, name: '未命名.md', dirty: false }));
  await sleep(150);
  await page.evaluate(() => { window.__cmds.length = 0; window.__autoResolve = 'discard'; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await sleep(600);
  check('a clean document closes without asking',
    (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0);
  const stateFile = path.join(
    await app.evaluate(({ app: a }) => a.getPath('userData')), 'window-state.json');
  const savedState = await fsp.readFile(stateFile, 'utf8').then(JSON.parse, () => null);
  check('window geometry was persisted to userData/window-state.json',
    savedState && savedState.width > 0 && savedState.height > 0, JSON.stringify(savedState));
  check('harness page raised no errors', harnessErrors.length === 0, harnessErrors.join(' | '));

  await app.close().catch(() => {});
  app = null;

  // ================================================================ B) real renderer
  console.log(`\n=== B) real renderer against ${BASE}`);
  app = await launch(BASE);
  page = await app.firstWindow();
  const appErrors = [];
  page.on('pageerror', (e) => appErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') appErrors.push(m.text()); });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.mdr-app', { timeout: 20000 }).catch(() => {});
  check('the real renderer mounts .mdr-app inside the shell',
    (await page.locator('.mdr-app').count()) === 1);
  check('the renderer sees window.mdrNative', await page.evaluate(() => !!window.mdrNative));
  const realTitle = await page.title();
  const realWinTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  check('window title tracks the renderer document.title', realTitle === realWinTitle, `${realTitle} / ${realWinTitle}`);
  if (appErrors.length) note(`renderer console errors (renderer module): ${appErrors.slice(0, 4).join(' | ')}`);
  else check('no renderer console errors', true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy());
} finally {
  if (app) await app.close().catch(() => {});
  if (vite) {
    try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(300);
    try { process.kill(-vite.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass} checks passed, ${failures.length} failed, ${notes.length} notes`);
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
