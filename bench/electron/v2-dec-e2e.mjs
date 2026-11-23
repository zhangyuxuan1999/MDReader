// bench/electron/v2-dec-e2e.mjs — verify-decoder (0.2.0 stage 2a), step 3: what the running shell does
// with files that decode leniently / differently: the native dialog (warnReplaced) text, the renderer
// toasts (legacy-encoding note, save errors), what the editor shows, and which bytes ⌘S (menu 保存)
// really writes after one ASCII character is appended. Same script for the candidate and the baseline.
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex node bench/electron/v2-dec-e2e.mjs
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/baseline-0.1.1.noindex node bench/electron/v2-dec-e2e.mjs
// Optional: CASES=pt,big5 (substring filter). Isolated profile (wrapper), temp files under $SCRATCH or
// os.tmpdir(); everything removed in finally. Global timeout 100 s.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.SCRATCH || os.tmpdir();
const prof = fs.mkdtempSync(path.join(base, 'mdr-prof-v2dec-'));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'mdr-v2dec-')));
const iconv = (s, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(s, 'utf8') });
const cat = (...xs) => Buffer.concat(xs.map((x) => Buffer.from(x)));
const ALL = [
  ['lenient-utf8', cat(Buffer.from('# 标题\n\n这本小说讲的是一个年轻医生在山村卫生院工作的故事。', 'utf8'), [0xff], Buffer.from('\n'))],
  ['lenient-gbk', cat(iconv('# 会议纪要\n\n这本小说讲的是一个年轻医生在山村卫生院工作的故事。图书馆周末开放', 'GBK'), [0xca])],
  ['pt-cp1252', iconv('# Orientações\n\nNão há solução. ORIENTAÇÕES GERAIS\n', 'CP1252')],
  ['de-cp1252', iconv('# Größe\n\nÄÖÜ GRÖSSE Größe, Maß, Füße, Öl.\n', 'CP1252')],
  ['big5-ten', iconv('# 筆記\n\n十月十日是國慶日，學校放假一天。二十年前的老照片，記錄了外婆家門口那棵榕樹。卅年。\n', 'BIG5')],
  ['gbk-rare', iconv('堃 喆 昇\n', 'GBK')],
  ['cs-cp1250', iconv('# Poznámky\n\nChuť jídla a ťava. Šťastný nový rok!\n', 'CP1250')],
  ['gbk-nulpad', cat(iconv('# 会议纪要\n\n周一上午九点在三楼会议室开项目例会，请大家提前十分钟到场。\n', 'GBK'), Buffer.alloc(16))],
];
const want = (process.env.CASES || '').split(',').filter(Boolean);
const CASES = ALL.filter(([n]) => !want.length || want.some((w) => n.includes(w)));
let app = null;
const out = { appDir: APP_DIR, cases: [], mainErr: [] };
const timer = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); console.log(JSON.stringify(out, null, 1)); await done(); process.exit(2); }, 100000);
async function done() {
  if (app) {
    const pid = app.process()?.pid;
    try { out.mainErr = await Promise.race([app.evaluate(() => globalThis.__mainErr || []), sleep(1500)]); } catch { /* gone */ }
    try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
    await Promise.race([app.close().catch(() => {}), sleep(4000)]);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    app = null;
  }
  fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  fs.rmSync(dir, { recursive: true, force: true });
}
try {
  app = await electron.launch({ args: [APP_DIR, `--user-data-dir=${prof}`], timeout: 30000 });
  const w = await app.firstWindow();
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__boxes = [];
    globalThis.__mainErr = [];
    process.on('uncaughtException', (e) => globalThis.__mainErr.push(String(e && e.message)));
    dialog.showMessageBox = async (...x) => {
      const o = x.find((y) => y && typeof y === 'object' && 'message' in y) || {};
      globalThis.__boxes.push({ message: o.message, detail: o.detail });
      return { response: 0, checkboxChecked: false };
    };
  });
  await sleep(800);
  for (const [name, bytes] of CASES) {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, bytes);
    await app.evaluate(() => { globalThis.__boxes = []; });
    await w.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
    await app.evaluate(({ app: a }, p) => a.emit('open-file', { preventDefault() {} }, p), file);
    const shown = await w.waitForFunction((n) => document.title.includes(n), path.basename(file), { timeout: 8000 }).then(() => true, () => false);
    await sleep(700);
    const r = { name, bytes: bytes.length, shown };
    r.boxes = await app.evaluate(() => globalThis.__boxes.slice());
    r.openToasts = await w.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.replace('×', '').trim()));
    r.editor = await w.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString().slice(0, 70));
    if (shown) {
      await w.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
      await w.evaluate(() => {
        const v = document.querySelector('.cm-content').cmTile.view;
        v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' }, userEvent: 'input.type' });
      });
      await sleep(300);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
      await sleep(1500);
      r.saveToasts = await w.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.replace('×', '').trim()));
      const after = fs.readFileSync(file);
      const expected = Buffer.concat([bytes, Buffer.from('x')]);
      r.saved = after.equals(bytes) ? 'unchanged on disk' : after.equals(expected) ? 'original bytes + "x"' : 'REWRITTEN';
      if (r.saved === 'REWRITTEN') {
        let i = 0; while (i < after.length && i < expected.length && after[i] === expected[i]) i++;
        r.firstDiff = `byte ${i}: expected ${expected.subarray(i, i + 6).toString('hex')} got ${after.subarray(i, i + 6).toString('hex')} (len ${expected.length} → ${after.length})`;
        r.diffBytes = (() => { let n = 0; for (let k = 0; k < Math.max(after.length, expected.length); k++) if (after[k] !== expected[k]) n++; return n; })();
      }
      // leave the document clean for the next case
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new').click());
      await sleep(500);
      const btn = await w.evaluate(() => {
        const b = [...document.querySelectorAll('.mdr-dialog button, .mdr-dialog__btn')].find((x) => /丢弃|不保存|放弃/.test(x.textContent));
        if (b) { b.click(); return b.textContent; }
        return null;
      });
      r.discard = btn;
      await sleep(500);
    }
    out.cases.push(r);
  }
} catch (e) {
  out.error = String(e && e.stack || e).slice(0, 400);
} finally {
  clearTimeout(timer);
  await done();
  console.log(JSON.stringify(out, null, 1));
}
