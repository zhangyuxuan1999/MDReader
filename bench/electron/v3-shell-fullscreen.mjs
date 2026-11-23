// bench/electron/v3-shell-fullscreen.mjs — verify-shell (0.2.0 stage 2c), step 5: can a USER crash the
// main process by closing / quitting around a full-screen transition? User-level actions only: the menu
// items 关闭窗口 (role close) and 退出 (role quit) as the native roles end (BrowserWindow.close() = performClose:, app.quit()), the close question
// answered through its buttons (保存 / 不保存 / 取消), setFullScreen() standing in for the green button /
// Ctrl-Cmd-F. Never app.exit / destroy / kill while a transition runs: the teardown waits for
// leave-full-screen + 1.5 s first (CONTRACT section 11, desktop test hygiene).
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-fullscreen.mjs <group>
// groups: closes (one instance, all close cases chained), quitA (clean, in FS), quitB-save, quitB-discard,
//         quitB-cancel (chained in one instance), quitC-<ms> (leave FS, quit after ms; clean),
//         quitD-<ms> (enter FS, quit after ms; clean), quitCdirty (leave FS then quit, dirty, 不保存 at once)
import * as L from './v2-shell-lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 300000), 'v3-fullscreen');
const GROUP = process.argv[2] || 'closes';
const REPORTS = path.join(os.homedir(), 'Library/Logs/DiagnosticReports');
const ipsNames = () => { try { return fs.readdirSync(REPORTS).filter((n) => /^Electron/.test(n)); } catch { return []; } };
const ips0 = new Set(ipsNames());

let ctx = null;
let exitInfo = null;
async function launch(label) {
  ctx = await L.launch(label);
  exitInfo = null;
  ctx.app.process().once('exit', (code, signal) => { exitInfo = { code, signal, t: Date.now() }; });
  await L.firstReady(ctx.app);
  await ctx.app.evaluate(({ dialog }, dir) => {
    // the save panel (an untitled document): answer with a file in the scratch directory
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${dir}/v3-fs-saved-${Date.now()}.md` });
  }, L.TMP);
}
const alive = () => exitInfo === null;
const winState = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  .map((w) => ({ id: w.id, fs: w.isFullScreen(), vis: w.isVisible() })));

async function openDoc(tag) {
  const d = L.makeDoc(`fs-${tag}`);
  await L.emitOpen(ctx.app, d.file);
  const m = await L.mainShows(ctx.app, d, 12000);
  if (!m.ok) throw new Error(`doc ${tag} not shown: ${L.describe(m.s)}`);
  return d;
}
/** Enter full screen and wait until the transition is over (+ settle). */
const enterFs = () => ctx.app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (w.isFullScreen()) return true;
  await new Promise((res) => { w.once('enter-full-screen', res); setTimeout(res, 6000); w.setFullScreen(true); });
  await new Promise((res) => setTimeout(res, 1200));
  return w.isFullScreen();
});
/** Safe: leave full screen and wait for the transition to end + 1.5 s. */
const leaveFsSafe = () => ctx.app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w || !w.isFullScreen()) return;
  await new Promise((res) => { w.once('leave-full-screen', res); setTimeout(res, 6000); w.setFullScreen(false); });
  await new Promise((res) => setTimeout(res, 1500));
}).catch(() => {});

/** The user action: phase 'in' (already in FS), 'leave' (setFullScreen(false) then the action after ms),
 *  'enter' (setFullScreen(true) then the action after ms). Action through the menu item's click handler. */
const act = (what, phase, ms) => ctx.app.evaluate(({ BrowserWindow, Menu, app: a }, [wh, ph, delay]) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  const find = (items, role) => {
    for (const it of items) {
      if (it.role && it.role.toLowerCase() === role) return it;
      if (it.submenu) { const r = find(it.submenu.items, role); if (r) return r; }
    }
    return null;
  };
  const item = find(Menu.getApplicationMenu().items, wh === 'close' ? 'close' : 'quit');
  globalThis.__v3fs = { ev: [] };
  const t0 = Date.now();
  for (const n of ['enter-full-screen', 'leave-full-screen', 'close', 'closed']) w.on(n, () => globalThis.__v3fs.ev.push(`${Date.now() - t0}:${n}`));
  // On macOS the roles close / quit are native (MenuItem.click() does nothing for them): Cmd-W / the red button
  // end in -[NSWindow performClose:], which is what BrowserWindow.close() calls; Cmd-Q ends in app.quit().
  const fire = () => { globalThis.__v3fs.ev.push(`${Date.now() - t0}:${wh}`); if (wh === 'close') w.close(); else a.quit(); };
  if (ph === 'leave') w.setFullScreen(false);
  else if (ph === 'enter') w.setFullScreen(true);
  if (ph === 'in') fire(); else if (delay === 0) fire(); else setTimeout(fire, delay);
  return !!item;
}, [what, phase, ms]);
const fsEvents = () => ctx.app.evaluate(() => (globalThis.__v3fs ? globalThis.__v3fs.ev.join(' ') : '')).catch(() => '(gone)');

async function waitExit(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && alive()) await sleep(100);
  return exitInfo;
}
async function waitNoWindow(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive()) return 'exited';
    const ws = await winState().catch(() => null);
    if (ws && ws.length === 0) return 'closed';
    await sleep(150);
  }
  return 'open';
}
async function answer(label) {
  const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'), 8000);
  if (!q.ok) return false;
  await sleep(200);
  return L.clickBtn(ctx.app, label);
}
const newIps = () => ipsNames().filter((n) => !ips0.has(n));

async function teardown() {
  if (!ctx) return;
  if (alive()) {
    await leaveFsSafe();
    await L.hardQuit(ctx);
  } else {
    await L.hardQuit(ctx).catch(() => {});
  }
  ctx = null;
}
/** After a case that left the app running: get back to one clean, non-FS window. */
async function reset() {
  await leaveFsSafe();
  let ws = await winState();
  if (ws.length) {
    const s = await L.mainSnap(ctx.app);
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    if ((s.title || '').startsWith('●')) await answer('不保存');
    await waitNoWindow(6000);
  }
  await ctx.app.evaluate(({ app: a }) => a.emit('activate', {}, true));
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const s = await L.mainSnap(ctx.app).catch(() => null);
    if (s && s.windows === 1 && s.bridge === 'object' && s.editor !== undefined) break;
    await sleep(200);
  }
  await sleep(800);
}

// --- one close case on the live instance. Returns a description.
async function closeCase(c) {
  const d = await openDoc(c.id);
  if (c.dirty) await L.makeDirty(ctx.app, `DIRTY-${c.id}`);
  if (c.phase !== 'enter') { const ok = await enterFs(); if (!ok) return check(`[${c.id}] entered full screen`, false); }
  await act('close', c.phase, c.ms);
  let saved = 'n/a';
  if (c.dirty) {
    const a = await answer(c.answer);
    if (!a) { check(`[${c.id}] close question appeared`, false, await fsEvents()); return; }
  }
  const expectClosed = !c.dirty || c.answer !== '取消';
  const r = await waitNoWindow(expectClosed ? 10000 : 2500);
  await sleep(500);
  if (c.answer === '保存') saved = fs.readFileSync(d.file, 'utf8').includes(`DIRTY-${c.id}`);
  const ev = await fsEvents();
  const ok = alive() && (expectClosed ? r === 'closed' : r === 'open') && saved !== false;
  check(`[${c.id}] close ${c.dirty ? `dirty→${c.answer}` : 'clean'} phase=${c.phase}${c.phase !== 'in' ? `+${c.ms}ms` : ''}: main alive, window ${expectClosed ? 'closed' : 'kept'}${c.answer === '保存' ? ', saved' : ''}`,
    ok, `result=${r} alive=${alive()} exit=${JSON.stringify(exitInfo)} saved=${saved} ev=[${ev}] newIps=${JSON.stringify(newIps())}`);
  if (alive()) await reset();
}

async function quitCase(c) {
  const d = await openDoc(c.id);
  if (c.dirty) await L.makeDirty(ctx.app, `DIRTY-${c.id}`);
  if (c.phase !== 'enter') { const ok = await enterFs(); if (!ok) return check(`[${c.id}] entered full screen`, false); }
  await act('quit', c.phase, c.ms);
  if (c.dirty) {
    const a = await answer(c.answer);
    if (!a) { check(`[${c.id}] quit question appeared`, false, await fsEvents()); return; }
  }
  const expectExit = !c.dirty || c.answer !== '取消';
  const ev0 = await fsEvents();
  const ex = await waitExit(expectExit ? 12000 : 2500);
  await sleep(1500);
  const saved = c.answer === '保存' ? fs.readFileSync(d.file, 'utf8').includes(`DIRTY-${c.id}`) : 'n/a';
  const clean = ex ? ex.code === 0 && !ex.signal : null;
  const ok = expectExit ? (!!ex && clean) : alive();
  check(`[${c.id}] quit ${c.dirty ? `dirty→${c.answer}` : 'clean'} phase=${c.phase}${c.phase !== 'in' ? `+${c.ms}ms` : ''}: ${expectExit ? 'clean exit (code 0, no signal)' : 'app stays'}${c.answer === '保存' ? ', saved' : ''}`,
    ok && saved !== false, `exit=${JSON.stringify(ex)} saved=${saved} ev=[${ev0}] newIps=${JSON.stringify(newIps())}`);
  if (alive() && !expectExit) await reset();
}

const CLOSES = [
  { id: 'a-close', phase: 'in' },
  { id: 'b-close-save', phase: 'in', dirty: true, answer: '保存' },
  { id: 'b-close-discard', phase: 'in', dirty: true, answer: '不保存' },
  { id: 'b-close-cancel', phase: 'in', dirty: true, answer: '取消' },
  ...[0, 100, 300, 700].flatMap((ms) => [
    { id: `c-close-${ms}`, phase: 'leave', ms },
    { id: `c-close-dirty-${ms}`, phase: 'leave', ms, dirty: true, answer: '不保存' },
    { id: `d-close-${ms}`, phase: 'enter', ms },
    { id: `d-close-dirty-${ms}`, phase: 'enter', ms, dirty: true, answer: '不保存' },
  ]),
];

try {
  console.log(`target: ${L.TARGET} ${L.APP_DIR} group=${GROUP} ips at start=${ips0.size}`);
  await launch(`fs-${GROUP}`);
  if (GROUP === 'closes') {
    const only = process.env.V3_ONLY ? new Set(process.env.V3_ONLY.split(',')) : null;
    for (const c of CLOSES) {
      if (only && !only.has(c.id)) continue;
      if (!alive()) { check(`[${c.id}] skipped: main process gone`, false, JSON.stringify(exitInfo)); break; }
      await closeCase(c);
    }
  } else if (GROUP === 'quitA') await quitCase({ id: 'a-quit', phase: 'in' });
  else if (GROUP === 'quitB-save') await quitCase({ id: 'b-quit-save', phase: 'in', dirty: true, answer: '保存' });
  else if (GROUP === 'quitB-discard') await quitCase({ id: 'b-quit-discard', phase: 'in', dirty: true, answer: '不保存' });
  else if (GROUP === 'quitB-cancel') {
    await quitCase({ id: 'b-quit-cancel', phase: 'in', dirty: true, answer: '取消' });
    for (const ms of [0, 100, 300, 700]) if (alive()) await quitCase({ id: `c-quit-dirty-cancel-${ms}`, phase: 'leave', ms, dirty: true, answer: '取消' });
    for (const ms of [0, 100, 300, 700]) if (alive()) await quitCase({ id: `d-quit-dirty-cancel-${ms}`, phase: 'enter', ms, dirty: true, answer: '取消' });
  } else if (/^quitC-\d+$/.test(GROUP)) await quitCase({ id: GROUP, phase: 'leave', ms: Number(GROUP.split('-')[1]) });
  else if (/^quitD-\d+$/.test(GROUP)) await quitCase({ id: GROUP, phase: 'enter', ms: Number(GROUP.split('-')[1]) });
  else if (GROUP === 'quitCdirty') await quitCase({ id: 'c-quit-dirty-0', phase: 'leave', ms: 0, dirty: true, answer: '不保存' });
  else throw new Error(`unknown group ${GROUP}`);
} catch (e) {
  check('threw', false, String(e && e.stack || e).slice(0, 400));
} finally {
  await teardown();
  await sleep(1500);
  console.log(`new Electron crash reports during this run: ${JSON.stringify(newIps())}`);
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
