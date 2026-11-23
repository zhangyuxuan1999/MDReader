// bench/electron/v3-dec-e2e.mjs — verify-decoder (0.2.0 stage 2c), step 4: decoder results end to end in
// the running shell, through every open path (argv, open-file, the 打开… panel with a stubbed native
// dialog, a drop, 重新载入 from the conflict toast) and a draft restore of a lenient UTF-8 document.
// Per case: the native warning dialog (warnReplaced) text, the legacy-encoding toast, the editor text,
// and the bytes a menu 保存 writes after one appended ASCII character. Same script for both shells:
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v3-dec-e2e.mjs
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/baseline-0.1.1.noindex node bench/electron/v3-dec-e2e.mjs
// PHASE=paths|draft (default both). Isolated profiles (wrapper; the draft phase brings its own profile
// so its second launch sees the first one's draft). Temp files under $SCRATCH or os.tmpdir(), removed in
// finally. No full screen is ever entered. Global timeout 110 s.
import { electron } from './_electron.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const PHASE = process.env.PHASE || 'paths,draft';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.SCRATCH || os.tmpdir();
const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'mdr-v3dec-')));
const draftProf = fs.mkdtempSync(path.join(base, 'mdr-prof-v3dec-'));
const H = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const A = (s) => Buffer.from(s, 'latin1');
const U = (s) => Buffer.from(s, 'utf8');
// the test bytes are built with the tree's WHATWG tables in both runs (same bytes for both shells)
const fileIO = await import('../../electron/fileIO.mjs');
const gbkT = fileIO.legacyEncoderTable('gbk');
const tbl = (label) => fileIO.legacyEncoderTable(label);
const encT = (s, t) => Buffer.from([...s].flatMap((c) => t.get(c)));
const sheet = '# 工时\n\n| 日期 | 时长 |\n|---|---|\n' + Array.from({ length: 20 }, (_, i) => `| 11-${String(i + 1).padStart(2, '0')} | ${8 + (i % 3)}小时 |`).join('\n') + '\n';
const zhGood = '# 笔记\n\n' + '今天的会议讨论了下一个版本的发布计划，大家一致同意先修复已知问题。'.repeat(2) + '\n';
const nec = (() => { const p = []; for (let i = 0; i < 10; i++) p.push(A('- '), H('eeef'), A(' item\n')); p.push(A('x '), H('8790'), A(' y '), H('b1'), A('\n')); return Buffer.concat(p); })();
const CASES = [
  ['dec1-gbk-sheet', encT(sheet, gbkT)],
  ['lenient-utf8', Buffer.concat([U(zhGood), H('ff'), U('\n')])],
  ['lenient-utf8-genuine-fffd', Buffer.concat([U(zhGood + String.fromCharCode(0xfffd) + '\n'), H('ff'), U(' a '), H('e4b8'), U('\n')])],
  ['gbk-clean', encT(zhGood, gbkT)],
  ['big5-override', encT('# 筆記\n\n這份報告說明了專案目前的進度，以及下個階段需要處理的問題。第十章、卅年。\n', tbl('big5'))],
  ['sjis-override', encT('ファイルを保存してから、もう一度開いてください。この機能はまだ実験的なものなので、ご注意ください。ⅰ①\n', tbl('shift_jis'))],
  ['euckr-override', encT('오늘 회의에서는 다음 버전의 출시 일정을 논의했습니다. 데이터베이스 마이그레이션은 주말에 진행할 예정입니다.\n', tbl('euc-kr'))],
  ['sjis-halfwidth-010', Buffer.concat([A('1,'), H('c3de b0c0'), A(',100\n2,'), H('b6de b2c4de'), A('\n')])],
  ['sjis-eeef-table010', Buffer.concat([A('- '), H('eeef'), A(' a '), H('b1'), A('\n')])],
  ['dec2-sjis-nec', nec],
  ['cp1252', A('Caf\xe9 cr\xe8me br\xfbl\xe9e \xff\n')],
  ['utf16le-nobom', Buffer.from('# notes\n\nplain ascii text in utf-16\n', 'utf16le')],
  ['utf8-bom-crlf-notrail', Buffer.concat([H('efbbbf'), U('# 标题\r\n\r\n正文')])],
];
const out = { appDir: APP_DIR, paths: [], draft: null, errors: [] };
let app = null;
const timer = setTimeout(async () => { out.errors.push('GLOBAL TIMEOUT'); console.log(JSON.stringify(out, null, 1)); await closeApp(); cleanup(); process.exit(2); }, 110_000);
function cleanup() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(draftProf, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
async function closeApp(hard = false) {
  if (!app) return;
  const pid = app.process()?.pid;
  if (!hard) {
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  }
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  app = null;
}
async function launch(extraArgs = [], profile = null) {
  const args = [APP_DIR, ...(profile ? [`--user-data-dir=${profile}`] : []), ...extraArgs];
  app = await electron.launch({ args, timeout: 30000 });
  const w = await app.firstWindow();
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__boxes = globalThis.__boxes || [];
    dialog.showMessageBox = async (...x) => {
      const o = x.find((y) => y && typeof y === 'object' && 'message' in y) || {};
      globalThis.__boxes.push({ message: o.message, detail: o.detail });
      return { response: 0, checkboxChecked: false };
    };
  });
  return w;
}
const editorText = (w) => w.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
const toasts = (w) => w.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.replace('×', '').trim()));
const clearToasts = (w) => w.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
const boxes = async () => app.evaluate(() => { const b = (globalThis.__boxes || []).slice(); globalThis.__boxes = []; return b; });
async function waitTitle(w, name) {
  return w.waitForFunction((n) => document.title.includes(n), name, { timeout: 8000 }).then(() => true, () => false);
}
function diffCount(a, b) { let n = Math.abs(a.length - b.length); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n; }
async function saveAppend(w, file, bytes, r) {
  await clearToasts(w);
  await w.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' }, userEvent: 'input.type' }); });
  await sleep(250);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
  await sleep(1300);
  r.saveToasts = await toasts(w);
  const after = fs.readFileSync(file);
  const expected = Buffer.concat([bytes, /utf16le/.test(file) ? Buffer.from('x', 'utf16le') : A('x')]);
  r.saved = after.equals(bytes) ? 'unchanged' : after.equals(expected) ? 'exact+x' : `REWRITTEN (${diffCount(after, expected)} bytes differ from original+x; len ${expected.length}->${after.length})`;
  r.savedHead = after.subarray(0, 24).toString('hex');
}
async function resetDoc(w) {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new').click());
  await sleep(400);
  await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog button, .mdr-dialog__btn')].find((x) => /丢弃|不保存|放弃/.test(x.textContent)); if (b) b.click(); });
  await sleep(400);
}
async function openVia(w, how, file) {
  if (how === 'open-file') await app.evaluate(({ app: a }, p) => a.emit('open-file', { preventDefault() {} }, p), file);
  else if (how === 'panel') {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, file);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.open').click());
  } else if (how === 'drop') {
    await w.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = '__v3drop'; i.style.display = 'none'; document.body.append(i); });
    await w.setInputFiles('#__v3drop', file);
    await w.evaluate(() => {
      const i = document.getElementById('__v3drop');
      const dt = new DataTransfer();
      dt.items.add(i.files[0]);
      const root = document.getElementById('app');
      root.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      i.remove();
    });
  }
}
async function oneCase(w, name, bytes, how, already = false) {
  const file = path.join(dir, `${name}-${how}.md`);
  if (!already) fs.writeFileSync(file, bytes);
  await boxes();
  await clearToasts(w);
  if (!already) await openVia(w, how, file);
  const r = { name, how, shown: await waitTitle(w, path.basename(file)) };
  await sleep(600);
  r.boxes = await boxes();
  r.toasts = await toasts(w);
  const t = await editorText(w);
  r.editorHead = t.slice(0, 40);
  r.fffd = t.split(String.fromCharCode(0xfffd)).length - 1;
  if (r.shown) await saveAppend(w, file, bytes, r);
  await resetDoc(w);
  out.paths.push(r);
  return { file, r };
}
try {
  if (PHASE.includes('paths')) {
    // argv: the first case is handed over on the command line
    const argvFile = path.join(dir, 'dec1-gbk-sheet-argv.md');
    fs.writeFileSync(argvFile, CASES[0][1]);
    const w = await launch([argvFile]);
    await sleep(800);
    await oneCase(w, 'dec1-gbk-sheet', CASES[0][1], 'argv', true);
    for (const [name, bytes] of CASES) await oneCase(w, name, bytes, 'open-file');
    for (const how of ['panel', 'drop']) for (const [name, bytes] of CASES.slice(0, 3)) await oneCase(w, name, bytes, how);
    // 重新载入 from the conflict toast (file changed on disk, then 保存)
    {
      const [name, bytes] = CASES[1];
      const file = path.join(dir, `${name}-reload.md`);
      fs.writeFileSync(file, bytes);
      await openVia(w, 'open-file', file);
      const r = { name, how: 'reload', shown: await waitTitle(w, path.basename(file)) };
      await sleep(600);
      r.boxesOpen = await boxes();
      const later = Date.now() / 1000 + 10;
      fs.utimesSync(file, later, later);
      await clearToasts(w);
      await w.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' }, userEvent: 'input.type' }); });
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
      await sleep(1200);
      r.conflictToasts = await toasts(w);
      r.clicked = await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button')].find((x) => x.textContent.includes('重新载入')); if (b) { b.click(); return true; } return false; });
      await sleep(1200);
      r.boxesReload = await boxes();
      const t = await editorText(w);
      r.fffdAfterReload = t.split(String.fromCharCode(0xfffd)).length - 1;
      r.dirtyX = t.endsWith('x');
      await saveAppend(w, file, bytes, r);
      out.paths.push(r);
      await resetDoc(w);
    }
    await closeApp();
  }
  if (PHASE.includes('draft')) {
    // draft restore of a lenient UTF-8 document: type, let the draft autosave, kill the app (SIGKILL: no
    // crash dialog), relaunch with the same profile, open the file again, 恢复, 保存.
    const [, bytes] = CASES[1];
    const file = path.join(dir, 'lenient-draft.md');
    fs.writeFileSync(file, bytes);
    const d = { };
    let w = await launch([], draftProf);
    await openVia(w, 'open-file', file);
    d.shown1 = await waitTitle(w, 'lenient-draft.md');
    await sleep(600);
    d.boxes1 = await boxes();
    await w.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ changes: { from: v.state.doc.length, insert: 'DRAFT' }, userEvent: 'input.type' }); });
    await sleep(2600);
    await closeApp(true);
    await sleep(800);
    w = await launch([], draftProf);
    await openVia(w, 'open-file', file);
    d.shown2 = await waitTitle(w, 'lenient-draft.md');
    await sleep(1500);
    d.boxes2 = await boxes();
    d.offer = await toasts(w);
    d.clicked = await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button, .mdr-dialog button')].find((x) => x.textContent.trim() === '恢复'); if (b) { b.click(); return true; } return false; });
    await sleep(800);
    await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog button, .mdr-dialog__btn')].find((x) => /恢复|继续|确定/.test(x.textContent)); if (b) b.click(); });
    await sleep(500);
    const t = await editorText(w);
    d.editorTail = t.slice(-12);
    d.fffd = t.split(String.fromCharCode(0xfffd)).length - 1;
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
    await sleep(1300);
    d.saveToasts = await toasts(w);
    const after = fs.readFileSync(file);
    const expectFffd = Buffer.concat([U(zhGood), H('efbfbd'), U('\nDRAFT')]);
    d.saved = after.equals(bytes) ? 'unchanged' : after.equals(expectFffd) ? 'as the dialog said (EF BF BD + DRAFT)' : after.equals(Buffer.concat([bytes, A('DRAFT')])) ? 'original bytes + DRAFT' : `OTHER ${after.toString('hex').slice(-40)}`;
    out.draft = d;
    await closeApp();
  }
} catch (e) {
  out.errors.push(String(e && e.stack || e).slice(0, 500));
} finally {
  clearTimeout(timer);
  await closeApp();
  cleanup();
  console.log(JSON.stringify(out, null, 1));
}
