// fix-decoder (0.2.0 stage 2d) — regression tests for the lead's decisions S4 (f) and the amended
// S4 (e) (docs/CONTRACT.md §11, "Stage-2c review decisions"):
//   * S4 (f) (H7): DECODER_OVERRIDES is off; readFileInfo reads clean GBK whose characters are valid
//     UTF-8 pairs as GBK (no lenient UTF-8, no replacedBytes, so main never warns), and saves it as 0.1.1;
//   * S4 (e) amended (H23): saveTableOf gives the WHATWG table only when it gives the file's bytes back
//     and 0.1.0's table does not; otherwise 0.1.0's table — also when neither gives them back, also when
//     both do (characters typed later are then written as 0.1.1 writes them), and when the save
//     normalises the line endings (K10).
//   perl -e 'alarm 110; exec @ARGV' npx vitest run test/r3-d-default.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as neu from '../electron/fileIO.mjs';
import * as old from './fixtures/fileIO-0.1.0.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Decoded = { text: string; encoding: string; bom: boolean; replaced?: number };
const N = neu as any;
const O = old as any;
const H = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const A = (s: string) => Buffer.from(s, 'latin1');
const changed = (a: Buffer, b: Buffer) => {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
};
const gbkT = O.legacyEncoderTable('gbk') as Map<string, number[]>;
const encGbk = (s: string) => Buffer.from([...s].flatMap((c) => gbkT.get(c)!));
/** What a save writes, exactly as readFileInfo + writeFileAtomic do it (meta incl. saveTableOf). */
const saveNew = (b: Buffer, add = '') => {
  const d = N.decodeBuffer(b) as Decoded;
  const table = N.saveTableOf(d.text, d.encoding, b);
  return N.encodeText(d.text + add, { encoding: d.encoding, bom: d.bom, eol: N.eolOf(d.text), ...(table ? { table } : {}) }) as Buffer;
};
const saveOld = (b: Buffer, add = '') => {
  const d = O.decodeBuffer(b) as Decoded;
  return O.encodeText(d.text + add, { encoding: d.encoding, bom: d.bom, eol: O.eolOf(d.text) }) as Buffer;
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-d-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('S4 (f): the decoder overrides are off', () => {
  it('DECODER_OVERRIDES is false and the default answer is the frozen 0.1.0 decoder\'s', () => {
    expect(N.DECODER_OVERRIDES).toBe(false);
    for (const b of [H('efbbbf41'), H('fffe4100'), A('plain\n'), encGbk('中文'), H('ff41'), Buffer.from('ab', 'utf16le'), Buffer.alloc(8)]) {
      let want: unknown;
      let got: unknown;
      try { want = O.decodeBuffer(b); } catch (e) { want = (e as Error).message; }
      try { got = N.decodeBuffer(b); } catch (e) { got = (e as Error).message; }
      expect(got).toEqual(want);
    }
  });
  it('H7: a GBK timesheet of 小时 rows opens as GBK through readFileInfo (no replacedBytes) and saves original + x', async () => {
    const sheet = '# 工时\n\n| 日期 | 时长 |\n|---|---|\n' + Array.from({ length: 20 }, (_, i) => `| 11-${String(i + 1).padStart(2, '0')} | ${8 + (i % 3)}小时 |`).join('\n') + '\n';
    const bytes = encGbk(sheet);
    const p = path.join(dir, 'sheet.md');
    fs.writeFileSync(p, bytes);
    const store = N.createFileMetaStore();
    const info = await N.readFileInfo(p, store);
    expect({ encoding: info.encoding, text: info.text, replaced: 'replacedBytes' in info }).toEqual({ encoding: 'gbk', text: sheet, replaced: false });
    await N.writeFileAtomic(p, `${info.text}x`, store);
    expect(fs.readFileSync(p).equals(Buffer.concat([bytes, A('x')]))).toBe(true);
  });
});

describe('S4 (e) amended (H23): the save table', () => {
  it('neither table gives the bytes back (NEC-style Shift_JIS): 0.1.0\'s table, the save changes what 0.1.1 changes', () => {
    const parts: Buffer[] = [];
    for (let i = 0; i < 10; i++) parts.push(A('- '), H('eeef'), A(' item\n'));
    parts.push(A('x '), H('8790'), A(' y '), H('b1'), A('\n'));
    const b = Buffer.concat(parts);
    const d = N.decodeBuffer(b);
    expect(d.encoding).toBe('shift_jis');
    expect(N.saveTableOf(d.text, d.encoding, b)).toBe('0.1.0');
    expect(saveNew(b).equals(saveOld(b))).toBe(true);
    expect(changed(saveNew(b, 'x'), Buffer.concat([b, A('x')]))).toBe(2);
  });
  it('both tables give the bytes back (half-width katakana Shift_JIS): 0.1.0\'s table, so a typed ⅰ is EEEF as in 0.1.1', () => {
    const b = Buffer.concat([A('1,'), H('c3deb0c0'), A(',100\n2,'), H('b6deb2c4de'), A('\n')]);
    const d = N.decodeBuffer(b);
    expect(d.encoding).toBe('shift_jis');
    expect(N.saveTableOf(d.text, d.encoding, b)).toBe('0.1.0');
    expect(saveNew(b).equals(b)).toBe(true);
    for (const add of ['ⅰ', '≒', '十x']) expect(saveNew(b, add).toString('hex')).toBe(saveOld(b, add).toString('hex'));
  });
  it('only the WHATWG table gives the bytes back: WHATWG, the save keeps every byte (0.1.1 respells 2)', () => {
    const b = H('d1fae5'); // windows-1251 text that 0.1.0 reads as Shift_JIS; FAE5 is an IBM extension character
    const d = N.decodeBuffer(b);
    expect(d.encoding).toBe('shift_jis');
    expect(N.saveTableOf(d.text, d.encoding, b)).toBeUndefined();
    expect(saveNew(b).equals(b)).toBe(true);
    expect(changed(saveOld(b), b)).toBe(2);
  });
  it('only WHATWG gives the raw text back but the save normalises mixed line endings (K10): 0.1.0\'s table, same bytes as 0.1.1', () => {
    const b = Buffer.concat([H('d1fae5'), A('\r\nab\nc\r\n')]);
    const d = N.decodeBuffer(b);
    expect(d.encoding).toBe('shift_jis');
    expect(N.saveTableOf(d.text, d.encoding, b)).toBe('0.1.0');
    expect(saveNew(b).equals(saveOld(b))).toBe(true);
    expect(saveNew(b, 'x').equals(saveOld(b, 'x'))).toBe(true);
  });
  it('a Big5 file saved with the WHATWG table: a typed character only 0.1.0\'s table has (HKSCS rows) is written as 0.1.1 writes it, not refused', () => {
    const w = N.legacyEncoderTable('big5') as Map<string, number[]>;
    const t010 = O.legacyEncoderTable('big5') as Map<string, number[]>;
    const missing = [...t010.keys()].filter((k) => !w.has(k));
    expect(missing.length).toBeGreaterThan(0); // Node: 5024, Electron 44: 2415 (different ICU data)
    for (const ch of missing.slice(0, 50)) {
      expect(N.encodeText(`十${ch}\n`, { encoding: 'big5', eol: 'lf' }).toString('hex')).toBe(`a451${Buffer.from(t010.get(ch)!).toString('hex')}0a`);
    }
  });
  it('readFileInfo stores the table and writeFileAtomic uses it (NEC-style file: 2 bytes respelled, as 0.1.1)', async () => {
    const b = Buffer.concat([A('- '), H('eeef'), A(' a '), H('8790'), A(' '), H('b1'), A('\n')]);
    const p = path.join(dir, 'nec.md');
    const q = path.join(dir, 'nec-010.md');
    fs.writeFileSync(p, b);
    fs.writeFileSync(q, b);
    const store = N.createFileMetaStore();
    const info = await N.readFileInfo(p, store);
    expect(store.get(fs.realpathSync(p)).table).toBe('0.1.0');
    await N.writeFileAtomic(p, `${info.text}x`, store);
    const sO = O.createFileMetaStore();
    const iO = await O.readFileInfo(q, sO);
    await O.writeFileAtomic(q, `${iO.text}x`, sO);
    expect(fs.readFileSync(p).toString('hex')).toBe(fs.readFileSync(q).toString('hex'));
  });
});
