// bench/electron/v4-dec-preview.mjs — verify-decoder (0.2.0 stage 2d): the NEW save path of 0.2.0 —
// in-preview editing — on files in a legacy encoding. Opens each file (open-file), clicks into its second
// paragraph in the preview (a session starts on mouse release), types one of several edits, leaves with
// Escape, saves from the menu, and checks: the save is not refused, the saved bytes decode (same label)
// to the original text with only the edited paragraph changed, and no invisible character (NBSP, ZWSP,
// BOM, NUL) the user did not type reached the file.
//   MDR_APP_DIR=/Users/zyx/LocalDocuments/MDReader/release/staging-0.2.0.noindex SCRATCH=<dir> node bench/electron/v4-dec-preview.mjs
// Wrapper launch (isolated profile). Global timeout 4 min (run it in the background). Temp files under
// SCRATCH, removed in finally. Prints one JSON line per case and a summary; exit 1 on a failure.
import { electron } from './_electron.mjs';
import { previewEditOn } from './r4-rel-switch.mjs'; // fix-release: 预览可编辑 is off by default without test hooks
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const APP_DIR = process.env.MDR_APP_DIR;
if (!APP_DIR) { console.error('set MDR_APP_DIR'); process.exit(64); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), 'v4dec-prev-')));
const iconv = (s, to) => spawnSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(s, 'utf8') }).stdout;
const DOCS = [
  ['gbk', 'GBK', '# 记录\n\n第一段：本周加班八小时，报销三百元。\n\n第二段文字，用于测试预览编辑。\n\n第三段保持不变。\n'],
  ['gbk-crlf', 'GBK', '# 记录\r\n\r\n第一段：本周加班八小时。\r\n\r\n第二段文字，用于测试预览编辑。\r\n\r\n第三段保持不变。\r\n'],
  ['sjis', 'CP932', '# 記録\n\nｺｰﾄﾞ ⅰ①の説明です。\n\n第二段落のテキストです。\n\n第三段落はそのまま。\n'],
  ['euckr', 'EUC-KR', '# 기록\n\n첫 번째 문단입니다.\n\n두 번째 문단 텍스트입니다.\n\n세 번째 문단은 그대로.\n'],
  ['cp1252', 'WINDOWS-1252', '# Notes\n\nPremier paragraphe, caf' + String.fromCharCode(0xe9) + '.\n\nDeuxi' + String.fromCharCode(0xe8) + 'me paragraphe ici.\n\nTroisi' + String.fromCharCode(0xe8) + 'me.\n'],
  ['utf16le', 'UTF-16LE', '# 记录\n\n第一段。\n\n第二段文字，用于测试预览编辑。\n\n第三段。\n'],
];
const EDITS = [
  ['type', async (p) => { await p.keyboard.type('ab'); }],
  ['double-space', async (p) => { await p.keyboard.type('a  b'); }],
  ['space-at-start', async (p) => { await p.keyboard.press('Home'); await p.keyboard.type(' Q'); }],
  ['enter-type', async (p) => { await p.keyboard.press('Enter'); await p.keyboard.type('Z'); }],
  ['shift-enter', async (p) => { await p.keyboard.press('Shift+Enter'); await p.keyboard.type('Y'); }],
  ['select-all-cjk', async (p) => { await p.keyboard.press('Meta+A'); await p.keyboard.type('X'); }],
  ['backspace-join', async (p) => { await p.keyboard.press('Home'); await p.keyboard.press('Backspace'); }],
];
const INVIS = [0xa0, 0x200b, 0xfeff, 0x00, 0x2060, 0x200c, 0x200d];
const rows = [];
let fails = 0;
let app = null;
async function close() {
  if (!app) return;
  const pid = app.process()?.pid;
  try { await Promise.race([app.evaluate(({ app: a }) => a.exit(0)), sleep(3000)]); } catch { /* gone */ }
  await Promise.race([app.close().catch(() => {}), sleep(4000)]);
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  app = null;
}
const timer = setTimeout(async () => { console.log(JSON.stringify({ error: 'GLOBAL TIMEOUT', rows: rows.length })); await close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(2); }, 240_000);
try {
  app = await electron.launch({ args: [APP_DIR], timeout: 30000 });
  const w = await app.firstWindow();
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  // Release decision for 0.2.0 (CONTRACT §11): without test hooks 预览可编辑 is off until turned on; this script
  // needs it on and turns it on itself through the menu item (fix-release, bench/electron/r4-rel-switch.mjs).
  await previewEditOn(app, w);
  const toasts = () => w.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.replace('×', '').trim()));
  for (const [dn, label, text] of DOCS) {
    const bytes = label === 'UTF-16LE' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : iconv(text, label);
    const decLabel = label === 'CP932' ? 'shift_jis' : label === 'GBK' ? 'gbk' : label.toLowerCase();
    for (const [en, edit] of EDITS) {
      const file = path.join(dir, `${dn}-${en}.md`);
      fs.writeFileSync(file, bytes);
      await app.evaluate(({ app: a }, p) => a.emit('open-file', { preventDefault() {} }, p), file);
      const shown = await w.waitForFunction((n) => document.title.includes(n), path.basename(file), { timeout: 8000 }).then(() => true, () => false);
      await sleep(900);
      await w.evaluate(() => document.querySelectorAll('.mdr-toast').forEach((t) => t.remove()));
      const pt = await w.evaluate(() => {
        const ps = [...document.querySelectorAll('.mdr-preview section.md-block p')];
        const p = ps[1];
        if (!p || !p.firstChild) return null;
        const t = p.firstChild;
        const r = document.createRange(); r.setStart(t, Math.min(4, t.length - 1)); r.setEnd(t, Math.min(5, t.length));
        const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
      });
      const row = { doc: dn, edit: en, shown };
      if (!pt) { row.error = 'no paragraph'; rows.push(row); fails++; continue; }
      await w.mouse.click(pt.x, pt.y);
      row.session = await w.waitForFunction(() => !!document.querySelector('.mdr-preview .is-editing'), null, { timeout: 3000 }).then(() => true, () => false);
      await sleep(250);
      await edit(w);
      await sleep(300);
      await w.keyboard.press('Escape');
      await sleep(600);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.save').click());
      await sleep(1300);
      row.saveToasts = (await toasts()).filter((t) => /保存|编码/.test(t) && t !== '已保存');
      const after = fs.readFileSync(file);
      const before = new TextDecoder(decLabel).decode(bytes);
      const now = new TextDecoder(decLabel).decode(after);
      const bl = before.split(/\r?\n/);
      const nl = now.split(/\r?\n/);
      // lines other than the edited paragraph (index 4 in every document) and what an Enter added
      const keep = en === 'backspace-join' ? 2 : 4; // a join also rewrites the paragraph above
      const head = bl.slice(0, keep).join('\n') === nl.slice(0, keep).join('\n');
      const tail = bl.slice(5).join('\n') === nl.slice(nl.length - (bl.length - 5)).join('\n');
      const inv = [...now].filter((c) => INVIS.includes(c.codePointAt(0))).map((c) => c.codePointAt(0).toString(16));
      const invBefore = [...before].filter((c) => INVIS.includes(c.codePointAt(0))).length;
      row.changed = !after.equals(bytes);
      row.outsideKept = head && tail;
      row.invisibleNew = inv.length - invBefore;
      row.crlfKept = !/crlf/.test(dn) || (now.match(/\r\n/g) || []).length === (now.match(/\n/g) || []).length;
      row.edited = JSON.stringify(nl.slice(keep, nl.length - (bl.length - 5)).join('\n'));
      const bad = !row.session || !row.changed || !row.outsideKept || row.invisibleNew > 0 || !row.crlfKept || row.saveToasts.length > 0;
      if (bad) { fails++; row.FAIL = true; }
      rows.push(row);
      console.log(JSON.stringify(row));
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('file.new').click());
      await sleep(400);
      await w.evaluate(() => { const b = [...document.querySelectorAll('.mdr-dialog button, .mdr-dialog__btn')].find((x) => /丢弃|不保存|放弃/.test(x.textContent)); if (b) b.click(); });
      await sleep(300);
    }
  }
} catch (e) {
  console.log(JSON.stringify({ error: String(e && e.stack || e).slice(0, 600) }));
  fails++;
} finally {
  clearTimeout(timer);
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ summary: true, cases: rows.length, fails }));
  process.exit(fails ? 1 : 0);
}
