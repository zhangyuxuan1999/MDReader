// bench/electron/install-acceptance.mjs — INSTALL acceptance with real Apple events (LaunchServices),
// the same path a Finder double-click takes. Isolated profile, synthetic files in a temp directory.
//
//   node bench/electron/install-acceptance.mjs            (MDR_APP=/Applications/MDReader.app by default)
//
// (a) cold start: open -n -a <app> fileA --args --user-data-dir=<tmp> --remote-debugging-port=<p>
//     --inspect-brk=<q>; the main process is paused until the macOS recent-documents stub is installed
//     (app.addRecentDocument = () => {}) through the Node inspector, then resumed. The window shows fileA.
// (b) THE USER'S SCENARIO: window.close() from the page (app keeps running), then `open fileB` (plain
//     default-handler open) → exactly one window, showing fileB.
// (c) the same with fileC.
// (d) Dock-style reactivation: close the window, `open -a <app>` → one empty 未命名 window; then
//     `open fileD` → that same window shows fileD.
// (e) quit this instance, remove the temp profile and files, nothing left listening on the ports.
//
// SAFETY: before every `open` that does not carry -n, the script checks that its own instance is alive
// and is the only MDReader main process, so LaunchServices can never start the app with the user's
// real profile. If that check fails the step is aborted.
import { chromium } from '@playwright/test';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const APP = process.env.MDR_APP || '/Applications/MDReader.app';
const EXE = path.join(APP, 'Contents', 'MacOS', 'MDReader');
const BUNDLE_ID = 'com.zyx.mdreader';
const GLOBAL_TIMEOUT_MS = Number(process.env.MDR_TIMEOUT_MS || 150000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
};
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const run = (cmd, args, timeout = 20000) => new Promise((res) => {
  execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) =>
    res({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }));
});
const mainPids = () => {
  try {
    return execFileSync('pgrep', ['-f', `^${EXE} `], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch { return []; }
};
const ownPid = (prof) => {
  try {
    return execFileSync('pgrep', ['-f', `^${EXE} .*--user-data-dir=${prof}`], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(Number)[0] ?? null;
  } catch { return null; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (port) => {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
};

// ---- minimal Node-inspector client (main process) ----
async function inspectorConnect(port, deadlineMs = 15000) {
  const end = Date.now() + deadlineMs;
  let wsUrl = null;
  while (Date.now() < end && !wsUrl) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list[0]?.webSocketDebuggerUrl ?? null;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) return null;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('inspector ws error')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evaluate = async (expression) => {
    // no awaitPromise: while the main process is paused at --inspect-brk that would never settle
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true }),
      sleep(8000).then(() => ({ error: { message: 'inspector evaluate timed out' } })),
    ]);
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { ws, send, evaluate, on: (fn) => listeners.push(fn), close: () => { try { ws.close(); } catch { /* */ } } };
}

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-accept-prof-'));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-accept-')));
const mk = (name, h1, body) => { const p = path.join(dir, name); fs.writeFileSync(p, `# ${h1}\n\n${body}\n`); return { p, name, h1, len: `# ${h1}\n\n${body}\n`.length }; };
const A = mk('accept-a.md', '验收 A', '冷启动打开的文件，不应该为空。');
const B = mk('accept-b.md', '验收 B', '关窗后用默认程序打开（用户的场景）。');
const C = mk('accept-c.md', '验收 C', '再关一次窗口再打开。');
const D = mk('accept-d.md', '验收 D', 'Dock 激活出空窗口后再打开。');

let cdpPort = 0, inspPort = 0, pid = null, insp = null, browser = null;
const watched = new WeakSet();
const watch = (page, label) => {
  if (watched.has(page)) return; watched.add(page);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${String(e?.message).slice(0, 200)}`));
};

async function cleanup() {
  try { insp?.close(); } catch { /* */ }
  try { await Promise.race([browser?.close(), sleep(3000)]); } catch { /* */ }
  const p = pid ?? ownPid(prof);
  if (p && alive(p)) {
    const others = mainPids().filter((x) => x !== p);
    if (others.length === 0) await run('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], 10000);
    else { try { process.kill(p, 'SIGTERM'); } catch { /* */ } }
    for (let i = 0; i < 40 && alive(p); i++) await sleep(250);
    if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } await sleep(500); }
  }
  // helpers of this profile (should already be gone)
  try { execFileSync('pkill', ['-9', '-f', '--', `--user-data-dir=${prof}`], { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(300);
  fs.rmSync(prof, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

const timer = setTimeout(async () => {
  console.log(`FAIL global timeout after ${GLOBAL_TIMEOUT_MS} ms`);
  await cleanup();
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);

async function connect() {
  try { await Promise.race([browser?.close(), sleep(2000)]); } catch { /* */ }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 15000 });
  return browser;
}
const appPages = () => browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith('app://'));
async function targetPages() {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && String(t.url).startsWith('app://'));
}
const mainWindows = async () => {
  if (!insp) return null;
  try { return await insp.evaluate(`require('electron').BrowserWindow.getAllWindows().map((w) => ({ id: w.id, destroyed: w.isDestroyed(), visible: w.isVisible() }))`); }
  catch (e) { return `n/a: ${String(e.message).slice(0, 80)}`; }
};
const snap = (page) => page.evaluate(() => ({
  title: document.title,
  editorLen: (document.querySelector('.cm-content')?.textContent ?? '').length,
  editor: (document.querySelector('.cm-content')?.textContent ?? '').slice(0, 40),
  h1: document.querySelector('.mdr-preview__body h1')?.textContent ?? null,
  mark: window.__mdrAcceptMark ?? null,
}));
async function waitForPage(pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    for (const p of appPages()) {
      watch(p, 'w');
      try { const s = await snap(p); last = s; if (pred(s)) return { page: p, s }; } catch { /* navigating */ }
    }
    await sleep(250);
  }
  return { page: null, s: last };
}
const showsFile = (f) => (s) => !!s && s.title.includes(f.name) && !s.title.includes('未命名') && s.h1 === f.h1 && s.editorLen > 0;
async function closeWindowFromPage(page) {
  await page.evaluate(() => setTimeout(() => window.close(), 0)).catch(() => {});
  const end = Date.now() + 10000;
  while (Date.now() < end) { if ((await targetPages()).length === 0) break; await sleep(200); }
  await sleep(500);
  return { cdpPages: (await targetPages()).length, mainWindows: await mainWindows(), alive: !!pid && alive(pid), pids: mainPids() };
}
function guardSingleOwnInstance(step) {
  const all = mainPids();
  if (!pid || !alive(pid) || all.length !== 1 || all[0] !== pid) {
    throw new Error(`${step}: refusing to call open — own pid ${pid} alive=${pid && alive(pid)}, MDReader main pids=${all.join(',')}`);
  }
}

let code = 0;
try {
  const before = mainPids();
  if (before.length) throw new Error(`an MDReader main process is already running (${before.join(',')}); refusing to start`);
  cdpPort = await freePort(); inspPort = await freePort();
  while (inspPort === cdpPort) inspPort = await freePort();

  // (a) cold start through LaunchServices
  const openA = run('open', ['-n', '-a', APP, A.p, '--args', `--user-data-dir=${prof}`, `--remote-debugging-port=${cdpPort}`, `--inspect-brk=127.0.0.1:${inspPort}`], 30000);
  insp = await inspectorConnect(inspPort, 15000);
  let stub = 'no inspector';
  if (insp) {
    const paused = new Promise((res) => { insp.on((m) => { if (m.method === 'Debugger.paused') res(true); }); setTimeout(() => res(false), 5000); });
    insp.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push(`[main] console.error: ${JSON.stringify(m.params.args?.map((a) => a.value ?? a.description)).slice(0, 200)}`);
      if (m.method === 'Runtime.exceptionThrown') errors.push(`[main] exception: ${String(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text).slice(0, 200)}`);
    });
    await insp.send('Runtime.enable');
    await insp.send('Debugger.enable');
    await insp.send('Runtime.runIfWaitingForDebugger');
    const wasPaused = await paused;
    stub = await insp.evaluate(`(() => { const a = process._linkedBinding('electron_browser_app').app; a.addRecentDocument = () => {}; return 'stubbed:' + (typeof a.addRecentDocument); })()`).catch((e) => `stub failed: ${e.message}`);
    await insp.send('Debugger.resume');
    await insp.send('Debugger.disable');
    stub += wasPaused ? ' (before main ran)' : ' (inspector did not pause)';
  }
  const oa = await openA;
  for (let i = 0; i < 40 && !pid; i++) { pid = ownPid(prof); if (!pid) await sleep(250); }
  console.log(`info: open -n rc=${oa.code} ${oa.stderr} pid=${pid} cdp=${cdpPort} inspector=${inspPort} recents-stub=${stub}`);
  if (!pid) throw new Error('own instance did not start');
  // wait for the CDP endpoint
  for (let i = 0; i < 60; i++) { try { await targetPages(); break; } catch { await sleep(250); } }
  await connect();
  {
    const { s } = await waitForPage(showsFile(A), 25000);
    const pages = (await targetPages()).length;
    const stubCheck = insp ? await insp.evaluate(`String(require('electron').app.addRecentDocument).replace(/\\s+/g,' ').slice(0,40)`).catch((e) => `n/a ${e.message}`) : 'n/a';
    check('(a) cold start via open -n -a <app> fileA shows fileA', showsFile(A)(s) && pages === 1,
      `title="${s?.title}" editorLen=${s?.editorLen} (file ${A.len}) h1="${s?.h1}" windows=${pages} recentsStub=${stub} addRecentDocument=${stubCheck}`);
  }

  // (b), (c) the user's scenario: close the window, then a plain default-handler open
  for (const [label, F] of [['(b) THE USER\'S SCENARIO: window.close() then `open fileB`', B], ['(c) repeat: window.close() then `open fileC`', C]]) {
    const page = appPages()[0];
    const closed = await closeWindowFromPage(page);
    const stillRunning = closed.alive && closed.cdpPages === 0;
    guardSingleOwnInstance(label);
    const o = await run('open', [F.p], 20000);
    await sleep(500);
    await connect();
    const { s } = await waitForPage(showsFile(F), 20000);
    await sleep(800);
    const pages = (await targetPages()).length;
    const mw = await mainWindows();
    const mwCount = Array.isArray(mw) ? mw.length : null;
    check(label, stillRunning && o.code === 0 && showsFile(F)(s) && pages === 1 && (mwCount === null || mwCount === 1),
      `after close: windows(cdp)=${closed.cdpPages} main=${JSON.stringify(closed.mainWindows)} appAlive=${closed.alive} pids=${closed.pids.join(',')}; open rc=${o.code}${o.stderr ? ` ${o.stderr}` : ''}; then title="${s?.title}" editorLen=${s?.editorLen} (file ${F.len}) h1="${s?.h1}" windows(cdp)=${pages} main=${JSON.stringify(mw)}`);
  }

  // (d) Dock-style reactivation, then a file into that same window
  {
    const page = appPages()[0];
    const closed = await closeWindowFromPage(page);
    guardSingleOwnInstance('(d) open -a');
    const o1 = await run('open', ['-a', APP], 20000);
    await sleep(500);
    await connect();
    const { page: emptyPage, s: s1 } = await waitForPage((s) => !!s && s.title.includes('未命名') && s.editorLen === 0, 20000);
    let tid1 = null;
    if (emptyPage) {
      await emptyPage.evaluate(() => { window.__mdrAcceptMark = 'reactivated'; });
      tid1 = (await targetPages())[0]?.id ?? null;
    }
    const pages1 = (await targetPages()).length;
    const mw1 = await mainWindows();
    check('(d1) window closed, `open -a <app>` (no file): one empty 未命名 window', closed.alive && closed.cdpPages === 0 && o1.code === 0 && !!emptyPage && pages1 === 1,
      `after close: windows(cdp)=${closed.cdpPages} appAlive=${closed.alive}; open -a rc=${o1.code}; title="${s1?.title}" editorLen=${s1?.editorLen} h1=${s1?.h1} windows(cdp)=${pages1} main=${JSON.stringify(mw1)}`);
    guardSingleOwnInstance('(d) open fileD');
    const o2 = await run('open', [D.p], 20000);
    const { s: s2 } = await waitForPage(showsFile(D), 20000);
    await sleep(800);
    const tp = await targetPages();
    const mw2 = await mainWindows();
    check('(d2) then `open fileD`: the same window shows fileD', o2.code === 0 && showsFile(D)(s2) && tp.length === 1 && tp[0]?.id === tid1,
      `open rc=${o2.code}; title="${s2?.title}" editorLen=${s2?.editorLen} (file ${D.len}) h1="${s2?.h1}" windows(cdp)=${tp.length} sameTarget=${tp[0]?.id === tid1} markKept=${s2?.mark === 'reactivated'} main=${JSON.stringify(mw2)}`);
  }
} catch (e) {
  console.log(`ERROR ${String(e?.stack || e).split('\n').slice(0, 3).join(' | ')}`);
  code = 1;
} finally {
  clearTimeout(timer);
  const p = pid;
  await cleanup();
  await sleep(500);
  const leftOwn = p ? alive(p) : false;
  const leftAll = mainPids();
  const ports = [cdpPort, inspPort].filter((x) => x && listening(x));
  check('(e) quit own instance, temp profile and files removed, ports closed',
    !leftOwn && !fs.existsSync(prof) && !fs.existsSync(dir) && ports.length === 0,
    `ownPid=${p} stillAlive=${leftOwn} MDReaderMainPids=[${leftAll.join(',')}] profileGone=${!fs.existsSync(prof)} filesGone=${!fs.existsSync(dir)} listening=[${ports.join(',')}]`);
}
console.log(`console/page errors: ${errors.length}`);
for (const e of errors) console.log(`  ${e}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`summary: passed=${results.length - failed} failed=${failed}`);
console.log(`RESULT_JSON ${JSON.stringify({ results, errors })}`);
process.exit(code || (failed ? 1 : 0));
