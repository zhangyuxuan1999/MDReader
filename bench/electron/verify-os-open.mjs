// bench/electron/verify-os-open.mjs — VERIFIER: the actual double-click flow. Uses the OS `open`
// command (the same LaunchServices path Finder uses), with no Playwright in the loop, then relaunches
// the app under Playwright to read back what the renderer recorded.
//
//   node bench/electron/verify-os-open.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync, execSync } from 'node:child_process';
import { promises as fsp, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP || '/Applications/MDReader.app';
const EXE = path.join(APP_DIR, 'Contents', 'MacOS', 'MDReader');
const BUNDLE_ID = 'com.zyx.mdreader';

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return String(e.stdout || '').trim(); } };
const mdrPids = () => sh(`pgrep -f '${APP_DIR}/Contents/MacOS/MDReader' || true`).split('\n').filter(Boolean);
async function waitFor(fn, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(300); }
  return null;
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-verify-os-'));
const docA = path.join(tmp, '双击一.md');
const docB = path.join(tmp, '双击二.md');
const docC = path.join(tmp, '扩展名.mkdn');
await fsp.writeFile(docA, '# 双击一\n\nOS 打开的第一个文档\n', 'utf8');
await fsp.writeFile(docB, '# 双击二\n\nOS 打开的第二个文档\n', 'utf8');
await fsp.writeFile(docC, '# 扩展名测试\n\n.mkdn 也应该由 MDReader 打开\n', 'utf8');

try {
  // make sure nothing is running and the recents list starts empty
  sh(`osascript -e 'tell application id "${BUNDLE_ID}" to quit' 2>/dev/null || true`);
  for (const p of mdrPids()) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
  await sleep(1200);
  check('no MDReader process before the test', mdrPids().length === 0, mdrPids().join(','));

  // clear IndexedDB so the recents we read back can only come from this run
  {
    const app = await electron.launch({ executablePath: EXE, args: [] });
    const p = await app.firstWindow();
    await p.waitForLoadState('domcontentloaded');
    await p.evaluate(async () => {
      const open = indexedDB.open('keyval-store');
      const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
      const tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').clear();
      await new Promise((res) => { tx.oncomplete = res; });
      db.close();
    });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.session.flushStorageData(); });
    await sleep(800);
    await app.evaluate(({ app: a }) => { a.exit(0); });
    await app.close().catch(() => {});
    await sleep(1500);
  }

  // ---------------------------------------------------------------- [1] `open file.md`
  console.log('\n[1] `open <file>.md` — exactly what a Finder double-click does');
  execFileSync('open', [docA]);
  const up = await waitFor(async () => (mdrPids().length ? mdrPids() : null), 30000);
  check('`open <file>.md` launched MDReader through LaunchServices', !!up, `pids ${String(up)}`);
  const pid1 = up ? up[0] : null;
  await sleep(4000);
  const frontApp = sh(`osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true' 2>/dev/null || true`);
  note(`frontmost application bundle id: ${frontApp || '(System Events refused — no Accessibility permission)'}`);
  const exePath = sh(`ps -o comm= -p ${pid1} || true`);
  check('the launched process is the INSTALLED bundle', exePath.includes(APP_DIR), exePath);

  // ---------------------------------------------------------------- [2] second document while running
  console.log('\n[2] `open <second>.md` while MDReader is already running');
  execFileSync('open', [docB]);
  await sleep(4000);
  const pids2 = mdrPids();
  check('the second document went to the SAME process (single-instance lock)',
    pids2.length === 1 && pids2[0] === pid1, `before ${pid1}, now ${pids2.join(',')}`);

  // ---------------------------------------------------------------- [3] a non-.md Markdown extension
  console.log('\n[3] `open <file>.mkdn`');
  execFileSync('open', [docC]);
  await sleep(4000);
  const pids3 = mdrPids();
  check('a .mkdn file also opens in the same MDReader process', pids3.length === 1 && pids3[0] === pid1, pids3.join(','));

  // ---------------------------------------------------------------- [4] quit cleanly
  console.log('\n[4] quit');
  sh(`osascript -e 'tell application id "${BUNDLE_ID}" to quit'`);
  const gone = await waitFor(async () => (mdrPids().length === 0 ? true : null), 20000);
  check('the app quits on the standard Quit Apple event and leaves no process', !!gone, mdrPids().join(','));

  // ---------------------------------------------------------------- [5] what the renderer actually loaded
  console.log('\n[5] read back what the renderer recorded (recents are written only after a successful open)');
  const app = await electron.launch({ executablePath: EXE, args: [] });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await sleep(1500);
  const recents = await page.evaluate(async () => {
    const open = indexedDB.open('keyval-store');
    const db = await new Promise((res) => { open.onsuccess = () => res(open.result); });
    const req = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.recent');
    const v = await new Promise((res) => { req.onsuccess = () => res(req.result); req.onerror = () => res(undefined); });
    db.close();
    return (v || []).map((e) => ({ name: e.name, path: e.path }));
  });
  console.log(`  recents: ${JSON.stringify(recents)}`);
  // macOS resolves /var -> /private/var before handing the path to the app, so compare real paths.
  const real = (x) => { try { return realpathSync(x); } catch { return x; } };
  const recentReal = recents.map((e) => real(e.path));
  check('the OS-opened first document reached the renderer', recentReal.includes(real(docA)), real(docA));
  check('the OS-opened second document reached the renderer', recentReal.includes(real(docB)), real(docB));
  check('the OS-opened .mkdn document reached the renderer', recentReal.includes(real(docC)), real(docC));
  note('recents store the OS-resolved path (/private/var/…), not the path as typed (/var/…): the same file '
    + 'reached through both spellings would get two docIds, two recent entries and two draft keys');
  check('each document was opened ONCE (no duplicate recent entries)',
    new Set(recents.map((e) => e.path)).size === recents.filter((e) => e.path).length,
    JSON.stringify(recents.map((e) => e.path)));
  await app.evaluate(({ app: a }) => { a.exit(0); });
  await app.close().catch(() => {});
  await sleep(1200);
  check('no MDReader process survives the run', mdrPids().length === 0, mdrPids().join(','));
} catch (err) {
  failures.push(`EXCEPTION: ${err && err.stack ? err.stack : err}`);
  console.error(err);
} finally {
  for (const p of mdrPids()) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n=== verify-os-open: ${pass} passed, ${failures.length} failed, ${notes.length} notes ===`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
