// bench/electron/verify-hotfix-review-ansi.mjs — review probe (verify:review#1, 2026-11-20):
// a valid UTF-8 Markdown file with ANSI-coloured terminal output in a code block (ESC bytes > 2 %)
// opened with the window open, and after the window was closed. Prints what the window shows.
//   MDR_EXE=/path/to/MDReader.app/Contents/MacOS/MDReader node bench/electron/verify-hotfix-review-ansi.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE;
if (!EXE) { console.error('set MDR_EXE'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-review-ansi-')));
const PROF = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prof-review-ansi-'));
const errors = [];
let app = null;
let pid = null;
const ESC = '\u001b';
const file = path.join(TMP, 'review-ansi-log.md');
let body = '# 测试日志 ansi\n\n下面是终端输出：\n\n```\n';
for (let i = 0; i < 8; i++) body += `${ESC}[32m✓${ESC}[0m case ${i} ok\n`;
body += '```\n\nmarker-ansi-正文\n';
fs.writeFileSync(file, body, 'utf8');

const timer = setTimeout(() => { console.log('FAIL global timeout'); done(2); }, 90000);
async function done(code) {
  clearTimeout(timer);
  try { if (app) await Promise.race([app.evaluate(({ app: a }) => a.exit(0)).catch(() => {}), sleep(3000)]); } catch { /* */ }
  if (app) await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(PROF, { recursive: true, force: true });
  console.log(`console/page errors: ${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  process.exit(code);
}
const snap = () => app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w) return { windows: 0 };
  if (w.webContents.isLoading()) return { windows: 1, loading: true };
  return w.webContents.executeJavaScript(`({ windows: 1, title: document.title,
    editorLen: (document.querySelector('.cm-content')?.textContent ?? '').length,
    hasMarker: (document.querySelector('.cm-content')?.textContent ?? '').includes('marker-ansi'),
    toasts: [...document.querySelectorAll('.mdr-toast, [class*=toast]')].map((t) => t.textContent.trim()).filter(Boolean).slice(0, 2) })`);
});
const ctrlShare = (() => { const m = body.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g); return (m ? m.length : 0) / body.length; })();

try {
  app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${PROF}`], timeout: 30000 });
  pid = app.process()?.pid;
  await app.evaluate(({ app: a }) => { a.addRecentDocument = () => {}; }); // rule 6
  app.on('window', (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${String(e && e.message).slice(0, 160)}`));
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  console.log(`file bytes=${fs.statSync(file).size} controlShare=${(ctrlShare * 100).toFixed(1)}%`);
  await app.evaluate(({ app: a }, fp) => a.emit('open-file', { preventDefault() {} }, fp), file);
  await sleep(2500);
  const a = await snap();
  console.log(`window open: ${JSON.stringify(a)}`);
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  await sleep(1200);
  await app.evaluate(({ app: x }, fp) => x.emit('open-file', { preventDefault() {} }, fp), file);
  let b = null;
  for (let i = 0; i < 30; i++) { await sleep(300); b = await snap().catch(() => b); if (b && !b.loading && b.windows === 1 && b.title) break; }
  await sleep(1500);
  b = await snap().catch(() => b);
  console.log(`after close: ${JSON.stringify(b)}`);
  const shown = !!(a.hasMarker && b && b.hasMarker);
  console.log(`${shown ? 'PASS' : 'FAIL'} ANSI-coloured UTF-8 .md is shown (window open and after close)`);
  await done(shown ? 0 : 1);
} catch (err) {
  console.log(`FAIL script error ${String(err && err.message).slice(0, 200)}`);
  await done(1);
}
