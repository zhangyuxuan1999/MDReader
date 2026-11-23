// bench/electron/verify-files.mjs — VERIFIER: every file flow of CONTRACT §10 against the real
// Electron shell in dev mode (own Vite on :5254, so window.__mdr test hooks are available).
//
//   node bench/electron/verify-files.mjs
//
// Never touches :5173 (the user's own dev server).
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execSync, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.MDR_PORT || 5254);
const BASE = process.env.MDR_BASE || `http://localhost:${PORT}`;
const OWN_SERVER = !process.env.MDR_BASE;

let pass = 0;
const failures = [];
const notes = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (s) => { notes.push(s); console.log(`  note ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}
async function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function until(page, fn, arg, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}
const title = (page) => page.evaluate(() => document.title);
const getText = (page) => page.evaluate(() => window.__mdr.app.getText());
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
const fileStat = (page) => page.evaluate(() => {
  const el = document.querySelector('.mdr-statusbar__item[data-stat="file"]');
  return el ? { text: el.textContent, state: el.dataset.state } : null;
});
/** Run a command through the REAL shell path: native menu item → main → mdr:command → renderer. */
const menuClick = (app, id) => app.evaluate(({ Menu }, mid) => {
  const item = Menu.getApplicationMenu().getMenuItemById(mid);
  if (!item) return false;
  item.click();
  return true;
}, id);
/** Emit the macOS Apple event the Finder/`open` uses. */
const emitOpenFile = (app, p) => app.evaluate(({ app: a }, fp) => {
  a.emit('open-file', { preventDefault() {} }, fp);
  return true;
}, p);
async function clickDialogButton(page, label) {
  const ok = await page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  if (!ok) throw new Error(`dialog button 「${label}」 not found`);
}
/** Type into CodeMirror so the document really becomes dirty. */
async function typeInEditor(page, text) {
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type(text, { delay: 5 });
  await sleep(250);
}
/** Answer 「当前文档尚未保存，是否放弃更改？」 with 丢弃 if it is up; returns true when it was. */
async function discardIfAsked(page) {
  await sleep(200);
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === '丢弃');
    if (!b) return false;
    b.click();
    return true;
  });
}
/** Put the app back on a clean untitled buffer so the next section starts from a known state. */
async function resetClean(app, page) {
  await menuClick(app, 'file.new');
  await discardIfAsked(page);
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  await page.evaluate(() => { for (const t of document.querySelectorAll('.mdr-toast')) t.remove(); });
}

let vite = null;
let app = null;
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-verify-files-'));

try {
  if (OWN_SERVER) {
    killPort(PORT);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(BASE))) throw new Error(`vite did not come up on ${BASE}`);
  }

  app = await electron.launch({ args: [ROOT], env: { ...process.env, MDR_DEV_URL: BASE } });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.waitForLoadState('domcontentloaded');
  await until(page, () => !!window.__mdr);
  check('dev renderer exposes window.mdrNative', await page.evaluate(() => !!window.mdrNative));

  // ---------------------------------------------------------------- [1] open dialog (stubbed)
  console.log('\n[1] 文件→打开… with the native open panel stubbed');
  const dlgPath = path.join(tmp, 'picked.md');
  await fsp.writeFile(dlgPath, '# 选择器打开\n\n一段正文。\n', 'utf8');
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    return true;
  }, dlgPath);
  await menuClick(app, 'file.open');
  check('open dialog loads the chosen file', !!(await until(page, () => document.title.includes('picked.md'))), await title(page));
  check('open dialog text is the file on disk', (await getText(page)) === '# 选择器打开\n\n一段正文。\n');
  check('status bar reports 已保存 after an open', (await fileStat(page))?.state === 'saved', JSON.stringify(await fileStat(page)));
  // cancel path
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); return true; });
  await menuClick(app, 'file.open');
  await sleep(500);
  check('a cancelled open panel keeps the current document', (await title(page)).includes('picked.md'));

  // ---------------------------------------------------------------- [2] open-file event
  console.log('\n[2] the OS open-file Apple event');
  const docA = path.join(tmp, '甲.md');
  await fsp.writeFile(docA, '# 甲文档\n\n内容 A\n', 'utf8');
  await emitOpenFile(app, docA);
  check('open-file loads the document', !!(await until(page, () => document.title.includes('甲.md'))), await title(page));
  check('open-file text matches disk', (await getText(page)) === '# 甲文档\n\n内容 A\n');

  console.log('\n[3] a SECOND document while the app is running (clean doc)');
  const docB = path.join(tmp, '乙.md');
  await fsp.writeFile(docB, '# 乙文档\n\n内容 B\n', 'utf8');
  await emitOpenFile(app, docB);
  check('second open-file replaces the document without a prompt',
    !!(await until(page, () => document.title.includes('乙.md'))), await title(page));
  check('second document text matches disk', (await getText(page)) === '# 乙文档\n\n内容 B\n');

  // ---------------------------------------------------------------- [4] drag & drop with a path
  console.log('\n[4] drag & drop of a real file (pathForFile → writable native document)');
  const docDrop = path.join(tmp, 'dropped.md');
  await fsp.writeFile(docDrop, '# 拖放\n\n拖进来的文件。\n', 'utf8');
  // A File that really is backed by a path on disk (what an OS drop hands the renderer).
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.id = 'mdr-verify-input';
    i.style.position = 'fixed';
    i.style.left = '-9999px';
    document.body.appendChild(i);
  });
  await page.setInputFiles('#mdr-verify-input', docDrop);
  const resolved = await page.evaluate(() => {
    const f = document.getElementById('mdr-verify-input').files[0];
    return window.mdrNative.pathForFile(f);
  });
  check('pathForFile resolves a real OS-backed File to its absolute path', resolved === docDrop, String(resolved));
  const dropRoot = await page.evaluate(() => {
    const f = document.getElementById('mdr-verify-input').files[0];
    const dt = new DataTransfer();
    dt.items.add(f);
    const target = document.querySelector('#app .mdr-app') || document.querySelector('#app')?.firstElementChild || document.getElementById('app');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return target.className || target.id;
  });
  note(`drop dispatched on ${dropRoot}`);
  await sleep(1200);
  const droppedTitle = await title(page);
  check('a dropped Markdown file is opened', droppedTitle.includes('dropped.md'), droppedTitle);
  check('the dropped file text matches disk', (await getText(page)) === '# 拖放\n\n拖进来的文件。\n');
  // …and it must be WRITABLE in place (path carried through), not a loose read-only copy.
  await typeInEditor(page, 'D');
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  const dropAfter = await fsp.readFile(docDrop, 'utf8');
  check('保存 writes a dropped file back to its original path', dropAfter === (await getText(page)), JSON.stringify(dropAfter.slice(0, 40)));
  await page.evaluate(() => document.getElementById('mdr-verify-input')?.remove());
  await resetClean(app, page);

  // ---------------------------------------------------------------- [5] save in place, byte identity
  console.log('\n[5] 保存 writes bytes identical to the editor text');
  const cases = [
    { name: 'lf-trailing.md', body: '# LF\n\n第一段。\n第二段。\n', label: 'LF + trailing newline' },
    { name: 'lf-no-trailing.md', body: '# 无尾换行\n\n最后一行没有换行', label: 'LF, NO trailing newline' },
    { name: 'crlf.md', body: '# CRLF\r\n\r\n一行。\r\n二行。\r\n', label: 'CRLF' },
    { name: 'mixed.md', body: '# 混合\r\n一行 LF\n一行 CRLF\r\n', label: 'mixed CRLF/LF' },
    { name: 'emoji.md', body: '# 表情 😀\n\n中文、emoji 😀🎉、тест\n', label: 'CJK + emoji + Cyrillic' },
  ];
  for (const c of cases) {
    const p = path.join(tmp, c.name);
    await fsp.writeFile(p, c.body, 'utf8');
    const before = await fsp.readFile(p);
    await emitOpenFile(app, p);
    await until(page, (n) => document.title.includes(n), c.name);
    const inEditor = await getText(page);
    await typeInEditor(page, 'X');
    check(`${c.label}: typing marks the document dirty`, (await title(page)).startsWith('● '), await title(page));
    await menuClick(app, 'file.save');
    await until(page, () => !document.title.startsWith('● '), null, 10000);
    const after = await fsp.readFile(p);
    const editorAfter = await getText(page);
    // CodeMirror's document is ALWAYS LF (Text.of splits on /\r\n?|\n/), so for a CRLF file the disk
    // bytes cannot equal the editor string byte-for-byte AND keep the file's line endings — those two
    // are mutually exclusive. The contract (src/shared/native.ts:8) picks line endings: the shell
    // re-applies the file's own EOL on write (electron/fileIO.mjs). Compare against that.
    const expected = Buffer.from(before.includes(0x0d) ? editorAfter.replace(/\r?\n/g, '\r\n') : editorAfter, 'utf8');
    const identical = after.equals(expected);
    check(`${c.label}: disk bytes === editor text (in the file's own line endings) after 保存`, identical,
      identical ? `${after.length} B` : `disk ${after.length} B vs expected ${expected.length} B`);
    const preservedEol = before.includes(0x0d) === after.includes(0x0d);
    check(`${c.label}: line endings preserved through open→save`, preservedEol,
      `before CR=${before.includes(0x0d)} after CR=${after.includes(0x0d)}; editor text CR=${inEditor.includes('\r')}`);
    const trailedBefore = before.length > 0 && before[before.length - 1] === 0x0a;
    const trailedAfter = after.length > 0 && after[after.length - 1] === 0x0a;
    check(`${c.label}: trailing-newline state unchanged`, trailedBefore === trailedAfter,
      `before=${trailedBefore} after=${trailedAfter}`);
    check(`${c.label}: 保存 clears the dirty dot`, !(await title(page)).startsWith('●'));
    check(`${c.label}: status bar is 已保存 after 保存`, (await fileStat(page))?.state === 'saved');
  }

  // ---------------------------------------------------------------- [6] save-as
  console.log('\n[6] 另存为');
  const asPath = path.join(tmp, '另存为结果.md');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); return true; }, asPath);
  await menuClick(app, 'file.saveAs');
  await until(page, (n) => document.title.includes(n), '另存为结果.md', 10000);
  check('另存为 switches the document to the new path', (await title(page)).includes('另存为结果.md'), await title(page));
  const asBytes = await fsp.readFile(asPath);
  check('另存为 wrote the editor text', asBytes.equals(Buffer.from(await getText(page), 'utf8')), `${asBytes.length} B`);
  // cancelled save-as must not write and must not change the document
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); return true; });
  const beforeCancel = await title(page);
  await menuClick(app, 'file.saveAs');
  await sleep(600);
  check('a cancelled 另存为 keeps the document', (await title(page)) === beforeCancel, await title(page));

  await resetClean(app, page);

  // ---------------------------------------------------------------- [7] read-only target
  console.log('\n[7] 保存 into a read-only location');
  const roDir = path.join(tmp, 'readonly');
  await fsp.mkdir(roDir);
  const roFile = path.join(roDir, 'ro.md');
  await fsp.writeFile(roFile, '# 只读目录\n\n原始内容\n', 'utf8');
  const roOriginal = await fsp.readFile(roFile);
  await emitOpenFile(app, roFile);
  await until(page, () => document.title.includes('ro.md'));
  await fsp.chmod(roFile, 0o444);
  await fsp.chmod(roDir, 0o555);
  await typeInEditor(page, 'Z');
  await menuClick(app, 'file.save');
  await sleep(1500);
  const roToasts = await toasts(page);
  check('read-only 保存 shows an error toast', roToasts.some((t) => t.includes('失败') || t.includes('权限')), JSON.stringify(roToasts));
  check('read-only 保存 keeps the document dirty', (await title(page)).startsWith('●'), await title(page));
  check('read-only 保存 did not crash the renderer', await page.evaluate(() => !!window.__mdr));
  check('read-only 保存 left the file untouched', (await fsp.readFile(roFile)).equals(roOriginal));
  const strays = await fsp.readdir(roDir);
  check('read-only 保存 left no .tmp turd behind', strays.length === 1 && strays[0] === 'ro.md', strays.join(','));
  await fsp.chmod(roDir, 0o755);
  await fsp.chmod(roFile, 0o644);
  await menuClick(app, 'file.save');   // now writable: clear the dirty state for the next section
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  await resetClean(app, page);

  // ---------------------------------------------------------------- [8] file deleted externally
  console.log('\n[8] the file is deleted on disk, then 保存');
  const gonePath = path.join(tmp, 'gone.md');
  await fsp.writeFile(gonePath, '# 会被删除\n\n内容\n', 'utf8');
  await emitOpenFile(app, gonePath);
  await until(page, () => document.title.includes('gone.md'));
  await fsp.rm(gonePath);
  await typeInEditor(page, 'Q');
  await app.evaluate(({ dialog }) => {
    globalThis.__saveDialogCalls = 0;
    dialog.showSaveDialog = async () => { globalThis.__saveDialogCalls++; return { canceled: true, filePath: undefined }; };
    return true;
  });
  await menuClick(app, 'file.save');
  await sleep(1500);
  const sdCalls = await app.evaluate(() => globalThis.__saveDialogCalls);
  const reborn = await fsp.stat(gonePath).then(() => true, () => false);
  const goneToasts = await toasts(page);
  note(`deleted-then-保存: showSaveDialog calls=${sdCalls}, file recreated=${reborn}, toasts=${JSON.stringify(goneToasts)}`);
  check('deleted-then-保存 does not crash', await page.evaluate(() => !!window.__mdr));
  check('deleted-then-保存 either recreates the file, offers 另存为, or shows a clear error',
    reborn || sdCalls > 0 || goneToasts.some((t) => t.includes('失败')),
    `recreated=${reborn} saveDialog=${sdCalls} toasts=${goneToasts.length}`);
  if (reborn) {
    const rebornBytes = await fsp.readFile(gonePath);
    check('the recreated file holds the editor text', rebornBytes.equals(Buffer.from(await getText(page), 'utf8')));
  }
  await resetClean(app, page);

  // ---------------------------------------------------------------- [9] non-UTF8 bytes
  console.log('\n[9] a file whose bytes are not valid UTF-8 (GBK)');
  const gbkPath = path.join(tmp, 'gbk.md');
  // "# 中文标题\n\n内容\n" encoded as GBK — invalid UTF-8.
  const gbk = Buffer.from([
    0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2, 0x0a, 0x0a,
    0xc4, 0xda, 0xc8, 0xdd, 0x0a,
  ]);
  await fsp.writeFile(gbkPath, gbk);
  const gbkBefore = await fsp.readFile(gbkPath);
  await emitOpenFile(app, gbkPath);
  const gbkOpened = await until(page, () => document.title.includes('gbk.md'), null, 10000);
  check('a non-UTF8 file opens without crashing', !!gbkOpened, await title(page));
  check('the renderer survives a non-UTF8 file', await page.evaluate(() => !!window.__mdr));
  const gbkText = await getText(page);
  const replacements = (gbkText.match(/�/g) || []).length;
  note(`non-UTF8 file decoded to ${JSON.stringify(gbkText)} — ${replacements} U+FFFD replacement chars`);
  // Now the destructive part: 保存 writes the decoded text back.
  await typeInEditor(page, '!');
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  const gbkAfter = await fsp.readFile(gbkPath);
  const lostBytes = gbkBefore.includes(0xd6) && !gbkAfter.includes(0xd6);
  check('NON-UTF8 ROUND TRIP: original bytes survive open→保存', !lostBytes,
    `before ${gbkBefore.length} B (${gbkBefore.toString('hex')}), after ${gbkAfter.length} B (${gbkAfter.toString('hex')})`);
  await resetClean(app, page);

  // ---------------------------------------------------------------- [9b] symlink / hardlink identity
  console.log('\n[9b] 保存 through a symlink, and a hard-linked file');
  const realDir = path.join(tmp, 'real');
  await fsp.mkdir(realDir);
  const realFile = path.join(realDir, 'target.md');
  await fsp.writeFile(realFile, '# 符号链接目标\n\n原始\n', 'utf8');
  const linkPath = path.join(tmp, 'link.md');
  await fsp.symlink(realFile, linkPath);
  await emitOpenFile(app, linkPath);
  await until(page, () => document.title.includes('link.md'));
  await typeInEditor(page, 'S');
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  const stillLink = (await fsp.lstat(linkPath)).isSymbolicLink();
  const targetText = await fsp.readFile(realFile, 'utf8');
  check('保存 through a symlink keeps it a symlink', stillLink,
    stillLink ? 'still a symlink' : 'the symlink was REPLACED by a regular file');
  check('保存 through a symlink updates the link target', targetText.startsWith('S'),
    JSON.stringify(targetText.slice(0, 20)));
  await resetClean(app, page);

  const hardA = path.join(tmp, 'hardA.md');
  const hardB = path.join(tmp, 'hardB.md');
  await fsp.writeFile(hardA, '# 硬链接\n\n原始\n', 'utf8');
  await fsp.link(hardA, hardB);
  const inoBefore = (await fsp.stat(hardA)).ino;
  await emitOpenFile(app, hardA);
  await until(page, () => document.title.includes('hardA.md'));
  await typeInEditor(page, 'H');
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  const inoAfter = (await fsp.stat(hardA)).ino;
  const bText = await fsp.readFile(hardB, 'utf8');
  check('保存 keeps the file inode (hard links stay joined)', inoAfter === inoBefore,
    `inode ${inoBefore} → ${inoAfter}${inoAfter !== inoBefore ? ' — the atomic rename broke the hard link' : ''}`);
  check('the other hard link sees the new content', bText.startsWith('H'), JSON.stringify(bText.slice(0, 16)));
  await resetClean(app, page);

  // ---------------------------------------------------------------- [9c] writable file in a read-only directory
  console.log('\n[9c] a WRITABLE file inside a read-only directory');
  const roDir2 = path.join(tmp, 'rodir');
  await fsp.mkdir(roDir2);
  const okFile = path.join(roDir2, 'writable.md');
  await fsp.writeFile(okFile, '# 可写文件\n\n原始\n', 'utf8');
  await emitOpenFile(app, okFile);
  await until(page, () => document.title.includes('writable.md'));
  await fsp.chmod(roDir2, 0o555);           // dir not writable, file still 0644
  await typeInEditor(page, 'W');
  check('the read-only-directory case starts from a dirty document', (await title(page)).startsWith('● '), await title(page));
  await menuClick(app, 'file.save');
  await sleep(2600);
  const w1 = await fsp.readFile(okFile, 'utf8');
  const roDirToasts = await toasts(page);
  check('保存 of a writable file in a read-only directory either succeeds or reports a clear error',
    w1.startsWith('W') || roDirToasts.some((t) => t.includes('失败')),
    `file starts with ${JSON.stringify(w1.slice(0, 4))}, toasts=${JSON.stringify(roDirToasts)}`);
  check('the read-only-directory failure leaves the file untouched and the document dirty',
    w1.startsWith('# 可写') && (await title(page)).startsWith('● '), JSON.stringify(w1.slice(0, 6)));
  const roDirStrays = (await fsp.readdir(roDir2)).filter((n) => n !== 'writable.md');
  check('the failed atomic write leaves no .tmp file behind', roDirStrays.length === 0, roDirStrays.join(','));
  note(`writable file + read-only dir: saved=${w1.startsWith('W')}, toasts=${JSON.stringify(roDirToasts)} `
    + '(the atomic write needs a temp file in the SAME directory)');
  await fsp.chmod(roDir2, 0o755);
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 8000);
  await resetClean(app, page);

  // ---------------------------------------------------------------- [9d] the file changed on disk since it was opened
  console.log('\n[9d] the file was changed by another program, then 保存');
  const racePath = path.join(tmp, 'race.md');
  await fsp.writeFile(racePath, '# 竞争\n\n我的版本\n', 'utf8');
  await emitOpenFile(app, racePath);
  await until(page, () => document.title.includes('race.md'));
  await sleep(1200);
  await fsp.writeFile(racePath, '# 竞争\n\n别的程序写入的版本，绝对不能丢\n', 'utf8');
  await typeInEditor(page, 'R');
  await menuClick(app, 'file.save');
  await sleep(1800);
  const raced = await fsp.readFile(racePath, 'utf8');
  const raceToasts = await toasts(page);
  const clobbered = !raced.includes('别的程序写入的版本');
  note(`external edit then 保存: the other program's text ${clobbered ? 'was OVERWRITTEN silently' : 'survived'}; `
    + `toasts=${JSON.stringify(raceToasts)}`);
  check('保存 warns before overwriting a file that changed on disk since it was opened',
    !clobbered || raceToasts.some((t) => t.includes('已被') || t.includes('修改') || t.includes('冲突')),
    clobbered ? 'no warning, the external change is gone' : 'kept');
  await resetClean(app, page);

  // ---------------------------------------------------------------- [10] very large file
  console.log('\n[10] a 50 MB Markdown file');
  const bigPath = path.join(tmp, 'huge50.md');
  const chunk = '# 大文件章节\n\n这是一段用于压力测试的正文，包含中文与 ASCII mixed content。\n\n- 列表项一\n- 列表项二\n\n```js\nconst x = 1;\n```\n\n';
  const reps = Math.ceil((50 * 1024 * 1024) / Buffer.byteLength(chunk));
  await fsp.writeFile(bigPath, chunk.repeat(reps), 'utf8');
  const bigSize = (await fsp.stat(bigPath)).size;
  note(`generated ${(bigSize / 1024 / 1024).toFixed(1)} MB test file`);
  const t0 = Date.now();
  await emitOpenFile(app, bigPath);
  const bigOpened = await until(page, () => document.title.includes('huge50.md'), null, 180000);
  const openMs = Date.now() - t0;
  check('a 50 MB file opens', !!bigOpened, `${openMs} ms to title`);
  const firstVisible = await until(page, () => {
    const b = document.querySelectorAll('.mdr-preview [data-l], .mdr-preview .md-block');
    return b.length > 0 ? b.length : 0;
  }, null, 180000);
  note(`50 MB: ${openMs} ms open→title, preview mounted ${firstVisible} blocks`);
  // responsiveness: a round trip through the renderer's event loop while the big doc is loaded
  const rtt = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(1))));
    rtt.push(Date.now() - s);
    await sleep(120);
  }
  const maxRtt = Math.max(...rtt);
  check('the app stays responsive with a 50 MB document (rAF round trip < 1000 ms)', maxRtt < 1000, `rAF rtt ${rtt.join('/')} ms`);
  const keyT0 = Date.now();
  await page.evaluate(() => { window.__mdr.app.editor.focus(); });
  await page.keyboard.type('大', { delay: 0 });
  await until(page, () => document.title.startsWith('● '), null, 20000);
  const keyMs = Date.now() - keyT0;
  check('a keystroke is accepted on the 50 MB document', (await title(page)).startsWith('●'), `${keyMs} ms to dirty`);
  check('no page/console errors during the whole file suite', errors.length === 0, errors.slice(0, 5).join(' | '));

  // leave the app clean so quit does not prompt
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); return true; }, path.join(tmp, 'final.md'));
  await menuClick(app, 'file.save');
  await until(page, () => !document.title.startsWith('● '), null, 60000);
} catch (err) {
  failures.push(`EXCEPTION: ${err && err.stack ? err.stack : err}`);
  console.error(err);
} finally {
  if (app) await app.close().catch(() => {});
  if (vite) { try { process.kill(vite.pid, 'SIGKILL'); } catch { /* gone */ } killPort(PORT); }
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n=== verify-files: ${pass} passed, ${failures.length} failed, ${notes.length} notes ===`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
