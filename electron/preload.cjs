// electron/preload.cjs — the ONLY bridge between the Electron shell and the renderer.
// Sandboxed (sandbox:true, contextIsolation:true) so this file is CommonJS and may only use the
// preload subset of 'electron'. It implements MdrNative from src/shared/native.ts verbatim; the
// renderer reaches it through getNative() === window.mdrNative and behaves like the web build when
// it is absent.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ---------------------------------------------------------------- listeners
/** @type {Set<(path: string) => void>} */
const openFileSubscribers = new Set();
/** @type {Set<(id: string) => void>} */
const commandSubscribers = new Set();
let readyForFilesSent = false;

function fanout(subscribers, arg) {
  for (const cb of Array.from(subscribers)) {
    try {
      cb(arg);
    } catch (err) {
      // One bad subscriber must not swallow the document for the others.
      console.error('[mdrNative] subscriber threw', err);
    }
  }
}

ipcRenderer.on('mdr:open-file', (_event, filePath) => {
  if (typeof filePath === 'string' && filePath) fanout(openFileSubscribers, filePath);
});

ipcRenderer.on('mdr:command', (_event, id) => {
  if (typeof id === 'string' && id) fanout(commandSubscribers, id);
});

// ---------------------------------------------------------------- helpers
/** Main answers every invoke with {ok:true,value} | {ok:false,error:{code,message}}; unwrap it here
 *  so the renderer gets a plain value or a rejection shaped like NativeFileError. */
async function unwrap(channel, ...args) {
  let res;
  try {
    res = await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw { code: 'UNKNOWN', message: err && err.message ? String(err.message) : '与主进程通信失败' };
  }
  if (res && res.ok === true) return res.value;
  const error = (res && res.error) || {};
  throw { code: typeof error.code === 'string' ? error.code : 'UNKNOWN', message: String(error.message || '未知错误') };
}

let meta = { version: '0.0.0', platform: process.platform };
try {
  const got = ipcRenderer.sendSync('mdr:meta');
  if (got && typeof got === 'object') meta = { version: String(got.version || '0.0.0'), platform: got.platform || process.platform };
} catch {
  /* keep the defaults */
}

// ---------------------------------------------------------------- MdrNative
const mdrNative = {
  platform: meta.platform,
  version: meta.version,

  openDialog() {
    return unwrap('mdr:openDialog');
  },

  saveDialog(suggestedName, currentPath) {
    return unwrap('mdr:saveDialog', String(suggestedName == null ? '' : suggestedName), currentPath == null ? null : String(currentPath));
  },

  readFile(filePath) {
    return unwrap('mdr:readFile', String(filePath));
  },

  writeFile(filePath, text) {
    return unwrap('mdr:writeFile', String(filePath), String(text));
  },

  pathForFile(file) {
    try {
      const p = webUtils.getPathForFile(file);
      return typeof p === 'string' && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  },

  /** Subscribing is what tells the shell the renderer can receive documents: the queued launch
   *  document (macOS double-click / `open -a`) is flushed on the first subscription. */
  onOpenFile(cb) {
    if (typeof cb !== 'function') return () => {};
    openFileSubscribers.add(cb);
    if (!readyForFilesSent) {
      readyForFilesSent = true;
      ipcRenderer.send('mdr:readyForFiles');
    }
    return () => {
      openFileSubscribers.delete(cb);
    };
  },

  onCommand(cb) {
    if (typeof cb !== 'function') return () => {};
    commandSubscribers.add(cb);
    return () => {
      commandSubscribers.delete(cb);
    };
  },

  resolveClose(decision) {
    if (decision !== 'save' && decision !== 'discard' && decision !== 'cancel') return;
    ipcRenderer.send('mdr:resolveClose', decision);
  },

  setDocumentState(s) {
    if (!s || typeof s !== 'object') return;
    ipcRenderer.send('mdr:setDocumentState', {
      path: typeof s.path === 'string' && s.path ? s.path : null,
      name: typeof s.name === 'string' ? s.name : '',
      dirty: s.dirty === true,
    });
  },

  addRecent(filePath) {
    if (typeof filePath !== 'string' || !filePath) return;
    ipcRenderer.send('mdr:addRecent', filePath);
  },
};

contextBridge.exposeInMainWorld('mdrNative', mdrNative);
