// bench/electron/v5-offk-enc.mjs — verify-off-desktop (0.2.0 r4 verification): files in ten encodings, opened,
// edited by one character at the end, saved; the bytes on disk and the text shown, one shell per run:
//   MDR_OFFK_TMP=<scratch> MDR_TARGET=cand|base node bench/electron/v5-offk-enc.mjs <part 0|1|2|3> > x.log
//   node bench/electron/v5-offk-enc.mjs --compare cand.log base.log
// Legacy encoders are built by inverting Node's TextDecoder (full ICU). Production renderer, no hooks, switch off.
// Launch only through ./_electron.mjs (isolated profile). No full screen. Global timeout 110 s.
import { electron } from './_electron.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--compare') {
  const read = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('ENC ')).map((l) => { const m = l.match(/^ENC (\S+) (.*)$/); return [m[1], m[2]]; }));
  const a = read(process.argv[3]), b = read(process.argv[4]);
  let same = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (a[k] === b[k]) same++; else console.log(`DIFF ${k}\n  cand ${a[k]}\n  base ${b[k]}`); }
  console.log(`${same} same`);
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.MDR_TARGET === 'base' ? path.join(ROOT, 'release/baseline-0.1.1.noindex') : path.resolve(ROOT, process.env.MDR_STAGING_DIR || 'release/staging-0.2.0.noindex') /* integrate r7: MDR_STAGING_DIR */;
const PART = Number(process.argv[2] || 0);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(process.env.MDR_OFFK_TMP || os.tmpdir(), 'offk-enc-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encoder(label) {
  const dec = new TextDecoder(label, { fatal: true });
  const map = new Map();
  const tryB = (bytes) => { try { const s = dec.decode(Uint8Array.from(bytes)); if ([...s].length === 1 && !map.has(s)) map.set(s, bytes); } catch { /* */ } };
  for (let i = 0; i < 256; i++) tryB([i]);
  if (!/^(windows-125|koi8|iso-8859)/.test(label)) for (let a = 0x81; a < 0xff; a++) for (let b = 0x40; b < 0xff; b++) tryB([a, b]);
  return (s) => { const out = []; for (const ch of s) { const b = map.get(ch); if (!b) throw new Error(`${label} cannot encode ${ch.codePointAt(0).toString(16)}`); out.push(...b); } return Buffer.from(out); };
}
const utf16 = (s, be) => { const b = Buffer.from(s, 'utf16le'); if (be) b.swap16(); return b; };
const SAMPLES = {
  'utf-8': ['# 标题\n\n中文段落，含 emoji 😀 与 café。\n', '# A\r\n\r\nCRLF 行尾\r\n', 'no final newline 结尾', '', '- [ ] 任务\n- [x] 完成\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'],
  'utf-8-bom': ['# 带 BOM\n\n内容\n', '# BOM CRLF\r\n文字\r\n', 'x', '# 混合\r\n行二\n行三\r\n', '$x^2$ 公式\n'],
  'utf-16le': ['# UTF-16LE\n\n中文内容\n', '# 二\r\n\r\nCRLF\r\n', 'kurz', '# Ünïcödé 😀\n', '- 列表\n- 项\n'],
  'utf-16be': ['# UTF-16BE\n\n中文内容\n', '# 二\r\n\r\nCRLF\r\n', 'kurz', '# Ünïcödé 😀\n', '- 列表\n- 项\n'],
  gbk: ['# 标题\n\n这是一个用 GBK 编码保存的中文文档，内容足够长以便识别编码。\n', '# 第二个\r\n\r\n中文与 CRLF 行尾混合的文档内容，继续写一些中文。\r\n', '短中文：你好世界，再见。', '# 列表\n\n- 苹果\n- 香蕉\n- 橙子与葡萄，以及更多的水果名称。\n', '# 表格\n\n| 名称 | 数量 |\n|---|---|\n| 铅笔 | 十二 |\n'],
  big5: ['# 標題\n\n這是一個用 BIG5 編碼保存的中文文檔，內容足夠長以便識別編碼。\n', '# 第二個\r\n\r\n繁體中文與 CRLF 行尾混合的文檔內容。\r\n', '短中文：你好世界，再見。', '# 列表\n\n- 蘋果\n- 香蕉\n- 橙子與葡萄，以及更多的水果名稱。\n', '# 說明\n\n臺灣與香港使用繁體字。\n'],
  shift_jis: ['# 見出し\n\nこれは Shift_JIS で保存された日本語の文書です。ひらがなとカタカナ。\n', '# 二番目\r\n\r\n日本語の文章と CRLF の行末。\r\n', 'こんにちは世界', '# リスト\n\n- りんご\n- みかん\n', '# 説明\n\n東京と大阪の天気は晴れです。\n'],
  'euc-kr': ['# 제목\n\n이것은 EUC-KR 로 저장된 한국어 문서입니다. 충분히 긴 내용.\n', '# 두번째\r\n\r\n한국어 문장과 CRLF 줄 끝.\r\n', '안녕하세요 세계', '# 목록\n\n- 사과\n- 배\n', '# 설명\n\n서울의 날씨는 맑습니다.\n'],
  'windows-1251': ['# Заголовок\n\nЭто документ в кодировке windows-1251, достаточно длинный текст.\n', '# Второй\r\n\r\nРусский текст и CRLF.\r\n', 'Привет мир', '# Список\n\n- яблоко\n- груша\n', '# Описание\n\nПогода в Москве хорошая.\n'],
  'windows-1252': ['# Café\n\nDéjà vu, naïve façade, smörgåsbord — “quotes”.\n', '# Zwei\r\n\r\nÄpfel und Öl, CRLF.\r\n', 'Ünïcödé', '# Liste\n\n- crème brûlée\n- jalapeño\n', '# Preis\n\n€ 12,50 und £ 9.\n'],
};
const ENCODE = { 'utf-8': (s) => Buffer.from(s, 'utf8'), 'utf-8-bom': (s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]), 'utf-16le': (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), utf16(s, false)]), 'utf-16be': (s) => Buffer.concat([Buffer.from([0xfe, 0xff]), utf16(s, true)]) };
for (const k of ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1251', 'windows-1252']) ENCODE[k] = encoder(k);
const files = [];
for (const [enc, list] of Object.entries(SAMPLES)) list.forEach((s, i) => { const f = path.join(TMP, `${enc}-${i}.md`); fs.writeFileSync(f, ENCODE[enc](s)); files.push({ name: `${enc}-${i}`, f, orig: fs.readFileSync(f) }); });
const mine = files.filter((_, i) => i % 4 === PART);

let app = null, page = null;
async function quit() {
  if (!app) return;
  const a = app; app = null;
  const pid = a.process()?.pid;
  try { await Promise.race([a.evaluate(({ app: x }) => { setTimeout(() => x.exit(0), 20); }), sleep(3000)]); } catch { /* gone */ }
  if (pid) for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { break; } if (i === 25) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } } await sleep(150); }
  await Promise.race([a.close().catch(() => {}), sleep(3000)]);
}
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); await quit(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(3); }, 110_000);
const text = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
const h = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 10);
try {
  app = await electron.launch({ args: [DIR, `--user-data-dir=${path.join(TMP, 'prof')}`], timeout: 30000 });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 20000 });
  await sleep(1000);
  for (const x of mine) {
    const before = await page.evaluate(() => document.title);
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); }, x.f);
    const d = Date.now() + 5000;
    while (Date.now() < d) { const t = await page.evaluate(() => document.title); if (t !== before && t.includes(path.basename ? '' : '')) { if (t.replace('● ', '') === `${x.name}.md`) break; } await sleep(80); }
    await sleep(500);
    const shown = await text();
    const toasts1 = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
    await page.evaluate(() => document.querySelector('.cm-content').focus());
    await page.keyboard.press('Meta+End');
    await page.keyboard.insertText('é');
    await sleep(150);
    await page.keyboard.press('Meta+s');
    await sleep(900);
    const after = fs.readFileSync(x.f);
    const toasts2 = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast')].map((t) => t.textContent.trim()));
    console.log(`ENC ${x.name} ${JSON.stringify({ shown: shown.slice(0, 50), nShown: shown.length, origHex: x.orig.subarray(0, 6).toString('hex'), after: h(after), afterLen: after.length, afterHead: after.subarray(0, 8).toString('hex'), afterTail: after.subarray(-6).toString('hex'), title: await page.evaluate(() => document.title), toasts: [...new Set([...toasts1, ...toasts2])].map((t) => t.slice(0, 60)) })}`);
  }
} catch (e) {
  console.log('THREW', String(e).split('\n')[0]);
} finally {
  clearTimeout(KILL);
  await quit();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
