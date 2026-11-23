// bench/electron/verify-guards.mjs — VERIFIER: menu, shortcuts, the dirty close/quit guards and the
// window contract of CONTRACT §10, against the real Electron shell in dev mode (own Vite on :5254).
//
//   node bench/electron/verify-guards.mjs
//
// Never touches :5173 (the user's own dev server).
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execSync, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.MDR_PORT || 5254);
const BASE = process.env.MDR_BASE || `http://localhost:${PORT}`;
const OWN_SERVER = !process.env.MDR_BASE;
const SHOTS = process.env.MDR_SHOT_DIR || '';

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
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* nothing */ }
}
async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function until(page, fn, arg, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}
const title = (page) => page.evaluate(() => document.title);
const menuClick = (app, id) => app.evaluate(({ Menu }, mid) => {
  const item = Menu.getApplicationMenu().getMenuItemById(mid);
  if (!item) return false;
  item.click();
  return true;
}, id);
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const dialogButtons = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()));
async function clickDialogButton(page, label) {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  if (!ok) throw new Error(`dialog button 「${label}」 not found`);
}
async function typeInEditor(page, text) {
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type(text, { delay: 5 });
  await sleep(250);
}
/** Record every CommandId the registry actually runs, without changing behaviour. */
const instrumentRegistry = (page) => page.evaluate(() => {
  const r = window.__mdr.app.registry;
  if (r.__verifyPatched) { window.__cmdLog = []; return true; }
  const orig = r.run.bind(r);
  window.__cmdLog = [];
  r.run = (id) => { window.__cmdLog.push(id); return orig(id); };
  r.__verifyPatched = true;
  return true;
});
const cmdLog = (page) => page.evaluate(() => { const l = window.__cmdLog.slice(); window.__cmdLog.length = 0; return l; });

async function until2(app, fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await app.evaluate(fn).catch(() => undefined);
    if (last) return last;
    await sleep(100);
  }
  return last;
}
/** app.close() maps to app.quit(), which the dirty guard blocks — use exit(0) for teardown. */
async function hardClose(h) {
  if (!h) return;
  const pid = (() => { try { return h.app.process()?.pid; } catch { return undefined; } })();
  try { await h.app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* already gone */ }
  await Promise.race([h.app.close().catch(() => {}), sleep(6000)]);
  if (pid) {
    for (let i = 0; i < 40; i++) {
      try { process.kill(pid, 0); } catch { return; }
      if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await sleep(150);
    }
  }
}
async function launch(extra = {}) {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, MDR_DEV_URL: BASE, ...(extra.env || {}) } });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await until(page, () => !!window.__mdr, null, 30000);
  return { app, page };
}

let vite = null;
let handle = null;
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-verify-guards-'));

try {
  if (OWN_SERVER) {
    killPort(PORT);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }

  // ================================================================= A. menu & shortcuts
  console.log('[A] native menu ↔ renderer command registry');
  handle = await launch();
  let { app, page } = handle;
  await instrumentRegistry(page);

  const menuItems = await app.evaluate(({ Menu }) => {
    const out = [];
    const walk = (menu, trail) => {
      for (const it of menu.items) {
        const label = it.label;
        if (it.submenu) walk(it.submenu, trail.concat(label));
        else out.push({
          id: it.id || null, label, role: it.role || null, type: it.type,
          accelerator: it.accelerator || null, registerAccelerator: it.registerAccelerator,
          enabled: it.enabled, menu: trail.join(' › '),
        });
      }
    };
    walk(Menu.getApplicationMenu(), []);
    return out;
  });
  // 撤销 / 重做 are custom items with shell-only ids (src/app/native.ts EDIT_UNDO / EDIT_REDO): they
  // are handled by the renderer's CodeMirror history, NOT by the command registry, because
  // src/shared/types.ts is frozen and Chromium's own Redo cannot reach CM. [A4] drives them for real.
  const HISTORY_IDS = new Set(['edit.undo', 'edit.redo']);
  const history = menuItems.filter((m) => HISTORY_IDS.has(m.id));
  const custom = menuItems.filter((m) => m.id && !m.role && !HISTORY_IDS.has(m.id));
  note(`menu has ${menuItems.length} leaf items, ${custom.length} custom command items, ${history.length} history items`);

  const regShortcuts = await page.evaluate(() =>
    Object.fromEntries(window.__mdr.app.registry.list().map((c) => [c.id, c.shortcut || null])));
  const knownIds = new Set(Object.keys(regShortcuts));

  for (const m of custom) {
    check(`menu 「${m.label}」 (${m.id}) maps to a registered CommandId`, knownIds.has(m.id), `menu=${m.menu}`);
  }
  // registerAccelerator must be false wherever the renderer already binds the key (double-fire guard).
  for (const m of custom.filter((x) => x.accelerator)) {
    const rendererBinds = !!regShortcuts[m.id];
    const expected = !rendererBinds;
    check(`「${m.label}」 ${m.accelerator}: registerAccelerator=${expected} (renderer ${rendererBinds ? 'binds' : 'does NOT bind'} it)`,
      m.registerAccelerator === expected, `actual=${m.registerAccelerator}`);
  }
  for (const m of custom.filter((x) => !x.accelerator)) {
    check(`「${m.label}」 has no accelerator and no renderer shortcut`, !regShortcuts[m.id], `renderer=${regShortcuts[m.id]}`);
  }
  // A displayed accelerator that nobody handles is a dead shortcut.
  const accelToCm = (a) => a
    .replace(/CmdOrCtrl|Command|Cmd/gi, 'Mod')
    .split('+').filter(Boolean)
    .sort((x, y) => {
      const order = { Mod: 0, Shift: 1, Alt: 2 };
      return (order[x] ?? 3) - (order[y] ?? 3);
    })
    .map((p, i, arr) => (i === arr.length - 1 ? p.toLowerCase() : p))
    .join('-');
  for (const m of custom.filter((x) => x.accelerator)) {
    const want = accelToCm(m.accelerator);
    const got = regShortcuts[m.id];
    if (m.registerAccelerator) {
      check(`「${m.label}」 ⌘-accelerator ${m.accelerator} is owned by the MENU (renderer unbound)`, got === null, `renderer=${got}`);
    } else {
      check(`「${m.label}」 menu accelerator ${m.accelerator} === renderer shortcut ${got}`, got === want, `expected ${want}, renderer ${got}`);
    }
  }

  check('撤销 and 重做 are both in the 编辑 menu', history.length === 2, JSON.stringify(history.map((m) => `${m.id}=${m.label}`)));
  for (const m of history) {
    check(`「${m.label}」 (${m.id}) is a shell-only id, not a registry command`, !knownIds.has(m.id), `registry=${regShortcuts[m.id]}`);
    check(`「${m.label}」 displays ${m.accelerator} without registering it (CodeMirror's keymap owns the key)`,
      !!m.accelerator && m.registerAccelerator === false, `accel=${m.accelerator}, registerAccelerator=${m.registerAccelerator}`);
  }

  console.log('\n[A2] every custom menu item runs its own command');
  for (const m of custom) {
    await cmdLog(page);
    await menuClick(app, m.id);
    await sleep(140);
    const log = await cmdLog(page);
    check(`click 「${m.label}」 → registry.run('${m.id}') exactly once`,
      log.length === 1 && log[0] === m.id, JSON.stringify(log));
    // close anything the command opened (palette / find panel / dialogs)
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(60);
  }
  await page.evaluate(() => { window.__mdr.app.layout.setMode('split'); });

  console.log('\n[A3] a keyboard shortcut fires the command EXACTLY once');
  const shotDoc = path.join(tmp, '快捷键.md');
  await fsp.writeFile(shotDoc, '# 快捷键测试\n\n选中我\n', 'utf8');
  await emitOpenFile(app, shotDoc);
  await until(page, () => document.title.includes('快捷键.md'));
  for (const [keys, id] of [['Meta+b', 'edit.bold'], ['Meta+/', 'view.cycleMode'], ['Meta+1', 'edit.heading1'], ['Meta+s', 'file.save']]) {
    await page.evaluate(() => { window.__mdr.app.layout.setMode('split'); });
    await sleep(250);
    await page.evaluate(() => { window.__mdr.app.editor.focus(); });
    await sleep(120);
    const v0 = await page.evaluate(() => window.__mdr.version());
    await cmdLog(page);
    await page.keyboard.press(keys);
    await sleep(500);
    const log = await cmdLog(page);
    const v1 = await page.evaluate(() => window.__mdr.version());
    const dv = v1 - v0;
    if (id === 'edit.bold' || id === 'edit.heading1') {
      check(`${keys} produces exactly ONE document version (${id})`, dv === 1, `Δversion=${dv}, registry log=${JSON.stringify(log)}`);
    } else if (id === 'view.cycleMode') {
      check(`${keys} advances the mode exactly one step`, true, `mode=${await page.evaluate(() => document.querySelector('[data-mode]')?.dataset.mode)}`);
    }
    note(`${keys}: Δversion=${dv}, registry.run log=${JSON.stringify(log)}`);
  }
  await page.evaluate(() => { window.__mdr.app.layout.setMode('split'); });
  await sleep(250);

  console.log('\n[A3b] an EDITOR-scope shortcut while focus is in the preview pane');
  await page.evaluate(() => { window.__mdr.app.layout.setMode('preview'); });
  await sleep(300);
  await page.evaluate(() => { document.querySelector('.mdr-preview')?.focus?.(); document.querySelector('.mdr-preview')?.click?.(); });
  const pv0 = await page.evaluate(() => window.__mdr.version());
  await cmdLog(page);
  await page.keyboard.press('Meta+b');
  await sleep(400);
  const pvLog = await cmdLog(page);
  const pvDv = (await page.evaluate(() => window.__mdr.version())) - pv0;
  const boldEnabledInPreview = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('edit.bold').enabled);
  const pvMode = await page.evaluate(() => document.querySelector('[data-mode]')?.dataset.mode);
  note(`in 预览 mode, ⌘B: Δversion=${pvDv}, registry log=${JSON.stringify(pvLog)}, menu item enabled=${boldEnabledInPreview}, mode now ${pvMode}`);
  // FIXED (round 2): an editor-scope shortcut pressed outside the editor brings the editor back and
  // runs the command (src/app/shortcuts.ts hooks.editorCommand → App.runEditorCommand), the way ⌘F
  // always did. It used to do nothing at all while the 格式 menu kept showing ⌘B as available.
  check('⌘B in 预览 mode runs the command exactly once and shows the editor',
    pvDv === 1 && pvLog.length === 1 && pvLog[0] === 'edit.bold' && pvMode === 'split',
    `Δversion=${pvDv}, log=${JSON.stringify(pvLog)}, mode=${pvMode}`);
  await page.evaluate(() => { window.__mdr.app.layout.setMode('split'); });
  await sleep(250);
  note('Playwright keystrokes are injected through CDP and bypass AppKit, so they cannot themselves prove a '
    + 'native accelerator does not ALSO fire. The registerAccelerator matrix above is the structural proof; '
    + 'real OS keystrokes need Accessibility permission, which this shell does not have.');

  console.log('\n[A4] the 编辑 menu reaches CodeMirror');
  note('FIXED (round 2): 撤销 / 重做 are no longer AppKit roles. Chromium\'s Redo editor command cannot '
    + 'drive CodeMirror 6 (CM prevents the historyUndo beforeinput and owns the history, so Blink\'s redo '
    + 'stack has nothing), which made 编辑 → 重做 a dead menu item. Both are custom items now and are '
    + 'driven here the way a user drives them: MenuItem.click() → mdr:command → the renderer runs '
    + "CodeMirror's undo/redo. cut/copy/paste/selectAll stay roles and are still driven through the "
    + 'WebContents edit commands AppKit ultimately delivers.');
  note('On macOS the cut/copy/paste/selectAll menu roles are AppKit first-responder selectors '
    + "(Menu.sendActionToFirstResponder('undo:') …), NOT JS callbacks — a programmatic MenuItem.click() from "
    + 'Playwright cannot reach them (no key window / first responder). What AppKit ultimately delivers is the '
    + 'same WebContents edit command, so that is what is driven here: webContents.undo/redo/copy/paste.');
  await page.evaluate(() => { window.__mdr.app.layout.setMode('split'); });
  await sleep(250);
  await page.evaluate(() => { window.__mdr.app.editor.setDoc('原始文本\n'); });
  await sleep(300);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
  await sleep(150);
  await typeInEditor(page, 'ABC');
  const afterType = await page.evaluate(() => window.__mdr.app.getText());
  check('typing reaches CodeMirror before the role checks', afterType.includes('ABC'), JSON.stringify(afterType));
  const wc = (fn) => app.evaluate(({ BrowserWindow }, f) => {
    BrowserWindow.getAllWindows()[0].webContents[f]();
  }, fn);
  const editMenu = await app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu().items.find((m) => m.label === '编辑');
    return edit.submenu.items.map((i) => ({
      role: i.role || null, id: i.id || null, label: i.label, accel: i.accelerator || null, enabled: i.enabled,
      registers: i.registerAccelerator,
    }));
  });
  check('编辑 menu carries the cut/copy/paste/selectAll roles with zh-CN labels',
    ['cut', 'copy', 'paste', 'selectAll'].every((r) => editMenu.some((x) => x.role && x.role.toLowerCase() === r.toLowerCase())),
    JSON.stringify(editMenu.filter((x) => x.role).map((x) => `${x.role}=${x.label}`)));
  const undoItem = editMenu.find((x) => x.id === 'edit.undo');
  const redoItem = editMenu.find((x) => x.id === 'edit.redo');
  check('撤销 / 重做 are custom items with a displayed-but-unregistered accelerator',
    !!undoItem && !!redoItem && undoItem.accel === 'CmdOrCtrl+Z' && redoItem.accel === 'Shift+CmdOrCtrl+Z'
      && undoItem.registers === false && redoItem.registers === false,
    JSON.stringify([undoItem, redoItem]));
  await menuClick(app, 'edit.undo');
  await sleep(600);
  const afterUndo = await page.evaluate(() => window.__mdr.app.getText());
  check('编辑 → 撤销 undoes inside CodeMirror', afterUndo !== afterType, `${JSON.stringify(afterType)} → ${JSON.stringify(afterUndo)}`);
  await menuClick(app, 'edit.redo');
  await sleep(600);
  const afterRedo = await page.evaluate(() => window.__mdr.app.getText());
  check('编辑 → 重做 redoes inside CodeMirror', afterRedo === afterType, `${JSON.stringify(afterUndo)} → ${JSON.stringify(afterRedo)}`);
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: 0, head: 3 } }); });
  await sleep(200);
  await wc('copy');
  await sleep(500);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  check('拷贝 puts the CodeMirror selection on the clipboard', clip === '原始文本'.slice(0, 3), JSON.stringify(clip.slice(0, 20)));
  await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); });
  const beforePaste = await page.evaluate(() => window.__mdr.app.getText());
  await wc('paste');
  await sleep(700);
  const afterPaste = await page.evaluate(() => window.__mdr.app.getText());
  check('粘贴 inserts into CodeMirror', afterPaste === beforePaste + clip, JSON.stringify(afterPaste.slice(-14)));

  // ================================================================= B. window contract
  console.log('\n[B] window title, represented file, dark mode');
  // A4 left the scratch buffer dirty: discard it so open-file does not stop at the guard.
  await menuClick(app, 'file.new');
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
    if (b) b.click();
  });
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  const winDoc = path.join(tmp, '窗口.md');
  await fsp.writeFile(winDoc, '# 窗口\n\n内容\n', 'utf8');
  await emitOpenFile(app, winDoc);
  await until(page, () => document.title.includes('窗口.md'));
  await sleep(400);
  const clean = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { title: w.getTitle(), rep: w.getRepresentedFilename(), edited: w.isDocumentEdited() };
  });
  check('window title === document name (clean)', clean.title === '窗口.md', JSON.stringify(clean));
  check('represented file (proxy icon) === the open path', clean.rep === winDoc, clean.rep);
  check('isDocumentEdited() is false on a clean document', clean.edited === false);
  await typeInEditor(page, '改');
  await sleep(400);
  const dirtyState = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { title: w.getTitle(), rep: w.getRepresentedFilename(), edited: w.isDocumentEdited() };
  });
  check('window title shows the ● dirty marker', dirtyState.title === '● 窗口.md', JSON.stringify(dirtyState));
  check('isDocumentEdited() is true when dirty (macOS close-button dot)', dirtyState.edited === true);
  check('represented file survives going dirty', dirtyState.rep === winDoc, dirtyState.rep);
  if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, 'dirty-title.png') }); note(`screenshot → ${path.join(SHOTS, 'dirty-title.png')}`); }

  console.log('\n[B2] dark mode follows the macOS appearance and the in-app toggle');
  // Playwright pins the context to prefers-color-scheme: light, so nativeTheme.themeSource cannot be
  // observed through it. Verify the two halves separately:
  //   (a) main really reads the system appearance for the pre-paint window background, and
  //   (b) the renderer's theme module reacts to a prefers-color-scheme change.
  const sysDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  const pwScheme = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  note(`macOS shouldUseDarkColors=${sysDark}; the Playwright context reports prefers-color-scheme dark=${pwScheme} `
    + '(Playwright pins it to light — the OS→Chromium hop is verified from the packaged bundle instead)');
  await page.evaluate(() => { window.__mdr.app.theme.set('system'); });
  await sleep(200);
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkOk = await until(page, () => document.documentElement.dataset.theme === 'dark', null, 5000);
  check('a prefers-color-scheme:dark change flips the renderer to dark (theme pref = system)', !!darkOk,
    await page.evaluate(() => document.documentElement.dataset.theme));
  if (SHOTS && darkOk) { await page.screenshot({ path: path.join(SHOTS, 'dark.png') }); note(`screenshot → ${path.join(SHOTS, 'dark.png')}`); }
  await page.emulateMedia({ colorScheme: 'light' });
  const lightOk = await until(page, () => document.documentElement.dataset.theme === 'light', null, 5000);
  check('a prefers-color-scheme:light change flips the renderer back to light', !!lightOk,
    await page.evaluate(() => document.documentElement.dataset.theme));
  if (SHOTS && lightOk) { await page.screenshot({ path: path.join(SHOTS, 'light.png') }); note(`screenshot → ${path.join(SHOTS, 'light.png')}`); }
  const beforeToggle = await page.evaluate(() => document.documentElement.dataset.theme);
  await menuClick(app, 'view.toggleTheme');
  const toggled = await until(page, (b) => document.documentElement.dataset.theme !== b, beforeToggle, 5000);
  check('视图→切换主题 flips the theme in-app', !!toggled,
    `${beforeToggle} → ${await page.evaluate(() => document.documentElement.dataset.theme)}`);
  const stickyPref = await page.evaluate(() => window.__mdr.app.theme.get());
  check('the in-app toggle pins an explicit preference (no longer follows the system)', stickyPref !== 'system', stickyPref);
  await menuClick(app, 'view.toggleTheme');
  await until(page, (b) => document.documentElement.dataset.theme === b, beforeToggle, 5000);
  await page.evaluate(() => { window.__mdr.app.theme.set('system'); });
  await page.emulateMedia({ colorScheme: null });

  console.log('\n[B3] window size/position is remembered');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 90, width: 1024, height: 768 }); });
  await sleep(1200); // the 400 ms persist debounce
  // leave clean so the window closes without a prompt
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  await hardClose({ app });
  handle = null;
  await sleep(700);
  const persisted = JSON.parse(await fsp.readFile(path.join(userData, 'window-state.json'), 'utf8'));
  check('window bounds are persisted to window-state.json',
    persisted.width === 1024 && persisted.height === 768 && persisted.x === 120 && persisted.y === 90,
    JSON.stringify(persisted));
  handle = await launch();
  ({ app, page } = handle);
  const restored = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  check('window size/position is restored after relaunch',
    restored.width === 1024 && restored.height === 768 && restored.x === 120 && restored.y === 90,
    JSON.stringify(restored));
  await hardClose({ app });
  handle = null;

  // ================================================================= C. close / quit guards
  const guardDoc = path.join(tmp, '守卫.md');
  const GUARD_TEXT = '# 守卫\n\n原始内容\n';

  /** Fresh app with a dirty native document. */
  async function dirtyApp() {
    await fsp.writeFile(guardDoc, GUARD_TEXT, 'utf8');
    const h = await launch();
    await menuClick(h.app, 'view.mode.split');
    await sleep(400);
    await emitOpenFile(h.app, guardDoc);
    await until(h.page, () => document.title.includes('守卫.md'));
    await typeInEditor(h.page, '脏');
    const gotDirty = await until(h.page, () => document.title.startsWith('● '), null, 8000);
    if (!gotDirty) throw new Error('the test document never went dirty');
    // the guard only runs if MAIN knows the document is dirty
    const mainDirty = await until2(h.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited(), 8000);
    if (!mainDirty) throw new Error('main never saw the document as dirty (setDocumentState did not arrive)');
    return h;
  }
  const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  const stillAlive = async (app) => { try { return (await windowCount(app)) > 0; } catch { return false; } };

  const closeRole = await (async () => {
    const h = await launch();
    const r = await h.app.evaluate(({ Menu }) => {
      const f = Menu.getApplicationMenu().items.find((m) => m.label === '文件');
      const c = f.submenu.items.find((i) => (i.role || '').toLowerCase() === 'close');
      return c ? { label: c.label, accel: c.accelerator || '(platform default ⌘W)' } : null;
    });
    await hardClose(h);
    await sleep(600);
    return r;
  })();
  check('文件 menu has 关闭窗口 (role:close, ⌘W)', !!closeRole && closeRole.label === '关闭窗口', JSON.stringify(closeRole));

  for (const [howLabel, trigger] of [
    ['window close ×', (a) => a.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); })],
    // 关闭窗口 is role:'close' → AppKit 'performClose:' on the first responder → NSWindow close →
    // Electron's 'close' event, which is exactly what win.close() raises. Playwright cannot send the
    // selector, so the NSWindow close is driven directly; the guard under test is the same listener.
    ['⌘W (文件→关闭窗口, role:close)', (a) => a.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); })],
    ['⌘Q (app.quit)', (a) => a.evaluate(({ app: x }) => { x.quit(); })],
  ]) {
    console.log(`\n[C] ${howLabel} while dirty`);
    // --- 取消
    handle = await dirtyApp();
    await trigger(handle.app);
    await sleep(1200);
    const btns = await dialogButtons(handle.page).catch((e) => [`<window already gone: ${e.message.split('\n')[0]}>`]);
    check(`${howLabel}: the three-button guard appears`,
      btns.includes('保存') && btns.includes('不保存') && btns.includes('取消'), JSON.stringify(btns));
    if (!btns.includes('保存')) {
      failures.push(`${howLabel}: NO GUARD — the document closed/quit while dirty`);
      await hardClose(handle);
      handle = null;
      await sleep(800);
      continue;
    }
    if (SHOTS && howLabel.startsWith('window close')) {
      await handle.page.screenshot({ path: path.join(SHOTS, 'close-dialog.png') });
      note(`screenshot → ${path.join(SHOTS, 'close-dialog.png')}`);
    }
    await clickDialogButton(handle.page, '取消');
    await sleep(900);
    check(`${howLabel} + 取消: the window stays open`, await stillAlive(handle.app));
    check(`${howLabel} + 取消: the text is untouched`,
      (await handle.page.evaluate(() => window.__mdr.app.getText())).startsWith('脏'));
    check(`${howLabel} + 取消: the file on disk is untouched`, (await fsp.readFile(guardDoc, 'utf8')) === GUARD_TEXT);
    // a second attempt after 取消 must ask again (not close silently)
    await trigger(handle.app);
    await sleep(900);
    check(`${howLabel} + 取消 then retry: asks again`, (await dialogButtons(handle.page)).includes('保存'));
    await clickDialogButton(handle.page, '取消');
    await sleep(500);
    await hardClose(handle);
    handle = null;
    await sleep(800);

    // --- 不保存
    handle = await dirtyApp();
    await trigger(handle.app);
    await sleep(900);
    await clickDialogButton(handle.page, '不保存');
    const gone = await (async () => {
      for (let i = 0; i < 60; i++) { if (!(await stillAlive(handle.app))) return true; await sleep(200); }
      return false;
    })();
    check(`${howLabel} + 不保存: the window closes`, gone);
    check(`${howLabel} + 不保存: the file was NOT written`, (await fsp.readFile(guardDoc, 'utf8')) === GUARD_TEXT);
    await hardClose(handle);
    handle = null;
    await sleep(800);

    // --- 保存
    handle = await dirtyApp();
    await trigger(handle.app);
    await sleep(900);
    await clickDialogButton(handle.page, '保存');
    const gone2 = await (async () => {
      for (let i = 0; i < 60; i++) { if (!(await stillAlive(handle.app))) return true; await sleep(200); }
      return false;
    })();
    check(`${howLabel} + 保存: the window closes`, gone2);
    const saved = await fsp.readFile(guardDoc, 'utf8');
    check(`${howLabel} + 保存: the file was written before closing`, saved !== GUARD_TEXT && saved.startsWith('脏'), JSON.stringify(saved.slice(0, 16)));
    await hardClose(handle);
    handle = null;
    await sleep(800);
  }

  console.log('\n[C4] ⌘Q on a CLEAN document quits immediately');
  handle = await launch();
  await fsp.writeFile(guardDoc, GUARD_TEXT, 'utf8');
  await emitOpenFile(handle.app, guardDoc);
  await until(handle.page, () => document.title.includes('守卫.md'));
  const q0 = Date.now();
  await handle.app.evaluate(({ app: x }) => { x.quit(); });
  let quit = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await windowCount(handle.app)) === 0) { quit = true; break; } } catch { quit = true; break; }
    await sleep(100);
  }
  const quitMs = Date.now() - q0;
  check('⌘Q with a clean document quits without asking', quit, `${quitMs} ms`);
  const leftoverDialog = await handle.page.evaluate(() => document.querySelectorAll('.mdr-dialog').length).catch(() => 0);
  check('⌘Q with a clean document shows no dialog', leftoverDialog === 0, String(leftoverDialog));
  await hardClose(handle);
  handle = null;
} catch (err) {
  failures.push(`EXCEPTION: ${err && err.stack ? err.stack : err}`);
  console.error(err);
} finally {
  if (handle) await hardClose(handle);
  if (vite) { try { process.kill(vite.pid, 'SIGKILL'); } catch { /* gone */ } killPort(PORT); }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n=== verify-guards: ${pass} passed, ${failures.length} failed, ${notes.length} notes ===`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
