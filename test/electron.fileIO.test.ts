// electron/fileIO.mjs — everything an open → ⌘S round trip must not destroy (CONTRACT §10, fix round 2).
// Plain Node: no Electron, no DOM. The temp directory is real because symlinks, hard links, inodes
// and mtimes are the whole point.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFLICT_MESSAGE,
  UNDECODABLE_MESSAGE,
  adoptSaveTarget,
  applyEol,
  createFileMetaStore,
  decodeBuffer,
  encodeText,
  eolOf,
  readFileInfo,
  writeFileAtomic,
} from '../electron/fileIO.mjs';

let tmp: string;
beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdr-fileio-'));
});
afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const file = (name: string): string => path.join(tmp, name);
/** "# 中文标题\n\n内容\n" in GBK — invalid UTF-8. */
const GBK_BYTES = Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2, 0x0a, 0x0a, 0xc4, 0xda, 0xc8, 0xdd, 0x0a]);

describe('decodeBuffer', () => {
  it('decodes plain UTF-8', () => {
    const r = decodeBuffer(Buffer.from('# 标题\n正文 😀\n', 'utf8'));
    expect(r).toEqual({ text: '# 标题\n正文 😀\n', encoding: 'utf-8', bom: false });
  });

  it('strips a UTF-8 BOM and remembers it', () => {
    const r = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\n', 'utf8')]));
    expect(r.text).toBe('# 标题\n');
    expect(r.bom).toBe(true);
    expect(r.encoding).toBe('utf-8');
  });

  it('decodes GBK instead of producing U+FFFD', () => {
    const r = decodeBuffer(GBK_BYTES);
    expect(r.encoding).toBe('gbk');
    expect(r.text).toBe('# 中文标题\n\n内容\n');
    expect(r.text).not.toContain('�');
  });

  it('decodes UTF-16 with either BOM', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 标题\n', 'utf16le')]);
    expect(decodeBuffer(le)).toMatchObject({ text: '# 标题\n', encoding: 'utf-16le', bom: true });
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('# 标题\n', 'utf16le').swap16()]);
    expect(decodeBuffer(be)).toMatchObject({ text: '# 标题\n', encoding: 'utf-16be', bom: true });
  });

  it('refuses binary instead of guessing', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x03, 0x7f, 0x00]);
    expect(() => decodeBuffer(binary)).toThrowError(UNDECODABLE_MESSAGE);
  });
});

describe('encodeText', () => {
  it('round-trips GBK', () => {
    const { text, encoding } = decodeBuffer(GBK_BYTES);
    expect(encodeText(text, { encoding, eol: 'lf' }).equals(GBK_BYTES)).toBe(true);
  });

  it('refuses a character the legacy encoding cannot represent', () => {
    expect(() => encodeText('😀', { encoding: 'gbk', eol: 'lf' })).toThrowError(/无法表示的字符/);
  });

  it('re-attaches a BOM only when the file had one', () => {
    expect(encodeText('x', { encoding: 'utf-8', bom: true })[0]).toBe(0xef);
    expect(encodeText('x', { encoding: 'utf-8', bom: false })[0]).toBe(0x78);
  });

  it('applies the file line ending to the editor text', () => {
    expect(applyEol('a\nb\n', 'crlf')).toBe('a\r\nb\r\n');
    expect(applyEol('a\r\nb\r\n', 'crlf')).toBe('a\r\nb\r\n'); // idempotent, never doubled
    expect(applyEol('a\r\nb\n', 'lf')).toBe('a\nb\n');
    expect(eolOf('a\r\nb')).toBe('crlf');
    expect(eolOf('a\nb')).toBe('lf');
  });
});

describe('readFileInfo / writeFileAtomic', () => {
  it('keeps a CRLF file CRLF even though the editor text is LF', async () => {
    const store = createFileMetaStore();
    const p = file('crlf.md');
    await fsp.writeFile(p, '# CRLF\r\n\r\n一行。\r\n', 'utf8');
    const info = await readFileInfo(p, store);
    expect(info.text).toBe('# CRLF\r\n\r\n一行。\r\n');
    // What CodeMirror hands back: LF only.
    await writeFileAtomic(p, '# CRLF\n\n一行。\n改过\n', store);
    expect(await fsp.readFile(p, 'utf8')).toBe('# CRLF\r\n\r\n一行。\r\n改过\r\n');
  });

  it('writes a GBK file back as GBK', async () => {
    const store = createFileMetaStore();
    const p = file('gbk.md');
    await fsp.writeFile(p, GBK_BYTES);
    const info = await readFileInfo(p, store);
    expect(info.text).toBe('# 中文标题\n\n内容\n');
    expect((info as { encoding?: string }).encoding).toBe('gbk');
    await writeFileAtomic(p, '# 中文标题\n\n内容改了\n', store);
    const after = await fsp.readFile(p);
    expect(after.includes(0xd6)).toBe(true); // still GBK bytes, not UTF-8
    expect(decodeBuffer(after).text).toBe('# 中文标题\n\n内容改了\n');
  });

  it('follows a symlink instead of replacing it', async () => {
    const store = createFileMetaStore();
    const target = file('link-target.md');
    const link = file('link.md');
    await fsp.writeFile(target, '原始\n', 'utf8');
    await fsp.symlink(target, link);
    await readFileInfo(link, store);
    await writeFileAtomic(link, '改过\n', store);
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fsp.readFile(target, 'utf8')).toBe('改过\n');
  });

  it('keeps hard links joined (same inode after a save)', async () => {
    const store = createFileMetaStore();
    const a = file('hardA.md');
    const b = file('hardB.md');
    await fsp.writeFile(a, '原始\n', 'utf8');
    await fsp.link(a, b);
    const ino = (await fsp.stat(a)).ino;
    await readFileInfo(a, store);
    await writeFileAtomic(a, '改过\n', store);
    expect((await fsp.stat(a)).ino).toBe(ino);
    expect(await fsp.readFile(b, 'utf8')).toBe('改过\n');
    // and the shorter content really truncated the file
    expect((await fsp.stat(a)).size).toBe(Buffer.byteLength('改过\n'));
  });

  it('refuses to overwrite a file another program changed, then lets an explicit retry through', async () => {
    const store = createFileMetaStore();
    const p = file('race.md');
    await fsp.writeFile(p, '我的版本\n', 'utf8');
    await readFileInfo(p, store);
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(p, '别的程序写入的版本\n', 'utf8');
    await expect(writeFileAtomic(p, '我的版本改过\n', store)).rejects.toThrowError(CONFLICT_MESSAGE);
    expect(await fsp.readFile(p, 'utf8')).toBe('别的程序写入的版本\n'); // untouched
    // 覆盖保存 = ask once more
    await writeFileAtomic(p, '我的版本改过\n', store);
    expect(await fsp.readFile(p, 'utf8')).toBe('我的版本改过\n');
  });

  it('does not report a conflict for a file it wrote itself', async () => {
    const store = createFileMetaStore();
    const p = file('mine.md');
    await fsp.writeFile(p, 'a\n', 'utf8');
    await readFileInfo(p, store);
    for (let i = 0; i < 3; i++) await writeFileAtomic(p, `a${i}\n`, store);
    expect(await fsp.readFile(p, 'utf8')).toBe('a2\n');
  });

  it('recreates a file that was deleted while it was open', async () => {
    const store = createFileMetaStore();
    const p = file('gone.md');
    await fsp.writeFile(p, 'a\n', 'utf8');
    await readFileInfo(p, store);
    await fsp.rm(p);
    await writeFileAtomic(p, 'b\n', store);
    expect(await fsp.readFile(p, 'utf8')).toBe('b\n');
  });

  it('leaves no temp file behind when the write fails', async () => {
    const store = createFileMetaStore();
    const dir = file('ro');
    await fsp.mkdir(dir);
    const p = path.join(dir, 'x.md');
    await fsp.writeFile(p, 'a\n', 'utf8');
    await readFileInfo(p, store);
    await fsp.chmod(dir, 0o555);
    await expect(writeFileAtomic(p, 'b\n', store)).rejects.toThrow();
    await fsp.chmod(dir, 0o755);
    expect(await fsp.readdir(dir)).toEqual(['x.md']);
    expect(await fsp.readFile(p, 'utf8')).toBe('a\n');
  });

  it('reports a directory as EISDIR', async () => {
    const dir = file('adir');
    await fsp.mkdir(dir, { recursive: true });
    await expect(readFileInfo(dir, createFileMetaStore())).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('carries the line endings over to a 另存为 target and drops the old encoding', async () => {
    const store = createFileMetaStore();
    const src = file('win.md');
    const dst = file('win-copy.md');
    await fsp.writeFile(src, GBK_BYTES);
    await fsp.writeFile(src, '# CRLF\r\n', 'utf8');
    await readFileInfo(src, store);
    await adoptSaveTarget(dst, src, store);
    await writeFileAtomic(dst, '# CRLF\n二\n', store);
    expect(await fsp.readFile(dst, 'utf8')).toBe('# CRLF\r\n二\r\n');
  });
});

describe('createFileMetaStore', () => {
  it('is bounded and keeps the most recently used entries', () => {
    const store = createFileMetaStore(3);
    store.set('a', { eol: 'lf' });
    store.set('b', { eol: 'lf' });
    store.set('c', { eol: 'lf' });
    store.get('a');            // refresh a
    store.set('d', { eol: 'lf' });
    expect(store.size).toBe(3);
    expect(store.get('b')).toBeUndefined(); // oldest untouched entry evicted
    expect(store.get('a')).toBeDefined();
    expect(store.get('d')).toBeDefined();
  });
});

// ---------------------------------------------------------------- follow-up pass (2026-11-20)
// Legacy samples come from /usr/bin/iconv (authoritative tables), as bench/electron/hunt-files-corpus.mjs.
import { execFileSync, spawnSync } from 'node:child_process';
import { NOT_REGULAR_MESSAGE, scoreLegacy } from '../electron/fileIO.mjs';
// S4 (f) (H7): 0.2.0 ships with DECODER_OVERRIDES off, so by default every reading below is the frozen
// 0.1.0 decoder's. The override cases keep testing the dormant code with `decodeBuffer(buf, true)`;
// each of them also asserts the default against the fixture.
import * as old010 from './fixtures/fileIO-0.1.0.mjs';
/* eslint-disable @typescript-eslint/no-explicit-any */
const asOld = (b: Buffer) => (old010 as any).decodeBuffer(b);

const iconv = (text: string, to: string): Buffer =>
  execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(text, 'utf8') });

const ZH = '# 标题\n\n这是一个中文文档，包含一些内容。第二句话在这里。\n\n- 列表项一\n- 列表项二\n';
const ZH2 = '# 会议纪要\n\n今天讨论了下季度的预算和招聘计划。负责人需要在周五之前提交报告，并说明风险。\n';
const HANT = '# 標題\n\n這是一個繁體中文文件，包含一些內容。第二句話在這裡。\n\n- 清單項目一\n- 清單項目二\n';
const HANT2 = '# 會議紀錄\n\n今天討論了下一季的預算與招聘計畫。負責人需要在週五之前提交報告，並說明風險。\n';
const JA = '# 見出し\n\nこれは日本語の文書です。内容があります。二番目の文です。\n\n- 項目一\n- 項目二\n';
const JA2 = '# 議事録\n\n本日は次の四半期の予算と採用計画について話し合いました。担当者は金曜日までに報告書を提出してください。\n';
const KO = '# 제목\n\n이것은 한국어 문서입니다. 내용이 있습니다. 두 번째 문장입니다.\n\n- 항목 하나\n- 항목 둘\n';
const KO2 = '# 회의록\n\n오늘 회의에서는 다음 분기 예산과 채용 계획을 논의했습니다. 담당자는 금요일까지 보고서를 제출해야 합니다.\n';
const LATIN_TRAP = '# Zürich\n\nÜber élan façade Zürich Mädchen\n';
const CP1252 = '# Quotes\n\n“Hello” – it’s €5.\n';

describe('decodeBuffer — scored legacy detection (Big5 / Shift_JIS / EUC-KR are not GBK)', () => {
  const cases: Array<[string, string, string]> = [
    ['gbk', ZH, 'GBK'],
    ['gbk', ZH2, 'GBK'],
    ['big5', HANT, 'BIG5'],
    ['big5', HANT2, 'BIG5'],
    ['shift_jis', JA, 'SHIFT_JIS'],
    ['shift_jis', JA2, 'SHIFT_JIS'],
    ['euc-kr', KO, 'EUC-KR'],
    ['euc-kr', KO2, 'EUC-KR'],
  ];
  for (const [label, text, charset] of cases) {
    it(`reads ${charset} as ${label}: ${JSON.stringify(text.slice(0, 12))}`, () => {
      expect(decodeBuffer(iconv(text, charset))).toEqual(asOld(iconv(text, charset))); // default: 0.1.0
      const r = decodeBuffer(iconv(text, charset), true);
      expect(r.encoding).toBe(label);
      expect(r.text).toBe(text);
    });
  }
  // Lead decision S4 (c) / G24 (2026-11-20): windows-1252 never replaces 0.1.0's answer. These two
  // short Latin texts are clean GBK / EUC-KR, which 0.1.0 answered; they used to assert windows-1252
  // (the stage-1 "4 high bytes" rule, which also overturned genuine GBK such as 「堃 喆 昇」).
  for (const [text, charset, legacy] of [[LATIN_TRAP, 'ISO-8859-1', 'gbk'], [CP1252, 'CP1252', 'euc-kr']] as const) {
    it(`${charset} text that is clean ${legacy.toUpperCase()} keeps 0.1.0's answer: ${JSON.stringify(text.slice(0, 12))}`, () => {
      const bytes = iconv(text, charset);
      const r = decodeBuffer(bytes);
      expect(r.encoding).toBe(legacy);
      expect(encodeText(r.text, { encoding: r.encoding, eol: 'lf' }).equals(bytes)).toBe(true); // a save keeps every byte
    });
  }
  it('windows-1252 text that is not clean CJK reads as windows-1252 (0.1.0)', () => {
    const text = '# Café\n\nLe café est fermé. Ça va ? Très bien, merci.\n';
    expect(decodeBuffer(iconv(text, 'CP1252'))).toMatchObject({ encoding: 'windows-1252', text });
  });

  it('Big5 bytes that are also clean GBK score far lower as GBK', () => {
    const buf = iconv(HANT, 'BIG5');
    const asGbk = new TextDecoder('gbk', { fatal: true }).decode(buf); // decodes cleanly — the old trap
    expect(scoreLegacy(asGbk, 'gbk')).toBeLessThan(scoreLegacy(new TextDecoder('big5').decode(buf), 'big5') / 2);
  });

  it('an edit to a Big5 file: by default read and saved exactly as 0.1.1 does (S4 (f)); with the overrides, saved as Big5', async () => {
    const store = createFileMetaStore();
    const p = file('big5.md');
    await fsp.writeFile(p, iconv(HANT, 'BIG5'));
    const info = await readFileInfo(p, store);
    const o = asOld(iconv(HANT, 'BIG5'));
    expect({ text: info.text, encoding: info.encoding }).toEqual({ text: o.text, encoding: o.encoding });
    await writeFileAtomic(p, `${info.text}新增\n`, store);
    const want = (old010 as any).encodeText(`${o.text}新增\n`, { encoding: o.encoding, bom: o.bom, eol: eolOf(o.text) });
    expect((await fsp.readFile(p)).equals(want)).toBe(true);
    // the dormant override (S4 (f)): Big5, and an edit encodes as Big5
    const r = decodeBuffer(iconv(HANT, 'BIG5'), true);
    expect(r).toMatchObject({ text: HANT, encoding: 'big5' });
    const saved = encodeText(`${HANT}新增\n`, { encoding: r.encoding, bom: r.bom, eol: 'lf' });
    expect(new TextDecoder('big5', { fatal: true }).decode(saved)).toBe(`${HANT}新增\n`);
  });

  it('GB18030 four-byte sequences still read as gbk', () => {
    const text = `${ZH}\n扩展字 㐀 与 ㈠ 符号\n`;
    expect(decodeBuffer(iconv(text, 'GB18030'))).toMatchObject({ encoding: 'gbk', text });
  });
});

describe('decodeBuffer — almost-UTF-8 stays UTF-8', () => {
  const good = Buffer.from(ZH, 'utf8');
  it('a file cut off inside its last character: UTF-8 with one U+FFFD', () => {
    const cut = Buffer.concat([good, Buffer.from([0xe4, 0xb8])]);
    expect(decodeBuffer(cut)).toEqual(asOld(cut)); // default: 0.1.0 (S4 (f), K11 lapses)
    const r = decodeBuffer(cut, true);
    expect(r).toMatchObject({ encoding: 'utf-8', text: `${ZH}�`, replaced: 1 });
  });
  it('one stray 0xFF or 0x80 byte: UTF-8, not windows-1252 / GBK garbage', () => {
    for (const bad of [0xff, 0x80]) {
      const at = bad === 0xff ? 20 : 30;
      const damaged = Buffer.concat([good.subarray(0, at), Buffer.from([bad]), good.subarray(at)]);
      expect(decodeBuffer(damaged)).toEqual(asOld(damaged)); // default: 0.1.0 (S4 (f))
      const r = decodeBuffer(damaged, true);
      expect(r.encoding).toBe('utf-8');
      expect(r.replaced).toBeGreaterThan(0);
      expect(r.text).toContain('包含一些内容。第二句话在这里。');
      expect(r.text.length).toBeLessThan(ZH.length + 5);
    }
  });
  it('a genuine U+FFFD in valid UTF-8 is not "replaced"', () => {
    expect(decodeBuffer(Buffer.from('a�b\n', 'utf8'))).toEqual({ text: 'a�b\n', encoding: 'utf-8', bom: false });
  });
  it('a GBK file is not taken for damaged UTF-8', () => {
    expect(decodeBuffer(iconv(ZH2, 'GBK')).encoding).toBe('gbk');
  });
  it('readFileInfo: by default no replacement count, 0.1.0\'s reading (S4 (f): K11 lapses, main never warns)', async () => {
    const p = file('trunc.md');
    const cut = Buffer.concat([good, Buffer.from([0xe4, 0xb8])]);
    await fsp.writeFile(p, cut);
    const info = await readFileInfo(p, createFileMetaStore());
    expect({ text: info.text, encoding: info.encoding }).toEqual({ text: asOld(cut).text, encoding: asOld(cut).encoding });
    expect('replacedBytes' in info).toBe(false);
    expect(decodeBuffer(cut, true)).toMatchObject({ encoding: 'utf-8', replaced: 1 }); // the dormant override 3
    const clean = file('clean.md');
    await fsp.writeFile(clean, ZH, 'utf8');
    expect('replacedBytes' in (await readFileInfo(clean, createFileMetaStore()))).toBe(false);
  });
});

describe('decodeBuffer — BOM-less UTF-16 and binary', () => {
  const BASIC = '# Hello\n\nSome **bold** text and a [link](https://example.com).\n\n1. one\n2. two\n';
  for (const [name, text] of [['ASCII', BASIC], ['Chinese (with 一 = U+4E00)', ZH]] as const) {
    it(`detects UTF-16LE / BE without BOM: ${name}`, () => {
      for (const b of [Buffer.from(text, 'utf16le'), Buffer.from(text, 'utf16le').swap16()]) {
        let want: unknown;
        try { want = asOld(b); } catch (e) { want = (e as Error).message; }
        let got: unknown;
        try { got = decodeBuffer(b); } catch (e) { got = (e as Error).message; }
        expect(got).toEqual(want); // default: 0.1.0 (S4 (f))
      }
      expect(decodeBuffer(Buffer.from(text, 'utf16le'), true)).toEqual({ text, encoding: 'utf-16le', bom: false });
      expect(decodeBuffer(Buffer.from(text, 'utf16le').swap16(), true)).toEqual({ text, encoding: 'utf-16be', bom: false });
    });
  }
  it('round-trips BOM-less UTF-16LE without adding a BOM', () => {
    const buf = Buffer.from(ZH, 'utf16le');
    const { text, encoding, bom } = decodeBuffer(buf, true); // the dormant override 1 (S4 (f))
    expect(encodeText(text, { encoding, bom, eol: 'lf' }).equals(buf)).toBe(true);
  });
  it('refuses valid-UTF-8 bytes that are mostly control characters (binary / UTF-32) — the dormant override 2; by default opened as 0.1.0 did', () => {
    for (const b of [Buffer.from([0x01, 0x02, 0x03, 0x41, 0x04, 0x05, 0x06, 0x42]), Buffer.alloc(64, 0)]) {
      expect(decodeBuffer(b)).toEqual(asOld(b)); // default (S4 (f))
      expect(() => decodeBuffer(b, true)).toThrowError(UNDECODABLE_MESSAGE);
    }
  });
  it('keeps a UTF-8 text with one stray ESC (terminal output pasted into a note)', () => {
    const text = `# log\n\n${'正常的一行文字。\n'.repeat(10)}\u001b[0m done\n`;
    expect(decodeBuffer(Buffer.from(text, 'utf8')).text).toBe(text);
  });
  // Regression (fix:round2, 2026-11-20): the hotfix draft refused strict UTF-8 with > 2 % control
  // characters, so these opened as an empty 未命名.md. 0.1.0 opened all of them.
  const ESC = '\u001b';
  const strictUtf8Texts: [string, string][] = [
    ['an ANSI-coloured terminal log in a code fence (ESC ≈ 7 %)', `# 测试日志\n\n\`\`\`\n${Array.from({ length: 30 }, (_, i) =>
      `${ESC}[32m✓${ESC}[0m test case ${i} passes ${ESC}[2m(${i} ms)${ESC}[0m`).join('\n')}\n\`\`\`\n`],
    ['form feeds between 30 sections', Array.from({ length: 30 }, (_, i) => `## S${i}\n\nok\n\f`).join('\n')],
    ['a short file that is mostly page breaks (22 chars)', '\f# a\n\f\fb\n\f\f\f\fc\n\f\f\fd\f\n\f'],
    ['a short text with two BEL characters', '# t\n\nding\u0007\u0007\n'],
    ['backspaces and vertical tabs (typewriter-style overstrike)', 'b\bbo\bol\bld\u000b\u000bend\n'],
    ['a few NULs in a short file (32 chars)', '# NUL\n\nbefore\u0000after\n\nmore\u0000\u0000text\n'],
  ];
  for (const [name, text] of strictUtf8Texts) {
    it(`opens strictly valid UTF-8 with control characters: ${name}`, () => {
      expect(decodeBuffer(Buffer.from(text, 'utf8'))).toEqual({ text, encoding: 'utf-8', bom: false });
    });
  }
  it('still refuses valid UTF-8 that is mostly hard control characters (UTF-32 text, zero-filled) — dormant override 2; default as 0.1.0', () => {
    for (const b of [Buffer.from('A\0\0\0B\0\0\0C\0\0\0D\0\0\0', 'latin1'), Buffer.from([0x7f, 0x01, 0x02, 0x10, 0x11, 0x41, 0x0a])]) {
      expect(decodeBuffer(b)).toEqual(asOld(b)); // default (S4 (f))
      expect(() => decodeBuffer(b, true)).toThrowError(UNDECODABLE_MESSAGE);
    }
  });
  it('BOM-less UTF-16 with ANSI colour codes is still read as UTF-16', () => {
    const text = `# log\n\n${ESC}[31merror${ESC}[0m one\n${ESC}[32mok${ESC}[0m two\n`;
    expect(decodeBuffer(Buffer.from(text, 'utf16le'))).toEqual(asOld(Buffer.from(text, 'utf16le'))); // default (S4 (f))
    expect(decodeBuffer(Buffer.from(text, 'utf16le'), true)).toEqual({ text, encoding: 'utf-16le', bom: false });
  });
});

describe('readFileInfo — non-regular files', () => {
  it('refuses a FIFO at once instead of blocking forever', async () => {
    const fifo = file('pipe.md');
    expect(spawnSync('/usr/bin/mkfifo', [fifo]).status).toBe(0);
    const t0 = Date.now();
    await expect(readFileInfo(fifo, createFileMetaStore())).rejects.toMatchObject({ code: 'EIO', message: NOT_REGULAR_MESSAGE });
    expect(Date.now() - t0).toBeLessThan(1000);
    // and the next ordinary file still opens
    const after = file('after-fifo.md');
    await fsp.writeFile(after, ZH, 'utf8');
    expect((await readFileInfo(after, createFileMetaStore())).text).toBe(ZH);
  });
});
