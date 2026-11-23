// bench/electron/v5-offk-upgrade.mjs — verify-off-desktop (0.2.0 r4 verification): the upgrade in place.
//   MDR_OFFK_TMP=<scratch> MDR_OFFK_MID=cand|base node bench/electron/v5-offk-upgrade.mjs
// Phase 1: the 0.1.1 shell creates a profile (window bounds, theme, mode, toc, recents, a draft of a named file,
// a draft of the untitled buffer, an unanswered recovery offer); app.exit(0) after flushing storage.
// Phase 2: MDR_OFFK_MID (cand = release/staging-0.2.0.noindex, base = 0.1.1 again as the control) on the SAME
// profile: everything observed is printed as one JSON line (MID ...).
// Phase 3: 0.1.1 again on that profile: printed as one JSON line (END ...).
// Run once with MID=cand and once with MID=base and compare the lines. Launch only through ./_electron.mjs with an
// explicit profile under MDR_OFFK_TMP (removed at the end). No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = path.join(ROOT, 'release/baseline-0.1.1.noindex');
const CAND = path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const MID = process.env.MDR_OFFK_MID === 'base' ? BASE : CAND;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-up-')));
const PROFILE = path.join(TMP, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await a.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.session.flushStorageData(); }); } catch { /* */ }
  await sleep(400);
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);

const A = path.join(TMP, 'alpha.md'); fs.writeFileSync(A, '# Alpha\n\nalpha text\n');
const B = path.join(TMP, 'beta.md'); fs.writeFileSync(B, '# Beta\n\nbeta text\n');
const C = path.join(TMP, 'gamma.md'); fs.writeFileSync(C, '# Gamma\n\ngamma text\n');
const DRAFT_C = '# Gamma\n\ngamma text\n草稿 C 的文字 ✓';
const DRAFT_U = '未命名草稿 U 的文字';

async function launch(dir) {
  app = await electron.launch({ args: [dir, `--user-data-dir=${PROFILE}`], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await sleep(1500);
  return page;
}
const text = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
const until = async (fn, ms = 6000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
const menuClick = (id) => app.evaluate(({ Menu }, i) => { const it = Menu.getApplicationMenu().getMenuItemById(i); if (!it) return false; it.click(); return true; }, id);
async function openDoc(page, p, marker) {
  await app.evaluate(({ app: a }, f) => { a.emit('open-file', { preventDefault() {} }, f); }, p);
  return until(async () => {
    await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃'); if (b) b.click(); });
    return (await text(page)).includes(marker);
  });
}
async function typeEnd(page, s) {
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText(s);
}
async function dumpState(page) {
  return page.evaluate(async () => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
    const dbs = (await indexedDB.databases()).map((d) => d.name);
    const idb = {};
    for (const name of dbs) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const st of db.objectStoreNames) {
        const all = await new Promise((res) => { const tx = db.transaction(st, 'readonly'); const q = tx.objectStore(st).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res('ERR'); });
        const keys = await new Promise((res) => { const tx = db.transaction(st, 'readonly'); const q = tx.objectStore(st).getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => res('ERR'); });
        idb[`${name}/${st}`] = keys.map((k, i) => {
          const v = all[i];
          const o = v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, typeof vv === 'string' ? vv : typeof vv === 'number' ? (kk.match(/at|time|modified/i) ? 'T' : vv) : typeof vv])) : v;
          return [String(k), o];
        });
      }
      db.close();
    }
    const btn = document.querySelector('[data-cmd="view.togglePreviewEdit"]');
    return { ls, dbs, idb, theme: document.documentElement.getAttribute('data-theme'), mode: document.querySelector('.mdr-app, #app, body')?.getAttribute('data-mode') ?? null, bodyCls: document.body.className, switchBtn: btn ? btn.getAttribute('aria-pressed') : 'absent', title: document.title };
  });
}
const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
const winState = () => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'window-state.json'), 'utf8')); } catch (e) { return String(e.code); } };
const normLs = (ls) => { const o = { ...ls }; delete o['mdr.previewEdit']; return o; };

async function observe(dir, label) {
  const page = await launch(dir);
  const o = { label, bounds: await bounds() };
  await sleep(1500);
  o.launchToasts = await toasts(page);
  o.launchText = await text(page);
  o.state = await dumpState(page);
  // the untitled draft offer at launch: restore it
  const restoredU = await page.evaluate(() => { const t = [...document.querySelectorAll('.mdr-toast')].find((x) => x.textContent.includes('草稿')); const b = t && [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === '恢复'); if (b) { b.click(); return true; } return false; });
  await sleep(800);
  o.untitledRestored = restoredU ? await text(page) : null;
  // gamma: opening it offers its draft
  o.openC = await openDoc(page, C, 'Gamma');
  await sleep(1200);
  o.cToasts = await toasts(page);
  const restoredC = await page.evaluate(() => { const t = [...document.querySelectorAll('.mdr-toast')].find((x) => x.textContent.includes('草稿')); const b = t && [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === '恢复'); if (b) { b.click(); return true; } return false; });
  await sleep(800);
  o.cRestored = restoredC ? await text(page) : null;
  o.cTitle = await page.evaluate(() => document.title);
  await sleep(2500); // the restored text is the draft again (dirty)
  await quit();
  o.winStateFile = winState();
  return o;
}

let out = {};
try {
  // ---- phase 1: 0.1.1 creates the profile
  let page = await launch(BASE);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ x: 133, y: 77, width: 1111, height: 733 }); });
  await sleep(600);
  await menuClick('view.toggleTheme');
  await sleep(300);
  await menuClick('view.toggleToc');
  await sleep(300);
  // the untitled draft
  await typeEnd(page, DRAFT_U);
  await sleep(2500);
  console.log('P1 untitled typed', JSON.stringify(await text(page)));
  await openDoc(page, A, 'Alpha');
  await sleep(500);
  await openDoc(page, B, 'Beta');
  await sleep(500);
  await openDoc(page, C, 'Gamma');
  await sleep(500);
  await typeEnd(page, '\n草稿 C 的文字 ✓');
  await sleep(2500);
  console.log('P1 C typed', JSON.stringify(await text(page)));
  await menuClick('view.mode.preview');
  await sleep(500);
  const p1 = await dumpState(page);
  p1.bounds = await bounds();
  await quit();
  p1.winStateFile = winState();
  console.log('P1', JSON.stringify(p1));
  // ---- phase 2: the candidate (or the control) on the same profile, then phase 3: 0.1.1 again
  out.mid = await observe(MID, MID === CAND ? 'cand' : 'base');
  console.log('MID', JSON.stringify(out.mid));
  out.end = await observe(BASE, 'base-after');
  console.log('END', JSON.stringify(out.end));
  const chk = (n, ok, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`);
  for (const k of ['mid', 'end']) {
    const o = out[k];
    chk(`${k}: bounds kept`, o.bounds.x === 133 && o.bounds.y === 77 && o.bounds.width === 1111 && o.bounds.height === 733, JSON.stringify(o.bounds));
    chk(`${k}: settings kept`, JSON.stringify(normLs(o.state.ls)) === JSON.stringify(normLs(p1.ls)), JSON.stringify(o.state.ls));
    chk(`${k}: untitled draft offered with the exact text`, o.untitledRestored === DRAFT_U, JSON.stringify(o.untitledRestored));
    chk(`${k}: gamma draft offered with the exact text`, o.cRestored === DRAFT_C, JSON.stringify(o.cRestored));
  }
  chk('mid: switch off and nothing stored', out.mid.label === 'base' || (out.mid.state.switchBtn === 'false' && !('mdr.previewEdit' in out.mid.state.ls)), JSON.stringify([out.mid.state.switchBtn, out.mid.state.ls['mdr.previewEdit']]));
  chk('end: the candidate left no key 0.1.1 does not know', !('mdr.previewEdit' in out.end.state.ls));
} catch (e) {
  console.log('THREW', String(e && e.stack || e).slice(0, 600));
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
