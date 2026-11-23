// bench/electron/r4-p-desk-r6.mjs — fix-flows (round 4, decision R6, finding J4) on the DESKTOP: the main
// process's mdr:writeFile handler is wrapped so the write waits 2.5 s; while it waits another document
// arrives (open-file); after the write the open document must still be the new one, bound to ITS file.
//   MDR_TARGET=dev MDR_DEV_URL=http://localhost:5462/ node bench/electron/r4-p-desk-r6.mjs [case …]
//   MDR_TARGET=baseline node bench/electron/r4-p-desk-r6.mjs              # 0.1.1 shell + renderer
// Launches only through ./_electron.mjs (isolated profile). Never full screen. Temp files go to MDR_R4P_TMP
// (default: fix-flows' scratch dir) and are removed at the end. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const TARGETS = { staging: path.join(ROOT, 'release/staging-0.2.0.noindex'), baseline: path.join(ROOT, 'release/baseline-0.1.1.noindex'), dev: ROOT };
const APP_DIR = TARGETS[process.env.MDR_TARGET || 'dev'];
const ONLY = process.argv.slice(2);
const SCRATCH = process.env.MDR_R4P_TMP || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/r4-p';
fs.mkdirSync(SCRATCH, { recursive: true });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, 'desk-r6-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => { if (ok) pass++; else fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const editorText = (page) => page.evaluate(() => {
  const v = window.__mdr && window.__mdr.app && window.__mdr.app.editor.view;
  // integrate (round 4, harness repair): without the test hooks (a production build, MDR_TARGET=staging) the
  // fallback reads the lines CodeMirror shows; a final newline is shown as an empty last line, so no '\n' is added.
  return v ? v.state.doc.toString() : [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n');
});
const clickBtn = (page, l) => page.evaluate((x) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((y) => y.textContent.trim() === x); if (b) b.click(); return !!b; }, l);
const dialogs = (page) => page.evaluate(() => document.querySelectorAll('.mdr-dialog').length);
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const title = (page) => page.evaluate(() => document.title);
async function until(page, fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await page.evaluate(fn).catch(() => false)) return true; await sleep(80); }
  return false;
}
const doc = (name, text) => { const f = path.join(TMP, name); fs.writeFileSync(f, text); return f; };

let h = null;
async function launch() {
  const app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(1500);
  h = { app, page };
  return h;
}
async function close() {
  if (!h) return;
  const cur = h;
  h = null;
  const pid = (() => { try { return cur.app.process()?.pid; } catch { return undefined; } })();
  try { await cur.app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* gone */ }
  await Promise.race([cur.app.close().catch(() => {}), sleep(4000)]);
  if (pid) for (let i = 0; i < 30; i++) { try { process.kill(pid, 0); } catch { return; } if (i === 5) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
}
/** Wraps the main process's write handler: every write waits `ms` before it runs (Electron's internal
 *  handler map; the handler itself is unchanged). */
const slowWrites = (app, ms) => app.evaluate(({ ipcMain }, delay) => {
  const map = ipcMain._invokeHandlers;
  const orig = globalThis.__r4pOrigWrite || (map && map.get('mdr:writeFile'));
  if (!orig) return false;
  globalThis.__r4pOrigWrite = orig;
  ipcMain.removeHandler('mdr:writeFile');
  ipcMain.handle('mdr:writeFile', async (e, ...a) => { if (delay) await new Promise((r) => setTimeout(r, delay)); return orig(e, ...a); });
  return true;
}, ms);
async function openDoc(p, text) {
  await emitOpenFile(h.app, p);
  await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, 700);
  if (await dialogs(h.page)) await clickBtn(h.page, '丢弃');
  for (let i = 0; i < 60; i++) { if ((await editorText(h.page)) === text) return true; await sleep(80); }
  return false;
}
async function typeAtEnd(s) {
  await h.page.evaluate(() => { const e = window.__mdr && window.__mdr.app; if (e) e.editor.focus(); else document.querySelector('.cm-content').focus(); });
  await h.page.keyboard.press('Meta+End');
  await h.page.keyboard.type(s);
}

const CASES = {
  // a dirty document: ⌘S, then the OS opens another document while the write waits; 丢弃
  async 'open-during-save'() {
    const a = doc('a1.md', '# A1\n');
    const b = doc('b1.md', '# B1\n');
    check('open-during-save: a1 opened', await openDoc(a, '# A1\n'));
    check('open-during-save: stub', await slowWrites(h.app, 2500));
    await typeAtEnd('typed');
    await h.page.keyboard.press('Meta+s');
    await sleep(200);
    await emitOpenFile(h.app, b);
    const asked = await until(h.page, () => document.querySelectorAll('.mdr-dialog').length === 1, 1500);
    if (asked) await clickBtn(h.page, '丢弃');
    await sleep(3300);
    await slowWrites(h.app, 0);
    const t1 = await title(h.page);
    const text1 = await editorText(h.page);
    const disk1 = fs.readFileSync(a, 'utf8');
    await typeAtEnd('more');
    await h.page.keyboard.press('Meta+s');
    await sleep(1500);
    const r = { asked, t1, text1, disk1, a: fs.readFileSync(a, 'utf8'), b: fs.readFileSync(b, 'utf8'), t2: await title(h.page) };
    check('open-during-save', disk1 === '# A1\ntyped' && r.a === '# A1\ntyped' && r.b === '# B1\nmore' && !/a1\.md/.test(t1) && /b1\.md/.test(t1), JSON.stringify(r));
  },
  // a clean document: a habitual ⌘S, the OS opens another document at once (no question)
  async 'clean-save-open'() {
    const a = doc('a2.md', '# A2\n');
    const b = doc('b2.md', '# B2\n');
    check('clean-save-open: a2 opened', await openDoc(a, '# A2\n'));
    check('clean-save-open: stub', await slowWrites(h.app, 2500));
    await h.page.keyboard.press('Meta+s');
    await sleep(200);
    const opened = await openDoc(b, '# B2\n');
    await sleep(3300);
    await slowWrites(h.app, 0);
    const t1 = await title(h.page);
    await typeAtEnd('more');
    await h.page.keyboard.press('Meta+s');
    await sleep(1500);
    const r = { opened, t1, a: fs.readFileSync(a, 'utf8'), b: fs.readFileSync(b, 'utf8') };
    check('clean-save-open', opened && r.a === '# A2\n' && r.b === '# B2\nmore' && t1 === 'b2.md', JSON.stringify(r));
  },
  // control: a slow save with no replacement still binds and cleans the title
  async 'slow-save-control'() {
    const a = doc('a3.md', '# A3\n');
    check('slow-save-control: a3 opened', await openDoc(a, '# A3\n'));
    check('slow-save-control: stub', await slowWrites(h.app, 1500));
    await typeAtEnd('typed');
    await h.page.keyboard.press('Meta+s');
    await sleep(2300);
    await slowWrites(h.app, 0);
    const r = { t: await title(h.page), a: fs.readFileSync(a, 'utf8') };
    check('slow-save-control', r.t === 'a3.md' && r.a === '# A3\ntyped', JSON.stringify(r));
  },
};

const timer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); close().finally(() => process.exit(2)); }, 110_000);
try {
  await launch();
  for (const [name, fn] of Object.entries(CASES)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try { await fn(); } catch (err) { check(name, false, String(err).split('\n')[0]); }
  }
} finally {
  await close();
  clearTimeout(timer);
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
process.exit(fails.length ? 1 : 0);
