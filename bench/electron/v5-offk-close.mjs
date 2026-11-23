// bench/electron/v5-offk-close.mjs — verify-off-desktop (0.2.0 r4 verification): closing and quitting with unsaved
// changes, every way and every answer, one shell per run:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-close.mjs [case ...]
// Ways: win.close() (the red button and 关闭窗口 / ⌘W, which is the role close), app.quit() (⌘Q / the menu), and
// win.close() in full screen (answered 取消, then full screen is left and the leave-full-screen event awaited before
// the instance ends: rule 7). Answers: 取消, 不保存, 保存. Afterwards a relaunch on the same profile reports whether
// a draft is offered. dialog.showSaveDialog is stubbed (cancelled). Production renderer, nothing stored for the
// switch. Launch only through ./_electron.mjs with an explicit profile under MDR_OFFK_TMP. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const ONLY = process.argv.slice(2);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-close-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app = null, page = null, prof = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try {
    const fsState = await Promise.race([a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isFullScreen())), sleep(2000).then(() => false)]);
    if (fsState) {
      await a.evaluate(({ BrowserWindow }) => new Promise((res) => { const w = BrowserWindow.getAllWindows().find((x) => x.isFullScreen()); w.once('leave-full-screen', res); w.setFullScreen(false); setTimeout(res, 8000); }));
      await sleep(1600);
    }
  } catch { /* gone */ }
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
async function launch(file) {
  app = await electron.launch({ args: [DIR, ...(file ? [file] : []), `--user-data-dir=${prof}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await sleep(1200);
  await app.evaluate(({ dialog }) => { globalThis.__offkSD = 0; dialog.showSaveDialog = async () => { globalThis.__offkSD++; return { canceled: true }; }; });
}
const text = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const dlg = () => page.evaluate(() => ({ text: [...document.querySelectorAll('.mdr-dialog')].map((d) => d.textContent.trim().slice(0, 80)), btns: [...document.querySelectorAll('.mdr-dialog__btn')].map((x) => x.textContent.trim()), focus: document.activeElement && document.activeElement.textContent && document.activeElement.classList.contains('mdr-dialog__btn') ? document.activeElement.textContent.trim() : document.activeElement?.tagName }));
const clickBtn = (l) => page.evaluate((x) => { const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((y) => y.textContent.trim() === x); if (b) b.click(); return !!b; }, l);
const until = async (fn, ms = 4000) => { const d = Date.now() + ms; while (Date.now() < d) { if (await fn().catch(() => false)) return true; await sleep(80); } return false; };
const alive = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 'gone');

async function scenario(name, how, answer, named, full) {
  prof = path.join(TMP, `prof-${name}`);
  const f = path.join(TMP, `${name}.md`);
  fs.writeFileSync(f, `# ${name}\n`);
  await launch(named ? f : null);
  if (named) await until(async () => (await text()).includes(name), 5000);
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.insertText(' typed');
  await sleep(1500); // the draft is written
  if (full) {
    await app.evaluate(({ BrowserWindow }) => new Promise((res) => { const w = BrowserWindow.getAllWindows()[0]; w.once('enter-full-screen', res); w.setFullScreen(true); setTimeout(res, 8000); }));
    await sleep(1600);
  }
  if (how === 'close') await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  else await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
  const asked = await until(async () => (await dlg()).btns.length > 0, 3000);
  const q = await dlg();
  const proc = app.process();
  let exited = false;
  proc.once('exit', () => { exited = true; });
  if (asked) await clickBtn(answer).catch(() => false);
  await sleep(2500);
  const o = { asked, q, wins: exited ? 'exited' : await alive().catch(() => 'gone'), disk: fs.readFileSync(f, 'utf8') };
  if (exited) { app = null; }
  if (o.wins === 1) { o.text = await text(); o.dlgAfter = await dlg(); o.saveDialogs = await app.evaluate(() => globalThis.__offkSD); }
  // a second close after 取消: asked again?
  if (o.wins === 1 && answer === '取消' && !full) {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    o.askedAgain = await until(async () => (await dlg()).btns.length > 0, 3000);
    if (o.askedAgain) await clickBtn('取消');
    await sleep(500);
  }
  await quit();
  // relaunch, same profile, no file: is a draft offered?
  await launch(null);
  await sleep(1200);
  o.relaunchToasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
  if (named) {
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, f);
    await sleep(1800);
    o.reopenToasts = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
  }
  await quit();
  console.log(`OBS ${name} ${JSON.stringify(o)}`);
}
const CASES = [];
for (const how of ['close', 'quit']) for (const ans of ['取消', '不保存', '保存']) for (const named of [true, false]) CASES.push([`${how}-${ans}-${named ? 'named' : 'untitled'}`, how, ans, named, false]);
CASES.push(['fullscreen-close-取消-named', 'close', '取消', true, true]);
try {
  for (const c of CASES) { if (ONLY.length && !ONLY.some((o) => c[0].startsWith(o))) continue; try { await scenario(...c); } catch (e) { console.log(`OBS ${c[0]} ${JSON.stringify({ threw: String(e).split('\n')[0] })}`); await quit(); } }
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
