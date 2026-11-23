// v2-dec-roundtrip.mjs — save-back semantics of electron/fileIO.mjs (candidate) and of the frozen 0.1.0
// fileIO (test/fixtures/fileIO-0.1.0.mjs): read a file with readFileInfo, hand its text through the
// renderer's line-ending normalisation (CodeMirror keeps LF only), write it back with writeFileAtomic
// the way main.mjs does, and compare the bytes; then the same with one ASCII character appended.
// verify-decoder, 0.2.0 stage 2a. Files live in $SCRATCH (default: a fresh dir under os.tmpdir()), removed at the end.
// Run: node bench/verify/v2-dec-roundtrip.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as neu from '../../electron/fileIO.mjs';
import * as old from '../../test/fixtures/fileIO-0.1.0.mjs';
import { encode } from './v2-dec-corpus.mjs';

setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000).unref();
const dir = fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), 'v2-dec-rt-'));
const cat = (...b) => Buffer.concat(b.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x))));
const gb = (s) => encode(s, 'gbk');

export const CASES = [
  ['utf-8 LF', Buffer.from('# 标题\n\n正文 text\n', 'utf8')],
  ['utf-8 BOM', cat([0xef, 0xbb, 0xbf], Buffer.from('# 标题\n正文\n', 'utf8'))],
  ['utf-8 CRLF', Buffer.from('# 标题\r\n\r\n正文\r\n', 'utf8')],
  ['utf-8 mixed LF/CRLF', Buffer.from('a\r\nb\nc\r\n', 'utf8')],
  ['utf-8 CR only', Buffer.from('a\rb\rc\r', 'utf8')],
  ['utf-8 no final newline', Buffer.from('# 标题\n正文', 'utf8')],
  ['utf-16le BOM', cat([0xff, 0xfe], Buffer.from('# 标题\r\n正文\r\n', 'utf16le'))],
  ['utf-16be BOM', cat([0xfe, 0xff], Buffer.from('# 标题\n正文\n', 'utf16le').swap16())],
  ['utf-16le no BOM', Buffer.from('# Title\nSome text 正文\n', 'utf16le')],
  ['gbk clean', gb('# 会议纪要\r\n\r\n周一上午九点在三楼会议室开项目例会，请大家提前十分钟到场。\r\n')],
  ['gbk with A2E3 (€) and A3A0', cat(gb('价格：'), [0xa2, 0xe3], gb('一百'), [0xa3, 0xa0], gb('元。这个接口在高并发下偶尔超时，排查后发现是连接池配置太小。\n'))],
  ['gb18030 four-byte char', cat(gb('生僻字：'), [0x82, 0x35, 0x8f, 0x33], gb('（四字节）。请把发票抬头写成公司全称，税号在合同第二页。\n'))],
  ['big5 with 十 (A451)', encode('十月十日是國慶日，學校放假一天。二十年前的老照片，記錄了外婆家門口那棵榕樹。\n', 'big5')],
  ['big5 with 卅 (A4CA)', encode('卅年前的老照片，記錄了外婆家門口那棵榕樹。這份報告會在下週三之前寄給各位董事。\n', 'big5')],
  ['shift_jis with FA40 (ⅰ) and 879A (∵)', cat(encode('設定ファイルを読み込めませんでした。今日はいい天気ですね。項目', 'shift_jis'), [0xfa, 0x40], encode('と', 'shift_jis'), [0x87, 0x9a], encode('東京駅で待ち合わせしましょう。\n', 'shift_jis'))],
  ['euc-kr', encode('안녕하세요, 반갑습니다.\n서울역에서 만나요.\n파일을 저장하지 못했습니다.\n', 'euc-kr')],
  ['windows-1252 French', encode('Œuvre très connue : « Où êtes-vous ? »\nCrème brûlée à la française.\n', 'windows-1252')],
  ['windows-1252 Portuguese (DEC-1)', encode('Não há solução. ORIENTAÇÕES GERAIS\n', 'windows-1252')],
  ['lenient utf-8: one stray 0xFF', cat(Buffer.from('# 标题\n\n这本小说讲的是一个年轻医生在山村卫生院工作的故事。', 'utf8'), [0xff], Buffer.from('\n', 'utf8'))],
  ['lenient utf-8 + BOM: one stray 0x80', cat([0xef, 0xbb, 0xbf], Buffer.from('# 标题\n\n这本小说讲的是一个年轻医生在山村卫生院工作的故事。', 'utf8'), [0x80], Buffer.from('\r\n', 'utf8'))],
  ['lenient gbk: cut last char', cat(gb('这本小说讲的是一个年轻医生在山村卫生院工作的故事。图书馆周末开放'), [0xca])],
  ['lenient gbk: one stray 0xFF', cat(gb('这本小说讲的是一个年轻医生在山村卫生院工作的故事。'), [0xff], gb('图书馆周末开放。\n'))],
  ['gbk + 16 NUL padding (DEC-3)', cat(gb('# 会议纪要\n\n周一上午九点在三楼会议室开项目例会，请大家提前十分钟到场。\n'), Buffer.alloc(16))],
];

const hexDiff = (a, b) => {
  if (a.equals(b)) return 'identical';
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `DIFFER at byte ${i}: ${a.subarray(i, i + 8).toString('hex')} → ${b.subarray(i, i + 8).toString('hex')} (len ${a.length} → ${b.length})`;
};
async function trip(mod, name, bytes, append) {
  const f = path.join(dir, `${mod === neu ? 'n' : 'o'}-${name.replace(/[^a-z0-9]+/gi, '_')}.md`);
  fs.writeFileSync(f, bytes);
  const store = mod.createFileMetaStore();
  let info;
  try { info = await mod.readFileInfo(f, store); } catch (e) { return { read: 'REFUSED: ' + e.message }; }
  const editorText = info.text.replace(/\r\n|\r/g, '\n') + (append ? 'x' : '');
  try { await mod.writeFileAtomic(f, editorText, store); } catch (e) { return { read: info.encoding, replaced: info.replacedBytes, write: 'SAVE ERROR: ' + e.message }; }
  const after = fs.readFileSync(f);
  const xb = info.encoding === 'utf-16le' ? Buffer.from([0x78, 0]) : info.encoding === 'utf-16be' ? Buffer.from([0, 0x78]) : Buffer.from('x');
  const expect = append ? Buffer.concat([bytes, xb]) : bytes;
  return { read: info.encoding, replaced: info.replacedBytes, write: hexDiff(expect, after) };
}
try {
  for (const [name, bytes] of CASES) {
    for (const append of [false, true]) {
      const o = await trip(old, name, bytes, append);
      const c = await trip(neu, name, bytes, append);
      const fmt = (x) => `${x.read}${x.replaced ? ' replaced=' + x.replaced : ''} → ${x.write || ''}`;
      console.log(`${(name + (append ? ' +x' : '')).padEnd(44)} | 0.1.0: ${fmt(o).padEnd(60)} | 0.2.0: ${fmt(c)}`);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
