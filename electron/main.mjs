// electron/main.mjs — MDReader desktop shell, main process (CONTRACT §10).
//
// Renderer origin: app://mdreader/ (privileged custom scheme over the packaged dist/), never file://.
// Bridge: electron/preload.cjs exposes window.mdrNative (src/shared/native.ts) — nothing else.
// Documents: macOS 'open-file' + argv paths are queued until the renderer says 'ready-for-files'.
// Close/quit while dirty goes through the renderer's zh-CN dialog via 'app.closeRequested'.
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, protocol, screen, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adoptSaveTarget, createFileMetaStore, readFileInfo, writeFileAtomic } from './fileIO.mjs';
import { buildMenuTemplate } from './menu.mjs';
import { createOpenFileQueue } from './openQueue.mjs';
import {
  isDevReload, isOnOrigin, isValidAbsolutePath, nativeErrorFor, pathsFromArgv, replacedBytesWarning, MARKDOWN_EXTENSIONS, MARKDOWN_EXT_RE,
} from './paths.mjs';
import { APP_INDEX_URL, APP_ORIGIN, APP_SCHEME, APP_SCHEME_PRIVILEGES, CSP_DEV, createAppProtocolHandler } from './protocol.mjs';
import { readWindowState, writeWindowState, MIN_HEIGHT, MIN_WIDTH } from './windowState.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.MDR_DEV_URL || '';
const IS_DEV = !!DEV_URL;
const LIGHT_BG = '#faf8f4'; // --mdr-bg (tokens.css, light)
const DARK_BG = '#15171a';  // --mdr-bg (tokens.css, dark)

app.setName('MDReader');

// MUST run before app.ready.
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

// ------------------------------------------------------------------ state
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{path: string|null, name: string, dirty: boolean}} */
let documentState = { path: null, name: '未命名.md', dirty: false };
let closeAsked = false;   // an 'app.closeRequested' is awaiting resolveClose()
let allowClose = false;   // the renderer answered 'save'/'discard'
let quitting = false;     // the pending close came from before-quit

let shellReady = false;  // app:// handler, IPC and menu are installed (end of whenReady setup)
/** @type {BrowserWindow | null} */
let closingWindow = null; // its 'close' went through: it is going away, 'closed' follows
let reopenAfterClose = false; // a document arrived while the window was closing
/** A document arrived while the dirty-close dialog was up (closeAsked) and was held back instead of
 *  being stacked on top of that dialog: 取消 flushes it into the same window, 保存 / 不保存 let the
 *  window close and the next window shows it. */
let heldForCloseAsk = false;
/** The document the window showed when its renderer crashed, queued again (front) so the reloaded
 *  page reopens it (and offers its draft); withdrawn if that window goes away before it is reopened. */
let crashRestorePath = null;

/** The one document window, or null when there is none (closed, closing, or torn down). */
function liveWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  if (mainWindow === closingWindow) return null;
  return mainWindow;
}

// deliver() must say whether the path really reached a renderer: when it did not (the window was
// closed and the app lives on in the Dock), the queue keeps the path for the next window instead of
// dropping it — that drop was the "double-click a .md, get an empty 未命名.md" bug (CONTRACT §10a).
const openQueue = createOpenFileQueue((p) => {
  const win = liveWindow();
  if (!win || win.webContents.isCrashed()) return false;
  if (closeAsked) {
    // The renderer is showing 保存 / 不保存 / 取消 for closing; a document sent now would stack its
    // own guard on top, and 不保存 then closed the window with the double-clicked file never shown.
    heldForCloseAsk = true;
    return false;
  }
  win.webContents.send('mdr:open-file', p);
  focusWindow();
  return true;
});

/** Menu commands that make sense with no window at all: they bring one up (CONTRACT §10a). */
const WINDOWLESS_COMMANDS = new Set(['file.new', 'file.open']);
/** Commands chosen while the renderer could not take them (window loading, reloading after a crash,
 *  or — for WINDOWLESS_COMMANDS — no window yet); sent right after the queued documents. */
let pendingCommands = [];

/** Renderer crashes within CRASH_WINDOW_MS; CRASH_LIMIT of them and the window is given up. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;
let crashTimes = [];

let menuWindowless = null; // what the installed application menu was built for (null = none yet)
let menuWanted = false;
let menuTimer = null;

/**
 * The application menu. Every command item has registerAccelerator:false because the renderer binds
 * the same keys (CONTRACT §10) — which means ⌘N / ⌘O did nothing at all with no window. With no
 * window the menu is rebuilt with those two accelerators registered; the next window gets the normal
 * menu back, so a key still fires exactly once. Deferred: the rebuild can be triggered from inside a
 * menu item's click handler.
 */
function installMenu(windowless) {
  menuWanted = windowless;
  if (menuTimer) return;
  menuTimer = setImmediate(() => {
    menuTimer = null;
    if (menuWindowless === menuWanted) return;
    menuWindowless = menuWanted;
    const template = buildMenuTemplate({ appName: 'MDReader', send: sendCommand, isDev: IS_DEV });
    if (menuWindowless) {
      const walk = (items) => {
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          if (WINDOWLESS_COMMANDS.has(item.id)) item.registerAccelerator = true;
          if (Array.isArray(item.submenu)) walk(item.submenu);
        }
      };
      walk(template);
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  });
}

function loadRenderer(win) {
  win.loadURL(DEV_URL || APP_INDEX_URL).catch(() => {});
}

/** `url` is on the dev server's origin (only with a dev URL configured). */
const isDevOrigin = (url) => isOnOrigin(DEV_URL, url);

/** Invalid bytes were shown as U+FFFD (fileIO lenient decode): say so, without blocking. The wording
 *  (paths.mjs replacedBytesWarning) promises what saving does only for a file read as UTF-8. */
function warnReplaced(info) {
  const text = replacedBytesWarning(info);
  if (!text) return;
  const opts = { type: 'warning', buttons: ['好'], ...text };
  const win = liveWindow();
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).catch(() => {});
}

/** open-file / second-instance / activate: make sure exactly one window exists (and is in front). */
function ensureWindow() {
  if (!shellReady) return; // the startup createWindow() will pick the queued paths up
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow === closingWindow) {
    reopenAfterClose = true; // exactly one window: the next one opens on 'closed'
    return;
  }
  if (!liveWindow()) createWindow();
  // A window still loading shows itself on ready-to-show and is focused when the queue flushes.
  // While the dirty-close question is up the queue holds documents back (not ready), but the window
  // must still come to the front (restored if minimised) so the user sees that question.
  else if (openQueue.isReady() || closeAsked) focusWindow();
}

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Queue one document path if it looks like something MDReader can open. */
function queueOpenPath(p) {
  if (!isValidAbsolutePath(p)) return;
  if (p === crashRestorePath) crashRestorePath = null; // the user asked for it: never withdraw it
  openQueue.push(p);
}

/** The window that would have reopened the crashed document is going away: forget the restore. */
function dropCrashRestore() {
  if (crashRestorePath) openQueue.remove(crashRestorePath);
  crashRestorePath = null;
}

/**
 * A menu item / its accelerator. Goes straight to the renderer when it has subscribed; while the
 * window is loading (or reloading after a crash) it waits for 'ready-for-files'. With no window,
 * 新建 brings up a window (which is a new untitled document) and 打开… brings one up and then runs
 * in it; every other command needs a document and is ignored, as before.
 */
function sendCommand(id) {
  if (typeof id !== 'string' || !id) return;
  const win = liveWindow();
  if (win && openQueue.isReady() && !win.webContents.isCrashed()) {
    win.webContents.send('mdr:command', id);
    return;
  }
  if (!win) {
    if (!WINDOWLESS_COMMANDS.has(id)) return;
    if (id !== 'file.new' && !pendingCommands.includes(id)) pendingCommands.push(id);
    ensureWindow();
    return;
  }
  if (!pendingCommands.includes(id)) pendingCommands.push(id);
}

function flushCommands(win) {
  const ids = pendingCommands;
  pendingCommands = [];
  for (const id of ids) win.webContents.send('mdr:command', id);
}

// ------------------------------------------------------------------ file helpers
// Encoding / BOM / line endings / symlink / hard-link / mtime handling all live in fileIO.mjs; this
// map is the shell's memory of the files it has touched (keyed by resolved path).
const fileMeta = createFileMetaStore();
const readDocument = (p) => readFileInfo(p, fileMeta);
const writeDocument = (p, text) => writeFileAtomic(p, text, fileMeta);

const ok = (value) => ({ ok: true, value });
const fail = (err) => ({ ok: false, error: nativeErrorFor(err) });
const invalid = (message) => ({ ok: false, error: { code: 'UNKNOWN', message } });

function markdownFilters() {
  return [
    { name: 'Markdown', extensions: MARKDOWN_EXTENSIONS },
    { name: '所有文件', extensions: ['*'] },
  ];
}

// ------------------------------------------------------------------ IPC
function installIpc() {
  ipcMain.on('mdr:meta', (event) => {
    event.returnValue = { version: app.getVersion(), platform: process.platform };
  });

  ipcMain.on('mdr:readyForFiles', (e) => {
    // Only the renderer of the live window counts: a window that is closing must not flip the queue
    // to live, or the next paths would be delivered to it and lost.
    const win = liveWindow();
    if (!win || e.sender !== win.webContents) return;
    openQueue.markReady();
    if (crashRestorePath && !openQueue.pending().includes(crashRestorePath)) crashRestorePath = null;
    if (openQueue.isReady()) flushCommands(win);
  });

  ipcMain.on('mdr:setDocumentState', (_e, s) => {
    if (!s || typeof s !== 'object') return;
    const next = {
      path: typeof s.path === 'string' && s.path ? s.path : null,
      name: typeof s.name === 'string' && s.name ? s.name : '未命名.md',
      dirty: s.dirty === true,
    };
    documentState = next;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (process.platform === 'darwin') {
      mainWindow.setRepresentedFilename(next.path && isValidAbsolutePath(next.path) ? next.path : '');
      mainWindow.setDocumentEdited(next.dirty);
    }
  });

  ipcMain.on('mdr:addRecent', (_e, p) => {
    if (isValidAbsolutePath(p)) app.addRecentDocument(p);
  });

  ipcMain.on('mdr:resolveClose', (_e, decision) => {
    if (decision !== 'save' && decision !== 'discard' && decision !== 'cancel') return;
    if (!closeAsked) return;
    closeAsked = false;
    if (decision === 'cancel') {
      quitting = false;
      if (heldForCloseAsk) {
        // The window stays: what was held back during the dialog goes to the same renderer now.
        heldForCloseAsk = false;
        const win = liveWindow();
        if (win) {
          openQueue.markReady();
          if (openQueue.isReady()) flushCommands(win);
        }
      }
      return;
    }
    allowClose = true;
    if (quitting) app.quit();
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.handle('mdr:openDialog', async () => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const r = await dialog.showOpenDialog(parent, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: markdownFilters(),
    });
    const picked = r.canceled ? null : r.filePaths[0];
    if (!picked) return ok(null);
    try {
      const info = await readDocument(picked);
      warnReplaced(info);
      return ok(info);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('mdr:saveDialog', async (_e, suggestedName, currentPath) => {
    if (suggestedName != null && typeof suggestedName !== 'string') return invalid('suggestedName 必须是字符串');
    if (currentPath != null && typeof currentPath !== 'string') return invalid('currentPath 必须是字符串');
    const base = path.basename(String(suggestedName || '未命名.md')).replace(/[\u0000/\\]/g, '') || '未命名.md';
    const named = MARKDOWN_EXT_RE.test(base) ? base : `${base}.md`;
    const defaultPath =
      currentPath && isValidAbsolutePath(currentPath) ? currentPath : path.join(app.getPath('documents'), named);
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const r = await dialog.showSaveDialog(parent, {
      title: '保存 Markdown 文件',
      defaultPath,
      filters: markdownFilters(),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return ok(null);
    // The user picked this file in the save panel: forget whatever the shell remembered about the
    // file being replaced, but keep the current document's line endings.
    await adoptSaveTarget(r.filePath, documentState.path, fileMeta);
    return ok(r.filePath);
  });

  ipcMain.handle('mdr:readFile', async (_e, p) => {
    if (!isValidAbsolutePath(p)) return invalid('路径必须是绝对路径');
    try {
      const info = await readDocument(p);
      warnReplaced(info);
      return ok(info);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('mdr:writeFile', async (_e, p, text) => {
    if (!isValidAbsolutePath(p)) return invalid('路径必须是绝对路径');
    if (typeof text !== 'string') return invalid('内容必须是字符串');
    try {
      return ok(await writeDocument(p, text));
    } catch (err) {
      return fail(err);
    }
  });
}

// ------------------------------------------------------------------ content security policy
/**
 * A document that arrived by double-click must not be able to phone home. Every response the
 * renderer gets carries a CSP that keeps it inside app:// (and, in dev, inside the Vite server):
 * a `![](https://tracker/pixel.png)` in someone else's Markdown is a read receipt, and on the
 * desktop the user never chose to visit anything. protocol.handle() sets the header for app://
 * itself (electron/protocol.mjs); this covers the dev server, which webRequest does see.
 */
function installCsp() {
  if (!DEV_URL) return; // packaged: every response comes from createAppProtocolHandler
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-security-policy') delete headers[k];
    }
    headers['Content-Security-Policy'] = [CSP_DEV];
    callback({ responseHeaders: headers });
  });
}

// ------------------------------------------------------------------ window
function createWindow() {
  const userData = app.getPath('userData');
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const state = readWindowState(userData, areas);

  openQueue.reset(); // a fresh renderer has not subscribed yet; pending paths survive
  installMenu(false); // a window again: the renderer binds ⌘N / ⌘O itself

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
    // titleBarStyle stays at the platform default (CONTRACT §10) — no custom traffic-light inset.
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false,
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();

  // The window title mirrors document.title — App.ts owns "<name> — MDReader" and the dirty marker.
  win.once('ready-to-show', () => win.show());

  const persist = () => {
    if (win.isDestroyed()) return;
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    writeWindowState(app.getPath('userData'), { ...b, maximized: win.isMaximized() });
  };
  let persistTimer = null;
  const persistSoon = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  };
  win.on('resize', persistSoon);
  win.on('move', persistSoon);

  // External links leave the app; everything else is denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // S3: the window never navigates because of page content. will-navigate fires only for navigations
  // the PAGE starts (a link, location.href, location.reload(), a form); the shell's own loadURL /
  // reload never come here. Every one is cancelled — an app:// link used to replace the app page with
  // a 404 page (window could not close, app could not quit) or reload index.html (unsaved text gone).
  // http / https still open in the system browser. Only with a dev URL may a reload of the dev page
  // itself pass (Vite's full reload is location.reload()).
  win.webContents.on('will-navigate', (e, url) => {
    if (isDevReload(DEV_URL, win.webContents.getURL(), url)) return;
    e.preventDefault();
    // did-start-navigation (fired just before) took this navigation for a page change and buffered the
    // open queue: it never happens, so put the queue back exactly as it was.
    if (navStart && navStart.url === url) {
      const began = navStart.began;
      navStart = null;
      if (began) {
        navUncommitted = false;
        if (readyBeforeNav && mainWindow === win && win !== closingWindow && !win.webContents.isCrashed()) {
          openQueue.markReady();
          if (openQueue.isReady()) flushCommands(win);
        }
      }
    }
    if (/^https?:\/\//i.test(url) && !isDevOrigin(url)) shell.openExternal(url).catch(() => {});
  });

  // Dirty guard: the renderer owns the 保存 / 不保存 / 取消 dialog.
  win.on('close', (e) => {
    if (persistTimer) clearTimeout(persistTimer);
    persist();
    if (allowClose || !documentState.dirty) {
      // The window really goes away now: stop delivering to it, buffer for the next window.
      closingWindow = win;
      openQueue.reset();
      dropCrashRestore();
      return;
    }
    e.preventDefault();
    if (closeAsked) return;
    closeAsked = true;
    focusWindow();
    win.webContents.send('mdr:command', 'app.closeRequested');
  });

  // A reload (or any main-frame navigation) replaces the renderer that subscribed to documents: buffer
  // until the new page's preload says ready-for-files, so nothing is sent into the gap.
  // A navigation that starts but never commits (aborted: location.href = … then window.stop()) leaves
  // the OLD page — already subscribed — in place, and no new ready-for-files ever comes: when loading
  // stops without a commit, the queue is re-armed if it was live when the navigation started.
  let navUncommitted = false; // an app-origin main-frame navigation started and has not committed
  let readyBeforeNav = false; // the queue was live (old page subscribed) when it started
  /** The last main-frame navigation that started, and whether it began the uncommitted state: lets
   *  will-navigate (which fires right after) undo the buffering when it cancels that navigation. */
  let navStart = null;
  win.webContents.on('did-start-navigation', (details, ...legacy) => {
    const isMainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : legacy[2];
    const isSameDocument = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : legacy[1];
    if (isMainFrame === false || isSameDocument === true) return;
    // Only a navigation to the app page itself: an external link fires did-start-navigation too,
    // before will-navigate cancels it, and no new page would ever say ready-for-files after that.
    // A page-initiated one to the app page is cancelled the same way (S3): will-navigate, right
    // after this, undoes the buffering through navStart.
    const url = String((details && details.url) || legacy[0] || '');
    const allowed = url.startsWith(APP_ORIGIN) || (DEV_URL && url.startsWith(DEV_URL));
    navStart = { url, began: false };
    if (allowed && mainWindow === win) {
      if (!navUncommitted) {
        readyBeforeNav = openQueue.isReady();
        navStart.began = true;
      }
      navUncommitted = true;
      openQueue.reset();
    }
  });
  const oldPageGone = () => {
    if (!navUncommitted) return;
    navUncommitted = false;
    if (mainWindow !== win) return;
    // A dirty-close dialog that was up is gone with the old page: it can never answer.
    if (closeAsked) {
      closeAsked = false;
      quitting = false;
    }
    heldForCloseAsk = false; // the new page's ready-for-files flushes what was held
  };
  win.webContents.on('did-navigate', oldPageGone);
  win.webContents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
    // A main-frame failure other than an abort (-3) may have put an error page in place of the app
    // page: treat the old page as gone (as before this fix) and never re-arm into the error page.
    if (isMainFrame && errorCode !== -3) oldPageGone();
  });
  win.webContents.on('did-stop-loading', () => {
    if (!navUncommitted) return;
    navUncommitted = false;
    if (!readyBeforeNav || mainWindow !== win || win === closingWindow || win.webContents.isCrashed()) return;
    openQueue.markReady();
    if (openQueue.isReady()) flushCommands(win);
  });

  // The renderer died (crash, OOM, killed). It can never answer resolveClose, and every document sent
  // to it was lost while the window stayed up with a stale title and no content. Now: buffer opens,
  // forget its document state (its unsaved text lives on as an IndexedDB draft) so the window can
  // close, and load the page again — the new preload's ready-for-files flushes what arrived meanwhile.
  // A renderer that keeps crashing is given up: the window goes away and the next open starts fresh.
  win.webContents.on('render-process-gone', () => {
    navUncommitted = false; // whatever was navigating died with the renderer: never re-arm into it
    const asked = closeAsked;
    closeAsked = false;
    // ⌘Q was held, waiting for 保存 / 不保存 / 取消 from this renderer, and that answer can never come:
    // the quit is cancelled (as if 取消 had been chosen) and the window recovers like any other crash.
    // Without this the window stayed on the dead page and later documents were never shown.
    if (asked && quitting) quitting = false;
    if (win.isDestroyed() || mainWindow !== win || win === closingWindow || quitting) {
      allowClose = true; // do not trap the user in a window that will not close
      return;
    }
    openQueue.reset();
    heldForCloseAsk = false; // the reloaded page's ready-for-files flushes what was held
    const shown = documentState.path && isValidAbsolutePath(documentState.path) ? documentState.path : null;
    documentState = { path: null, name: '未命名.md', dirty: false };
    if (process.platform === 'darwin') win.setDocumentEdited(false);
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    crashTimes.push(now);
    if (crashTimes.length >= CRASH_LIMIT) {
      crashTimes = [];
      dropCrashRestore(); // the document may be what crashes it: the next window starts clean
      dialog.showMessageBox({
        type: 'error',
        buttons: ['好'],
        message: 'MDReader 的页面反复崩溃，窗口已关闭',
        detail: '未保存的内容会作为草稿在下次打开时提供恢复。再次打开文档会新建一个窗口。',
      }).catch(() => {});
      win.destroy();
      return;
    }
    // The reloaded page reopens what was on screen (its draft logic offers the unsaved text) BEFORE
    // anything that arrived later, so the newest request still ends up shown.
    if (shown) {
      openQueue.pushFront(shown);
      crashRestorePath = shown;
    }
    setImmediate(() => {
      if (!win.isDestroyed() && mainWindow === win) loadRenderer(win);
    });
  });

  win.on('closed', () => {
    const reopen = (reopenAfterClose || heldForCloseAsk) && !quitting;
    reopenAfterClose = false;
    heldForCloseAsk = false;
    if (mainWindow === win) dropCrashRestore();
    if (closingWindow === win) closingWindow = null;
    if (mainWindow === win) {
      mainWindow = null;
      // The subscribed renderer is gone: buffer again until the next window says ready-for-files.
      openQueue.reset();
    }
    allowClose = false;
    closeAsked = false;
    quitting = false;
    documentState = { path: null, name: '未命名.md', dirty: false };
    // They were meant for this window — except 新建 / 打开… chosen while it was closing (between
    // 'close' and 'closed'): those asked for the window that reopens now and must run in it.
    pendingCommands = reopen ? pendingCommands.filter((id) => WINDOWLESS_COMMANDS.has(id)) : [];
    if (reopen && shellReady && !liveWindow()) createWindow();
    else if (!liveWindow()) installMenu(true); // no window: ⌘N / ⌘O must still do something
  });

  loadRenderer(win);
  return win;
}

// ------------------------------------------------------------------ lifecycle
// macOS delivers these before ready; the queue holds them until the renderer subscribes.
// Order matters: queue FIRST, then create the window if there is none — createWindow() only resets
// the queue to buffering, the path stays pending until the new renderer subscribes.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueOpenPath(filePath);
  ensureWindow();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // An argv entry without a Markdown extension is opened when it is an existing regular file (README):
  // never the executable, the app path (`electron <app>`) or this script itself.
  const argvOpts = { exclude: [process.execPath, app.getAppPath(), fileURLToPath(import.meta.url)] };
  app.on('second-instance', (_e, argv, workingDirectory) => {
    for (const p of pathsFromArgv(argv, workingDirectory, argvOpts)) queueOpenPath(p);
    ensureWindow(); // the window may have been closed while the app stayed in the Dock
  });

  // Launch argv. On macOS a document opened from Finder / `open` arrives as the 'open-file' Apple
  // event and never in argv, so this only adds the terminal case (`MDReader.app/Contents/MacOS/
  // MDReader note.md`); the queue drops a path that 'open-file' already queued for the same launch.
  for (const p of pathsFromArgv(process.argv, process.cwd(), argvOpts)) queueOpenPath(p);

  app.on('before-quit', (e) => {
    quitting = true;
    if (allowClose || !documentState.dirty) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    e.preventDefault();
    if (closeAsked) {
      // ⌘Q again while the question is up (window minimised, app hidden): bring the question forward.
      if (process.platform === 'darwin') app.show();
      focusWindow();
      return;
    }
    closeAsked = true;
    focusWindow();
    mainWindow.webContents.send('mdr:command', 'app.closeRequested');
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Dock click: re-open the (empty) window if there is none — same one-window rule as documents.
  app.on('activate', () => ensureWindow());

  app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, createAppProtocolHandler(path.join(app.getAppPath(), 'dist')));
    installCsp();
    installIpc();
    installMenu(false);
    shellReady = true;
    if (!liveWindow()) createWindow(); // paths queued before ready are flushed into this window
  });
}
