// bench/electron/hunt-files-run.mjs — hunt:files runner (open-empty investigation, 2026-11-20).
//
// Opens every case of hunt-files-corpus.mjs in the INSTALLED app (or MDR_EXE) with a fresh isolated
// profile and compares what is displayed with what is on disk.
//   phase "warm": one instance, window open, each case delivered with app.emit('open-file')
//                 (the handler a Finder double-click reaches), after 文件 → 新建 resets the document;
//   phase "cold": one launch per case marked `cold`, the path passed as a command-line argument.
//
//   node bench/electron/hunt-files-run.mjs [--only=id1,id2] [--phase=warm|cold|both] [--out=result.json]
//
// Long (30 MB file, cold launches): start it in the background and poll the log.
// Never uses the user's profile; app.addRecentDocument is stubbed so temp paths never reach the
// macOS recent-documents list; everything it created is removed in finally.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCorpus } from './hunt-files-corpus.mjs';

const EXE = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',')) : null;
const PHASE = arg('phase', 'both');
const OUT = arg('out', '');
const COLD_ALL = process.argv.includes('--cold-all');
const GLOBAL_TIMEOUT_MS = Number(process.env.HUNT_TIMEOUT_MS || 15 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
};
const vis = (s) => JSON.stringify(s).slice(1, -1);

const profiles = [];
const apps = [];
let corpus = null;
const results = [];

const globalTimer = setTimeout(async () => {
  console.log('GLOBAL TIMEOUT');
  await teardown();
  process.exit(3);
}, GLOBAL_TIMEOUT_MS);

async function teardown() {
  for (const a of apps.splice(0)) {
    const pid = a.process()?.pid;
    await Promise.race([a.evaluate(({ app }) => app.exit(0)).catch(() => {}), sleep(3000)]);
    await sleep(500);
    try { if (pid) process.kill(pid, 0) && process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
  }
  await sleep(800);
  for (const p of profiles.splice(0)) fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  if (corpus) { corpus.cleanup(); corpus = null; }
}

async function launch(extraArgs = []) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-hf-prof-'));
  profiles.push(prof);
  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${prof}`, ...extraArgs], timeout: 30000 });
  apps.push(app);
  // Keep the corpus paths out of the user's macOS "Open Recent" list.
  await app.evaluate(({ app }) => { app.addRecentDocument = () => {}; }).catch(() => {});
  const log = { console: [], pageErrors: [], mainStderr: [] };
  app.process().stderr?.on('data', (d) => { const s = String(d).trim(); if (s && !/DevTools|Debugger/.test(s)) log.mainStderr.push(s.slice(0, 300)); });
  const win = await app.firstWindow({ timeout: 30000 });
  win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.console.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  win.on('pageerror', (e) => log.pageErrors.push(String(e).slice(0, 300)));
  await win.waitForSelector('.cm-content', { timeout: 30000 });
  await win.evaluate(() => {
    // Record every toast (they vanish after 4 s / 8 s) with a timestamp.
    window.__huntToasts = [];
    const seen = new WeakSet();
    const scan = () => {
      for (const t of document.querySelectorAll('.mdr-toast')) {
        if (seen.has(t)) continue;
        seen.add(t);
        window.__huntToasts.push({ t: Date.now(), text: (t.textContent || '').replace('×', '').trim().slice(0, 200), cls: t.className });
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();
  });
  return { app, win, log, prof };
}

const snapshot = (win, since) => win.evaluate((since) => {
  const c = document.querySelector('.cm-content');
  const view = c?.cmTile?.view;
  const doc = view ? view.state.doc.toString() : null;
  let h = 0x811c9dc5;
  if (doc) for (let i = 0; i < doc.length; i++) { h ^= doc.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const chunks = [...document.querySelectorAll('.mdr-preview__body .md-chunk')];
  const body = document.querySelector('.mdr-preview__body');
  const stat = (k) => document.querySelector(`.mdr-statusbar__item[data-stat="${k}"]`)?.textContent ?? null;
  return {
    title: document.title,
    docLen: doc === null ? null : doc.length,
    docLines: view ? view.state.doc.lines : null,
    head: doc === null ? null : doc.slice(0, 20),
    tail: doc === null ? null : doc.slice(-20),
    hash: doc === null ? null : h,
    previewBlocks: chunks.reduce((n, ch) => n + Number(ch.dataset.n || 0), 0),
    previewMounted: document.querySelectorAll('.mdr-preview__body section.md-block').length,
    previewTextLen: (body?.textContent || '').trim().length,
    previewErrors: document.querySelectorAll('.mdr-preview__body .md-error').length,
    statusFile: stat('file'),
    statusChars: stat('chars'),
    mode: stat('mode'),
    toasts: (window.__huntToasts || []).filter((x) => x.t >= since).map((x) => x.text),
    toastsVisible: [...document.querySelectorAll('.mdr-toast')].map((t) => (t.textContent || '').replace('×', '').trim().slice(0, 200)),
    dialog: document.querySelector('.mdr-dialog') ? (document.querySelector('.mdr-dialog').textContent || '').slice(0, 120) : null,
  };
}, since);

async function resetToUntitled(app, win) {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new')?.click());
  for (let i = 0; i < 40; i++) {
    const t = await win.evaluate(() => document.title);
    if (/^未命名/.test(t)) return true;
    await sleep(100);
  }
  return false;
}

function judge(c, s) {
  const issues = [];
  if (c.expectError) {
    if (s.toasts.length === 0) issues.push('no toast for a file that cannot be opened');
    if (s.toastsLater && s.toastsLater.length === 0) issues.push('error message gone after 9 s');
    if (s.docLen === 0 && /^未命名/.test(s.title)) issues.push('user is left on an empty untitled document');
    return issues;
  }
  if (s.docLen === null) issues.push('no editor');
  else if (s.docLen === 0) issues.push('EDITOR EMPTY');
  else if (s.hash !== fnv(c.expect)) issues.push(`text differs from disk (len ${s.docLen} vs ${c.expect.length})`);
  if (!s.title.replace(/\s/g, " ").includes(path.basename(c.path).normalize("NFC").replace(/\s/g, " ").slice(0, 12)) && !s.title.includes(path.basename(c.openPath || c.path).slice(0, 12))) issues.push(`title "${vis(s.title).slice(0, 60)}" does not name the file`);
  if (s.toasts.some((t) => /失败|无法|错误/.test(t))) issues.push(`error toast: ${s.toasts.join(' | ')}`);
  if (s.dialog) issues.push(`dialog: ${s.dialog}`);
  return issues;
}

async function runWarm(cases) {
  const { app, win, log } = await launch();
  const fifoCase = cases.find((c) => c.fifo);
  for (const c of cases) {
    const t0 = Date.now();
    const reset = await resetToUntitled(app, win);
    const since = await win.evaluate(() => Date.now());
    const openPath = c.openPath || c.path;
    await app.evaluate(({ app }, p) => { app.emit('open-file', { preventDefault() {} }, p); }, openPath);
    if (c.deleteAfterEmit) fs.rmSync(c.path, { force: true });
    if (c.fill !== undefined) fs.writeFileSync(c.path, c.fill);
    const limit = c.slow ? 120000 : 6000;
    const deadline = Date.now() + limit;
    let opened = false;
    while (Date.now() < deadline) {
      const st = await win.evaluate(() => ({ title: document.title, n: (window.__huntToasts || []).length, last: (window.__huntToasts || []).slice(-1)[0]?.t || 0 }));
      if (!/^未命名/.test(st.title) || st.last >= since) { opened = true; break; }
      await sleep(100);
    }
    const openMs = Date.now() - t0;
    await sleep(c.slow ? 3000 : 900);
    const s = await snapshot(win, since);
    s.openMs = openMs;
    s.resetOk = reset;
    s.settled = opened;
    if (c.expectError) {
      await sleep(9000);
      const later = await snapshot(win, since);
      s.toastsLater = later.toastsVisible;
      s.titleLater = later.title;
      s.docLenLater = later.docLen;
    }
    const r = { phase: 'warm', id: c.id, group: c.group, path: openPath, size: safeSize(c.path), expectLen: c.expect?.length ?? null, expectHead: c.expect?.slice(0, 20) ?? null, expectTail: c.expect?.slice(-20) ?? null, ...s };
    r.issues = judge(c, s);
    results.push(r);
    console.log(`[warm] ${c.id.padEnd(26)} ${r.issues.length ? 'ISSUE ' + r.issues.join('; ') : 'ok'}  (title=${vis(s.title).slice(0, 40)} len=${s.docLen} blocks=${s.previewBlocks} toasts=${vis(s.toasts.join('|')).slice(0, 120)} ${openMs}ms)`);
    if (c.fifo) c._pending = true;
    if (c.afterFifo && fifoCase) {
      // Unblock the hung FIFO read (writer opens non-blocking: ENXIO when nobody reads) and watch.
      let unblocked = 'no reader';
      try {
        const fd = fs.openSync(fifoCase.path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        fs.closeSync(fd);
        unblocked = 'closed writer (EOF, 0 bytes)';
      } catch (e) { unblocked = e.code; }
      await sleep(2500);
      const s2 = await snapshot(win, since);
      results.push({ phase: 'warm', id: 'fs-fifo-unblocked', group: 'fs', unblocked, ...s2, issues: [] });
      console.log(`[warm] fs-fifo-unblocked          ${unblocked} → title=${vis(s2.title)} len=${s2.docLen} toasts=${vis(s2.toasts.join('|'))}`);
    }
  }
  results.push({ phase: 'warm', id: '_log', ...log });
  console.log(`[warm] console=${log.console.length} pageErrors=${log.pageErrors.length} mainStderr=${log.mainStderr.length}`);
  for (const l of [...log.console, ...log.pageErrors, ...log.mainStderr].slice(0, 30)) console.log('   log:', l.slice(0, 200));
}

async function runCold(cases) {
  for (const c of cases) {
    const t0 = Date.now();
    let s;
    let log;
    try {
      const L = await launch([c.path]);
      log = L.log;
      const deadline = Date.now() + (c.slow ? 120000 : 8000);
      while (Date.now() < deadline) {
        const st = await L.win.evaluate(() => ({ title: document.title, n: (window.__huntToasts || []).length }));
        if (!/^未命名/.test(st.title) || st.n > 0) break;
        await sleep(150);
      }
      await sleep(c.slow ? 3000 : 1500);
      s = await snapshot(L.win, 0);
      s.openMs = Date.now() - t0;
      if (c.expectError) {
        await sleep(9000);
        const later = await snapshot(L.win, 0);
        s.toastsLater = later.toastsVisible;
        s.titleLater = later.title;
        s.docLenLater = later.docLen;
      }
      const a = apps.pop();
      const pid = a.process()?.pid;
      await Promise.race([a.evaluate(({ app }) => app.exit(0)).catch(() => {}), sleep(3000)]);
      await sleep(500);
      try { if (pid) process.kill(pid, 0) && process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    } catch (e) {
      s = { error: String(e).slice(0, 300), title: '', toasts: [] };
    }
    const r = { phase: 'cold', id: c.id, group: c.group, path: c.path, size: safeSize(c.path), expectLen: c.expect?.length ?? null, ...s, log };
    r.issues = s.error ? [s.error] : judge(c, s);
    results.push(r);
    console.log(`[cold] ${c.id.padEnd(26)} ${r.issues.length ? 'ISSUE ' + r.issues.join('; ') : 'ok'}  (title=${vis(s.title || '').slice(0, 40)} len=${s.docLen} toasts=${vis((s.toasts || []).join('|')).slice(0, 120)} ${s.openMs}ms; console=${log?.console.length ?? '-'} pageErr=${log?.pageErrors.length ?? '-'})`);
  }
}

function safeSize(p) {
  try { return fs.lstatSync(p).size; } catch { return null; }
}

try {
  console.log('exe', EXE);
  corpus = buildCorpus();
  console.log('corpus', corpus.dir, corpus.cases.length, 'cases');
  let cases = corpus.cases.filter((c) => !ONLY || ONLY.has(c.id));
  // FIFO then its follow-up; slow cases last.
  const order = (c) => (c.slow ? 3 : c.fifo ? 1 : c.afterFifo ? 2 : 0);
  cases = cases.slice().sort((a, b) => order(a) - order(b));
  if (PHASE !== 'cold') await runWarm(cases);
  if (PHASE !== 'warm') {
    // A cold launch with chmod 000 etc. — the FIFO case is never passed on the command line (pathsFromArgv
    // would hand it to the same hung read).
    // --cold-all: every selected case (except the FIFO) also gets a cold launch.
    await runCold(cases.filter((c) => (COLD_ALL || c.cold) && !c.fifo));
  }
} catch (e) {
  console.log('RUNNER ERROR', e && e.stack ? e.stack : e);
} finally {
  clearTimeout(globalTimer);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  await teardown();
  const left = profiles.length;
  console.log('cleanup done; profiles left', left, 'corpus removed', true);
  process.exit(0);
}
