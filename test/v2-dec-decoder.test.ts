// verify-decoder (0.2.0 stage 2a) — repro tests. Every case here FAILS on the 0.2.0 candidate and defines
// "fixed". Reference for "what 0.1.0 did": the frozen decoder test/fixtures/fileIO-0.1.0.mjs.
//   perl -e 'alarm 110; exec @ARGV' npx vitest run test/v2-dec-decoder.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as neu from '../electron/fileIO.mjs';
import * as old from './fixtures/fileIO-0.1.0.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Decoded = { text: string; encoding: string; bom: boolean; replaced?: number };
const decodeNew = (neu as any).decodeBuffer as (b: Buffer, overrides?: boolean) => Decoded;
// S4 (f): the default is overrides off (0.1.0's answer); every case also runs against the dormant
// overrides (passed explicitly), which these repros were written for.
const decodeOld = (old as any).decodeBuffer as (b: Buffer) => Decoded;
const enc1252 = (s: string): Buffer => {
  const t = (old as any).legacyEncoderTable('windows-1252') as Map<string, number[]>;
  return Buffer.from([...s].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : t.get(ch)![0])));
};
const encGbk = (s: string): Buffer => {
  const t = (old as any).legacyEncoderTable('gbk') as Map<string, number[]>;
  return Buffer.from([...s].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : t.get(ch)!)));
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-dec-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('DEC-1: windows-1252 Latin text that 0.1.0 read correctly is read as lenient GBK', () => {
  const cases = [
    'Não há solução. ORIENTAÇÕES GERAIS',
    'L’àvia té una cançó.',
    'ÄÖÜ GRÖSSE Größe, Maß, Füße, Öl.',
    'ÍSLENSKA ÞJÓÐIN\nÞjóðhátíð í Eyjum.',
    'AÑO NUEVO — ÉXITO\n¿Ésta es la canción? ¡Ánimo!',
  ];
  for (const s of cases) {
    it(JSON.stringify(s), () => {
      const b = enc1252(s);
      expect(decodeOld(b)).toMatchObject({ text: s, encoding: 'windows-1252' }); // 0.1.0: right
      expect(decodeNew(b)).toMatchObject({ text: s, encoding: 'windows-1252' }); // candidate: gbk + U+FFFD
      expect(decodeNew(b, true)).toMatchObject({ text: s, encoding: 'windows-1252' });
    });
  }
});

describe('DEC-3: clean GBK made of GBK-extension characters is overturned by windows-1252 / lenient UTF-8', () => {
  for (const s of ['堃 喆 昇\n', '責維護舊']) {
    it(JSON.stringify(s), () => {
      const b = encGbk(s);
      expect(decodeOld(b)).toMatchObject({ text: s, encoding: 'gbk' });
      expect(decodeNew(b)).toMatchObject({ text: s, encoding: 'gbk' });
      expect(decodeNew(b, true)).toMatchObject({ text: s, encoding: 'gbk' });
    });
  }
});

describe('DEC-2: an unmodified save rewrites bytes of a correctly detected Big5 / Shift_JIS file', () => {
  // 十 / 卅 as every Big5 encoder writes them (iconv BIG5, CP950, Python big5: A451 / A4CA)
  const big5 = Buffer.from('a451a4eba451a4e9ac4fb0eabc79a4e9a141bec7aed5a9f1b0b2a440a4d1a143a4caa67eab65aabaa6d1b7d3a4f9a141b04fbffda446a57eb143ae61aaf9a466a8bab4caba5fbef0a1430a', 'hex');
  it('big5 十月十日…卅年前… (iconv BIG5) round trip', async () => {
    const f = path.join(dir, 'big5.md');
    fs.writeFileSync(f, big5);
    const store = (neu as any).createFileMetaStore();
    const info = await (neu as any).readFileInfo(f, store);
    // S4 (f): overrides off in 0.2.0, so the file reads as 0.1.1 reads it (GBK); the save keeps every byte.
    expect(info.encoding).toBe((old as any).decodeBuffer(big5).encoding);
    await (neu as any).writeFileAtomic(f, info.text, store);
    expect(fs.readFileSync(f).toString('hex')).toBe(big5.toString('hex')); // candidate: a451 → a2cc, a4ca → a2ce
    // the dormant override (passed explicitly) reads Big5 and its save table gives the bytes back
    const r = (neu as any).decodeBuffer(big5, true);
    expect(r.encoding).toBe('big5');
    const table = (neu as any).saveTableOf(r.text, r.encoding, big5);
    expect((neu as any).encodeText(r.text, { encoding: r.encoding, bom: r.bom, eol: 'lf', ...(table ? { table } : {}) }).toString('hex')).toBe(big5.toString('hex'));
  });
  it('encoder table: 十 → A451, 卅 → A4CA (WHATWG Big5 encoder), ⅰ → FA40 (WHATWG Shift_JIS encoder)', () => {
    expect((neu as any).legacyEncoderTable('big5').get('十')).toEqual([0xa4, 0x51]);
    expect((neu as any).legacyEncoderTable('big5').get('卅')).toEqual([0xa4, 0xca]);
    expect((neu as any).legacyEncoderTable('shift_jis').get('ⅰ')).toEqual([0xfa, 0x40]);
  });
});

describe('DEC-4: a lenient GBK file cannot be saved the way warnReplaced says', () => {
  // Lead decision S4 (a) (docs/CONTRACT.md §11, 2026-11-20): no lenient GBK in 0.2.0. The cut GBK file
  // is read as 0.1.0 read it (no replacedBytes, so no warnReplaced dialog and nothing to contradict),
  // and a save keeps every byte. (Before S4 this case asserted replacedBytes = 1 and a U+FFFD save.)
  it('readFileInfo reports no replacedBytes (0.1.0 reading), then writeFileAtomic keeps every byte', async () => {
    const f = path.join(dir, 'cut.md');
    const bytes = Buffer.concat([encGbk('这本小说讲的是一个年轻医生在山村卫生院工作的故事。图书馆周末开放'), Buffer.from([0xca])]);
    fs.writeFileSync(f, bytes);
    const store = (neu as any).createFileMetaStore();
    const info = await (neu as any).readFileInfo(f, store);
    expect(info.replacedBytes).toBeUndefined();
    const o = decodeOld(bytes);
    expect({ encoding: info.encoding, text: info.text }).toEqual({ encoding: o.encoding, text: o.text });
    await expect((neu as any).writeFileAtomic(f, info.text + 'x', store)).resolves.toBeTruthy();
    expect(fs.readFileSync(f).toString('hex')).toBe(Buffer.concat([bytes, Buffer.from('x')]).toString('hex'));
  });
});

describe('DEC-5: a GBK file with NUL padding opens as an all-U+FFFD "UTF-8" document (0.1.0 refused it)', () => {
  it('GBK text + 16 NUL bytes', () => {
    const s = '# 会议纪要\n\n周一上午九点在三楼会议室开项目例会，请大家提前十分钟到场。\n';
    const b = Buffer.concat([encGbk(s), Buffer.alloc(16)]);
    expect(() => decodeOld(b)).toThrow();
    for (const ov of [undefined, true]) {
      let r: Decoded | null = null;
      try { r = decodeNew(b, ov); } catch { r = null; }
      // acceptable: refused, or the GBK text intact. Candidate: utf-8 with 41 replacements, no Han left.
      if (r) expect(r.text.startsWith(s)).toBe(true);
    }
  });
});

describe('DEC-6: a CP1250 (Czech / Slovak) file that 0.1.0 opened is refused', () => {
  it('ť = 0x9D, Ť = 0x8D: 0.1.0 opened it (windows-1252, byte-exact round trip), the candidate throws', () => {
    const b = Buffer.from('4368759d206aed646c612061209d6176612e208a9d6173746ee920726f6b21', 'hex'); // "Chuť jídla a ťava. Šťastné rok!" in CP1250
    expect(decodeOld(b).encoding).toBe('windows-1252');
    expect(() => decodeNew(b)).not.toThrow(); // candidate: 无法识别该文件的文本编码（可能是二进制文件）
    expect(() => decodeNew(b, true)).not.toThrow();
  });
});
