// bench/electron/hunt-files-save.mjs — hunt:files follow-up: what ⌘S does to a file the shell decoded
// with the WRONG encoding (Big5 → "GBK", UTF-8 with one bad byte → "windows-1252").
// Installed app (or MDR_EXE), isolated profile, synthetic temp files; everything is removed afterwards.
//
//   node bench/electron/hunt-files-save.mjs
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-hf-prof-'));
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mdr-hf-save-'));
const ZH_HANT = '# 標題\n\n這是一個繁體中文文件。\n';
const ZH = '# 标题\n\n这是一个中文文档。\n';
const big5 = path.join(dir, 'big5.md');
fs.writeFileSync(big5, execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', 'BIG5'], { input: Buffer.from(ZH_HANT) }));
const bad = path.join(dir, 'utf8-bad.md');
fs.writeFileSync(bad, Buffer.concat([Buffer.from(ZH), Buffer.from([0xff])]));
const out = { exe: EXE, cases: [], console: [], pageErrors: [] };
let app;
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 90000);
try {
  app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${prof}`] });
  await app.evaluate(({ app }) => { app.addRecentDocument = () => {}; });
  const w = await app.firstWindow();
  w.on('console', (m) => { if (m.type() === 'error') out.console.push(m.text().slice(0, 200)); });
  w.on('pageerror', (e) => out.pageErrors.push(String(e).slice(0, 200)));
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  for (const [file, insert, decodeAs] of [[big5, '新增', 'big5'], [bad, '中', 'utf-8']]) {
    const before = fs.readFileSync(file);
    await app.evaluate(({ app }, p) => app.emit('open-file', { preventDefault() {} }, p), file);
    await w.waitForFunction((n) => document.title.includes(n), path.basename(file), { timeout: 6000 });
    await sleep(500);
    await w.evaluate((s) => {
      const v = document.querySelector('.cm-content').cmTile.view;
      v.dispatch({ changes: { from: v.state.doc.length, insert: s }, userEvent: 'input.type' });
    }, insert);
    await sleep(300);
    const t0 = await w.evaluate(() => Date.now());
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
    await sleep(1500);
    const toasts = await w.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.replace('×', '').trim()));
    const after = fs.readFileSync(file);
    const asIntended = new TextDecoder(decodeAs).decode(after);
    out.cases.push({
      file: path.basename(file), inserted: insert, bytesBefore: before.length, bytesAfter: after.length,
      changedOnDisk: !before.equals(after),
      tailDecodedAsRealEncoding: asIntended.slice(-12),
      title: await w.evaluate(() => document.title), toasts,
    });
    // Leave the document clean for the next open (dirty guard): reload from disk.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new').click());
    await sleep(400);
    const dlg = await w.evaluate(() => !!document.querySelector('.mdr-dialog'));
    if (dlg) await w.evaluate(() => [...document.querySelectorAll('.mdr-dialog__btn')].find((b) => /放弃|不保存|确定/.test(b.textContent))?.click());
    await sleep(400);
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
} finally {
  clearTimeout(timer);
  const pid = app?.process()?.pid;
  await Promise.race([app?.evaluate(({ app }) => app.exit(0)).catch(() => {}), sleep(3000)]);
  await sleep(600);
  try { if (pid) process.kill(pid, 0) && process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
  fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(out, null, 1));
}
