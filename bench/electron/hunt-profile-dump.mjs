// hunt:profile — dump the persisted state of a COPY of a user profile (never the real one) through the
// installed app, and measure the layout at the persisted window size. Prints metadata only: keys, lengths,
// versions, timestamps, paths, sizes. Never prints document text.
// Usage: MDR_PROFILE=<copy of the profile dir> [MDR_EXE=...] node bench/electron/hunt-profile-dump.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const exe = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const prof = process.env.MDR_PROFILE;
const realProfile = path.join(os.homedir(), 'Library/Application Support/MDReader');
if (!prof || !fs.existsSync(prof)) { console.error('MDR_PROFILE (a copy) is required'); process.exit(2); }
if (path.resolve(prof) === path.resolve(realProfile)) { console.error('refusing to use the real profile'); process.exit(2); }

const out = { exe, profile: prof, errors: [] };
let wsFile = null;
try { wsFile = JSON.parse(fs.readFileSync(path.join(prof, 'window-state.json'), 'utf8')); } catch (e) { wsFile = String(e); }
out.windowStateFile = wsFile;

const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${prof}`], timeout: 30000 });
const timer = setTimeout(() => { console.log(JSON.stringify({ TIMEOUT: true, ...out }, null, 1)); app.process()?.kill('SIGKILL'); process.exit(3); }, 90000);
try {
  out.pid = app.process().pid;
  const w = await app.firstWindow();
  w.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') out.errors.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  w.on('pageerror', (e) => out.errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  await w.waitForTimeout(2500);

  out.main = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      windows: BrowserWindow.getAllWindows().length,
      bounds: win.getBounds(), contentBounds: win.getContentBounds(), visible: win.isVisible(), minimized: win.isMinimized(),
      zoomFactor: win.webContents.getZoomFactor(), zoomLevel: win.webContents.getZoomLevel(),
      displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor })),
      onScreen: screen.getAllDisplays().some((d) => { const b = win.getBounds(); const a = d.workArea; return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y; }),
    };
  });

  out.storage = await w.evaluate(async () => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('mdr.')) { const v = localStorage.getItem(k); ls[k] = v.length > 200 ? `<len ${v.length}>` : v; } }
    const otherLsKeys = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('mdr.')) otherLsKeys.push(k); }
    const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => `${d.name}@${d.version}`) : null;
    const idb = await new Promise((res) => {
      const r = indexedDB.open('keyval-store');
      r.onerror = () => res({ error: String(r.error) });
      r.onsuccess = () => {
        const db = r.result; const stores = [...db.objectStoreNames];
        if (!stores.includes('keyval')) { res({ stores }); return; }
        const rows = []; const tx = db.transaction('keyval', 'readonly');
        const cur = tx.objectStore('keyval').openCursor();
        cur.onsuccess = () => {
          const c = cur.result; if (!c) { res({ stores, rows }); return; }
          const k = String(c.key); const v = c.value;
          if (k.startsWith('mdr.draft:')) rows.push({ key: k.slice(0, 120), kind: 'draft', docId: v?.docId, textLen: typeof v?.text === 'string' ? v.text.length : typeof v?.text, textBlank: typeof v?.text === 'string' ? v.text.trim().length === 0 : null, version: v?.version, at: v?.at, atIso: v?.at ? new Date(v.at).toISOString() : null, fields: v && typeof v === 'object' ? Object.keys(v) : typeof v });
          else if (k === 'mdr.recent') rows.push({ key: k, kind: 'recent', list: Array.isArray(v) ? v.map((e) => ({ docId: e.docId, name: e.name, path: e.path ?? null, openedAt: e.openedAt, openedIso: e.openedAt ? new Date(e.openedAt).toISOString() : null, hasHandle: !!e.handle, fields: Object.keys(e) })) : typeof v });
          else rows.push({ key: k.slice(0, 120), kind: 'other', type: typeof v });
          c.continue();
        };
        cur.onerror = () => res({ stores, rows, error: String(cur.error) });
      };
    });
    return { localStorage: ls, otherLsKeys, databases: dbs, idb };
  });

  out.layout = await w.evaluate(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), display: cs.display, visibility: cs.visibility, cls: el.className }; };
    return {
      inner: [innerWidth, innerHeight], dpr: devicePixelRatio, title: document.title,
      htmlAttrs: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`),
      app: r('.mdr-app'), main: r('.mdr-main'), toc: r('.mdr-pane--toc'), editor: r('.mdr-pane--editor'), gutter: r('.mdr-gutter'), preview: r('.mdr-pane--preview'),
      cmLines: document.querySelectorAll('.cm-line').length, previewBlocks: document.querySelector('.mdr-preview__body')?.children.length ?? null,
      toasts: [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent.slice(0, 120)),
      status: (document.querySelector('.mdr-statusbar')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
    };
  });
} catch (e) {
  out.fatal = String(e).slice(0, 400);
} finally {
  clearTimeout(timer);
  console.log(JSON.stringify(out, null, 1));
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  try { app.process()?.kill('SIGKILL'); } catch {}
}
