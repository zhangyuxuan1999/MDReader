// hunt:profile — open the user's most recent documents (taken from the profile COPY's mdr.recent list) in
// an isolated instance that runs on that copy, through the same main-process 'open-file' handler Finder's
// double-click hits. Records numbers only: byte size, encoding, line count, file char length, editor
// document length, preview block count, mdr:first-visible, toasts, console errors. Never prints contents.
// Usage: MDR_PROFILE=<profile copy> [MDR_EXE=...] [MDR_MODES=split,edit,preview] [MDR_MAX=12]
//        node bench/electron/hunt-profile-recents.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';

const exe = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const prof = process.env.MDR_PROFILE;
const realProfile = path.join(os.homedir(), 'Library/Application Support/MDReader');
if (!prof || !fs.existsSync(prof)) { console.error('MDR_PROFILE (a copy) is required'); process.exit(2); }
if (path.resolve(prof) === path.resolve(realProfile)) { console.error('refusing to use the real profile'); process.exit(2); }
const modes = (process.env.MDR_MODES || 'persisted').split(',');
const max = Number(process.env.MDR_MAX || 12);

const out = { exe, profile: prof, errors: [], skipped: [], runs: [] };
const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${prof}`], timeout: 30000 });
const timer = setTimeout(() => { console.log(JSON.stringify({ TIMEOUT: true, ...out }, null, 1)); app.process()?.kill('SIGKILL'); process.exit(3); }, 105000);
const fileFacts = (p) => {
  const buf = fs.readFileSync(p);
  let chars = null;
  try { chars = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/\r\n?/g, '\n').length; } catch { chars = 'not-utf8'; }
  let enc = '?'; try { enc = execFileSync('file', ['-bI', p], { encoding: 'utf8' }).trim(); } catch {}
  let lines = 0; for (const b of buf) if (b === 10) lines++;
  return { bytes: buf.length, encoding: enc, newlines: lines, charsLF: chars };
};
try {
  out.pid = app.process().pid;
  const w = await app.firstWindow();
  w.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') out.errors.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  w.on('pageerror', (e) => out.errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  await w.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await w.waitForTimeout(1500);

  const recent = await w.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onerror = () => res([]);
    r.onsuccess = () => { try { const g = r.result.transaction('keyval').objectStore('keyval').get('mdr.recent'); g.onsuccess = () => res(Array.isArray(g.result) ? g.result.map((e) => ({ path: e.path, openedAt: e.openedAt })) : []); g.onerror = () => res([]); } catch { res([]); } };
  }));
  const docs = [];
  for (const e of recent.sort((a, b) => b.openedAt - a.openedAt)) {
    if (docs.length >= max) break;
    if (!e.path) { out.skipped.push({ path: null, why: 'no path' }); continue; }
    try { fs.accessSync(e.path, fs.constants.R_OK); docs.push(e.path); } catch (err) { out.skipped.push({ path: e.path, why: err.code }); }
  }

  const emitOpen = (p) => app.evaluate(({ app }, p) => { app.emit('open-file', { preventDefault() {} }, p); }, p);
  const measure = () => w.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    let docLen = null, how = null;
    const view = cm?.cmView?.rootView?.view ?? cm?.cmTile?.root?.view ?? cm?.cmView?.view ?? null;
    if (view?.state?.doc) { docLen = view.state.doc.length; how = 'cmView'; }
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}${getComputedStyle(el).display === 'none' ? ' (none)' : ''}`; };
    const opens = performance.getEntriesByName('mdr:open'); const t = opens.length ? opens[opens.length - 1].startTime : null;
    const fv = t === null ? null : performance.getEntriesByName('mdr:first-visible').find((e) => e.startTime >= t);
    return {
      title: document.title, docLen, docLenHow: how, cmTextLen: (cm?.textContent ?? '').length, cmLines: document.querySelectorAll('.cm-line').length,
      previewBlocks: document.querySelector('.mdr-preview__body')?.children.length ?? null,
      previewTextLen: (document.querySelector('.mdr-preview__body')?.textContent ?? '').length,
      firstVisibleMs: fv ? Math.round(fv.startTime - t) : null, openMarks: opens.length,
      panes: { toc: r('.mdr-pane--toc'), editor: r('.mdr-pane--editor'), preview: r('.mdr-pane--preview') },
      editorScrollH: document.querySelector('.cm-scroller')?.scrollHeight ?? null,
      toasts: [...document.querySelectorAll('.mdr-toast__text')].map((x) => x.textContent.slice(0, 80)),
      dialog: !!document.querySelector('.mdr-dialog'),
    };
  });

  for (const mode of modes) {
    if (mode !== 'persisted') {
      await w.evaluate((m) => localStorage.setItem('mdr.mode', m), mode);
      await w.reload(); await w.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 }); await w.waitForTimeout(1200);
    }
    const lsMode = await w.evaluate(() => localStorage.getItem('mdr.mode'));
    for (const p of docs) {
      const errBefore = out.errors.length;
      const facts = fileFacts(p);
      await emitOpen(p);
      const base = path.basename(p);
      const ok = await w.waitForFunction((b) => document.title.includes(b), base, { timeout: 6000 }).then(() => true).catch(() => false);
      await w.waitForTimeout(2000);
      const m = await measure();
      const empty = m.docLen === 0 || (m.docLen === null && m.cmTextLen === 0);
      const partial = typeof facts.charsLF === 'number' && m.docLen !== null && m.docLen !== facts.charsLF;
      out.runs.push({ mode, lsMode, path: p, ...facts, titleMatched: ok, ...m, newErrors: out.errors.slice(errBefore), EMPTY: empty, LENGTH_MISMATCH: partial });
    }
  }
} catch (e) {
  out.fatal = String(e).slice(0, 400);
} finally {
  clearTimeout(timer);
  console.log(JSON.stringify(out, null, 1));
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  try { app.process()?.kill('SIGKILL'); } catch {}
}
