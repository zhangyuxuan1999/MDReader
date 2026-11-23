// bench/electron/v4-dec-e2e.mjs — verify-decoder (0.2.0 stage 2d), step 3: decoder results end to end in
// the running shell, candidate against baseline with the SAME script:
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex SCRATCH=<dir> node bench/electron/v4-dec-e2e.mjs > cand.json
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/baseline-0.1.1.noindex SCRATCH=<dir> node bench/electron/v4-dec-e2e.mjs > base.json
//   node bench/electron/v4-dec-e2e.mjs --compare cand.json base.json   (prints every difference)
// Files: the H7 timesheet (GBK, real iconv encoder) and 21 files of bench/verify/v4-dec-corpus.mjs
// (seed 7). Paths: argv (H7 file), open-file (all), the 打开… panel with a stubbed dialog, a synthetic
// drop, a recent entry (toolbar list), 重新载入 from the conflict toast, and a draft restore (type,
// autosave, SIGKILL, relaunch with the same profile, 恢复). Per case: native message boxes, toasts, an
// editor text digest, U+FFFD count, then one 'x' typed after the first line and menu 保存: the toasts
// and the bytes on disk (digest + changed bytes against the original). PHASE=paths|draft (default
// both). Isolated profiles (wrapper; the draft phase brings its own). No full screen. Global timeout
// 5 min (run it in the background). Temp files under SCRATCH, removed in finally.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.argv[2] === '--compare') {
  const a = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const b = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const key = (r) => `${r.name} ${r.how}`;
  const bm = new Map(b.rows.map((r) => [key(r), r]));
  let n = 0;
  for (const r of a.rows) {
    const o = bm.get(key(r));
    const ja = JSON.stringify(r);
    const jb = JSON.stringify(o);
    if (ja !== jb) { n++; console.log('DIFF', key(r), '\n  cand', ja, '\n  base', jb); }
  }
  console.log(JSON.stringify({ rows: a.rows.length, baseRows: b.rows.length, differences: n, errors: [a.errors, b.errors] }));
  process.exit(0);
}

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const PHASE = process.env.PHASE || 'paths,draft';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.SCRATCH || os.tmpdir();
const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'v4dec-e2e-')));
const draftProf = fs.mkdtempSync(path.join(base, 'v4dec-prof-'));
const { buildCorpus } = await import('../verify/v4-dec-corpus.mjs');
const iconv = (s, to) => spawnSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(s, 'utf8') }).stdout;
const sheet = '# 工时\n\n| 日期 | 时长 |\n|---|---|\n' + Array.from({ length: 20 }, (_, i) => `| 11-${String(i + 1).padStart(2, '0')} | ${8 + (i % 3)}小时 |`).join('\n') + '\n';
const corpus = new Map(buildCorpus(7, {}).map((x) => [x.name, x.buf]));
const PICK = ['gbk-notes-7-0', 'gbk-h7-7-1', 'gbk-log-ansi-7', 'gbk-csv-7', 'utf8bom-csv-7', 'gb18030-astral-7', 'big5-7-3', 'big5-dup-7', 'sjis-7-0', 'sjis-hwcsv-7', 'cp932-nec-7', 'cp949-uhc-7', 'euckr-7-2', 'cp1252-7', 'utf8-bad2-7-1', 'utf16le-7', 'utf16be-bom-7', 'gbk-ctl-7', 'gbk-nulpad-7', 'utf8bom-gbkbody-7', 'utf16le-bom-odd-7'];
const CASES = [['h7-sheet', iconv(sheet, 'GBK')], ...PICK.map((n) => [n, corpus.get(n)])];
for (const [n, b] of CASES) if (!b) throw new Error('missing case ' + n);
const out = { appDir: APP_DIR, rows: [], errors: [] };
let app = null;
const timer = setTimeout(async () => { out.errors.push('GLOBAL TIMEOUT'); console.log(JSON.stringify(out, null, 1)); await closeApp(); cleanup(); process.exit(2); }, 300_000);
function cleanup() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(draftProf, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
async function closeApp(hard = false) {
  if (!app) return;
  const pid = app.process()?.pid;
  if (!hard) {
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  }
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  app = null;
}
async function launch(extraArgs = [], profile = null) {
  const args = [APP_DIR, ...(profile ? [`--user-data-dir=${profile}`] : []), ...extraArgs];
  app = await electron.launch({ args, timeout: 30000 });
  const w = await app.firstWindow();
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__boxes = globalThis.__boxes || [];
    const rec = (kind) => async (...x) => {
      const o = x.find((y) => y && typeof y === 'object' && 'message' in y) || {};
      globalThis.__boxes.push({ kind, message: o.message, detail: o.detail });
      return { response: 0, checkboxChecked: false };
    };
    dialog.showMessageBox = rec('box');
    dialog.showMessageBoxSync = (...x) => { const o = x.find((y) => y && typeof y === 'object' && 'message' in y) || {}; globalThis.__boxes.push({ kind: 'sync', message: o.message }); return 0; };
    dialog.showErrorBox = (t, c) => { globalThis.__boxes.push({ kind: 'error', message: t, detail: c }); };
  });
  return w;
}
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12);
const editorText = (w) => w.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
const toasts = (w) => w.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.replace('×', '').trim().replace(/v4dec-e2e-[A-Za-z0-9]+/g, 'DIR')));
const clearToasts = (w) => w.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
const boxes = async () => app.evaluate(() => { const b = (globalThis.__boxes || []).slice(); globalThis.__boxes = []; return b; });
async function waitTitle(w, name) {
  return w.waitForFunction((n) => document.title.includes(n), name, { timeout: 8000 }).then(() => true, () => false);
}
function diffCount(a, b) { let n = Math.abs(a.length - b.length); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n; }
/** Type 'x' right after the first line break (or at 0) and save from the menu. */
async function editSave(w, file, bytes, r, insert = 'x') {
  await clearToasts(w);
  await w.evaluate((ins) => {
    const v = document.querySelector('.cm-content').cmTile.view;
    const t = v.state.doc.toString();
    const at = t.indexOf('\n') + 1;
    v.dispatch({ changes: { from: at, insert: ins }, userEvent: 'input.type' });
  }, insert);
  await sleep(250);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
  await sleep(1300);
  r.saveToasts = await toasts(w);
  r.saveBoxes = await boxes();
  const after = fs.readFileSync(file);
  r.saved = after.equals(bytes) ? 'unchanged' : `${sha(after)} len ${bytes.length}->${after.length} diff ${diffCount(after, bytes)}`;
}
async function resetDoc(w) {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new').click());
  await sleep(400);
  await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog button, .mdr-dialog__btn')].find((x) => /丢弃|不保存|放弃/.test(x.textContent)); if (b) b.click(); });
  await sleep(400);
}
async function openVia(w, how, file) {
  if (how === 'open-file') await app.evaluate(({ app: a }, p) => a.emit('open-file', { preventDefault() {} }, p), file);
  else if (how === 'panel') {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, file);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.open').click());
  } else if (how === 'drop') {
    await w.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__v4drop'; i.style.display = 'none'; document.body.append(i); });
    await w.setInputFiles('#__v4drop', file);
    await w.evaluate(() => {
      const i = document.getElementById('__v4drop');
      const dt = new DataTransfer();
      dt.items.add(i.files[0]);
      const root = document.getElementById('app');
      root.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      root.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      i.remove();
    });
  } else if (how === 'recent') {
    const name = path.basename(file);
    await w.evaluate(() => document.querySelector('.mdr-toolbar__file').click());
    await sleep(400);
    const ok = await w.evaluate((n) => { const li = [...document.querySelectorAll('.mdr-recent__item')].find((x) => x.textContent === n); if (li) { li.click(); return true; } return false; }, name);
    if (!ok) throw new Error('recent entry not found: ' + name);
  }
}
async function oneCase(w, name, bytes, how, { already = false, file = null, prepare = null } = {}) {
  const f = file || path.join(dir, `${name}.${how}.md`);
  if (!already) fs.writeFileSync(f, bytes);
  if (prepare) await prepare(f);
  await boxes();
  await clearToasts(w);
  if (!already) await openVia(w, how, f);
  const r = { name, how, shown: await waitTitle(w, path.basename(f)) };
  await sleep(700);
  r.boxes = await boxes();
  r.toasts = await toasts(w);
  const t = await editorText(w);
  r.editor = r.shown ? `${sha(Buffer.from(t, 'utf8'))} len ${t.length} fffd ${t.split(String.fromCharCode(0xfffd)).length - 1}` : null;
  if (r.shown) await editSave(w, f, bytes, r);
  await resetDoc(w);
  out.rows.push(r);
  return f;
}
try {
  if (PHASE.includes('paths')) {
    const argvFile = path.join(dir, 'h7-sheet.argv.md');
    fs.writeFileSync(argvFile, CASES[0][1]);
    const w = await launch([argvFile]);
    await sleep(1000);
    await oneCase(w, 'h7-sheet', CASES[0][1], 'argv', { already: true, file: argvFile });
    for (const [name, bytes] of CASES) await oneCase(w, name, bytes, 'open-file');
    const sub = CASES.filter(([n]) => /h7|big5-dup|sjis-hw|cp932|gbk-notes|utf16le-7|gbk-nulpad/.test(n));
    for (const how of ['panel', 'drop']) for (const [name, bytes] of sub) await oneCase(w, name, bytes, how);
    // recent: the open-file copies are in the recent list now; reopen from the list (fresh bytes first)
    for (const [name, bytes] of sub.slice(0, 5)) {
      const f = path.join(dir, `${name}.recent.md`);
      fs.writeFileSync(f, bytes);
      await openVia(w, 'open-file', f);
      await waitTitle(w, path.basename(f));
      await sleep(500);
      await resetDoc(w);
      await oneCase(w, name, bytes, 'recent', { file: f, prepare: async (p) => fs.writeFileSync(p, bytes), already: false });
    }
    // 重新载入 from the conflict toast
    for (const [name, bytes] of sub.slice(0, 3)) {
      const f = path.join(dir, `${name}.reload.md`);
      fs.writeFileSync(f, bytes);
      await openVia(w, 'open-file', f);
      const r = { name, how: 'reload', shown: await waitTitle(w, path.basename(f)) };
      await sleep(700);
      r.boxesOpen = await boxes();
      const later = Date.now() / 1000 + 10;
      fs.utimesSync(f, later, later);
      await clearToasts(w);
      await w.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ changes: { from: v.state.doc.length, insert: 'y' }, userEvent: 'input.type' }); });
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
      await sleep(1200);
      r.conflictToasts = await toasts(w);
      r.clicked = await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.includes('重新载入')); if (b) { b.click(); return true; } return false; });
      await sleep(1200);
      r.boxesReload = await boxes();
      r.toasts = await toasts(w);
      const t = await editorText(w);
      r.editor = `${sha(Buffer.from(t, 'utf8'))} len ${t.length}`;
      await editSave(w, f, bytes, r);
      out.rows.push(r);
      await resetDoc(w);
    }
    await closeApp();
  }
  if (PHASE.includes('draft')) {
    const dcases = CASES.filter(([n]) => /h7|cp932|big5-dup/.test(n));
    for (const [name, bytes] of dcases) {
      const file = path.join(dir, `${name}.draft.md`);
      fs.writeFileSync(file, bytes);
      const d = { name, how: 'draft' };
      let w = await launch([], draftProf);
      await openVia(w, 'open-file', file);
      d.shown1 = await waitTitle(w, path.basename(file));
      await sleep(700);
      d.boxes1 = await boxes();
      await w.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; const t = v.state.doc.toString(); v.dispatch({ changes: { from: t.indexOf('\n') + 1, insert: 'D' }, userEvent: 'input.type' }); });
      await sleep(2800);
      await closeApp(true);
      await sleep(800);
      w = await launch([], draftProf);
      await openVia(w, 'open-file', file);
      d.shown2 = await waitTitle(w, path.basename(file));
      await sleep(1500);
      d.boxes2 = await boxes();
      d.offer = await toasts(w);
      d.clicked = await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button, .mdr-dialog button')].find((x) => x.textContent.trim() === '恢复'); if (b) { b.click(); return true; } return false; });
      await sleep(800);
      const t = await editorText(w);
      d.editor = `${sha(Buffer.from(t, 'utf8'))} len ${t.length} fffd ${t.split(String.fromCharCode(0xfffd)).length - 1}`;
      await clearToasts(w);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
      await sleep(1300);
      d.saveToasts = await toasts(w);
      const after = fs.readFileSync(file);
      d.saved = after.equals(bytes) ? 'unchanged' : `${sha(after)} len ${bytes.length}->${after.length} diff ${diffCount(after, bytes)}`;
      out.rows.push(d);
      await closeApp();
      await sleep(500);
    }
  }
} catch (e) {
  out.errors.push(String(e && e.stack || e).slice(0, 600));
} finally {
  clearTimeout(timer);
  await closeApp();
  cleanup();
  console.log(JSON.stringify(out, null, 1));
}
