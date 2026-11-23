// fix-decoder (0.2.0 stage 2b) — regression tests for decision S4 (docs/CONTRACT.md §11, 2026-11-20)
// beyond the verifier's test/v2-dec-decoder.test.ts and the differential:
//   * G24: the "another clean CJK label" override needs a reading that looks like its language
//     (MIN_TOP_SHARE; kana for Shift_JIS) — GBK-extension text that the score alone gave away stays GBK;
//   * G23 follow-up: a file whose label is 0.1.0's own answer keeps 0.1.0's bytes on save when only
//     0.1.0's table gives them back (saveTableOf), while override-chosen Big5 uses the WHATWG table;
//   * S4 (c): the switch (DECODER_OVERRIDES / decodeBuffer(buf, false)) is 0.1.0, and the 0.1.0 table
//     is still available (legacyEncoderTable(label, false) = the fixture's table);
//   * the "What nobody covered" checks: binaries are refused, a UTF-8 file with one GBK paragraph is
//     never read as lenient GBK.
//   perl -e 'alarm 110; exec @ARGV' npx vitest run test/fix2-d-decoder.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as neu from '../electron/fileIO.mjs';
import * as old from './fixtures/fileIO-0.1.0.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Decoded = { text: string; encoding: string; bom: boolean; replaced?: number };
const N = neu as any;
const O = old as any;
const decodeNew = N.decodeBuffer as (b: Buffer, overrides?: boolean) => Decoded;
const decodeOld = O.decodeBuffer as (b: Buffer) => Decoded;
const iconv = (text: string, to: string): Buffer =>
  execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(text, 'utf8') });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix2-d-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const nonAscii = (s: string) => [...s].filter((c) => c.codePointAt(0)! >= 0x80).length;

describe('G24: GBK-extension text is not given to Shift_JIS / Big5 on the score alone', () => {
  // First failures of PART=gbkpools node bench/verify/v2-dec-thresholds.mjs before the language rule.
  const cases: Array<[string, string, string]> = [
    ['gbk3 run, 20 characters → was shift_jis', '9fc492e19dd483ab91bb948f8d648a68928590908c769ff09ad48bf4985390f28ac4817c9af48d6b', 'shift_jis'],
    ['name characters, 21 → was shift_jis', '88d6954e88d28faa9546ac8ce5b888d2ac42ac42da53b574da53ac509550ac8c8890ac429550f6cef6ce', 'shift_jis'],
    ['gbk4 spaced, 19 → was big5', 'da6d20cc79a3bae27c2c20f04b0a2d20ae642c20fb64207c20e9792c20c3520a2d20e8442c20b564207c20f5582c20c54b20f65f0a2d20ae600a2d20c2690a2d20de5d0a2d20c5680a2d20f76f0a2d20fa69', 'big5'],
  ];
  for (const [name, hex, rival] of cases) {
    it(name, () => {
      const b = Buffer.from(hex, 'hex');
      const o = decodeOld(b);
      expect(o.encoding).toBe('gbk');
      // the case still exercises the rule: the rival decodes cleanly with ≥ 20 characters and wins the
      // score by ≥ 0.2 — only the language test keeps 0.1.0's answer
      const r = new TextDecoder(rival, { fatal: true }).decode(b);
      expect(nonAscii(r)).toBeGreaterThanOrEqual(20);
      expect(N.scoreLegacy(r, rival)).toBeGreaterThanOrEqual(N.scoreLegacy(o.text, 'gbk') + 0.2);
      expect(decodeNew(b)).toEqual({ text: o.text, encoding: 'gbk', bom: false }); // default (S4 (f): overrides off)
      expect(decodeNew(b, true)).toEqual({ text: o.text, encoding: 'gbk', bom: false }); // the dormant override 4
    });
  }
  it('genuine Japanese (kana) and Traditional Chinese still read as Shift_JIS / Big5', () => {
    const ja = '# 議事録\n\n本日は次の四半期の予算と採用計画について話し合いました。担当者は金曜日までに報告書を提出してください。\n';
    const hant = '# 會議紀錄\n\n今天討論了下一季的預算與招聘計畫。負責人需要在週五之前提交報告，並說明風險。\n';
    // S4 (f): the overrides are off in 0.2.0; the default is 0.1.0's answer, the override is dormant.
    for (const b of [iconv(ja, 'SHIFT_JIS'), iconv(hant, 'BIG5')]) expect(decodeNew(b)).toEqual(decodeOld(b));
    expect(decodeNew(iconv(ja, 'SHIFT_JIS'), true)).toEqual({ text: ja, encoding: 'shift_jis', bom: false });
    expect(decodeNew(iconv(hant, 'BIG5'), true)).toEqual({ text: hant, encoding: 'big5', bom: false });
  });
});

describe('G23: the save table', () => {
  it('legacyEncoderTable(label, false) is 0.1.0\'s table; the default differs only for Big5 / Shift_JIS', () => {
    for (const label of ['gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
      const t010 = N.legacyEncoderTable(label, false) as Map<string, number[]>;
      const fixture = O.legacyEncoderTable(label) as Map<string, number[]>;
      expect([...t010].map(([k, v]) => `${k}:${v.join()}`)).toEqual([...fixture].map(([k, v]) => `${k}:${v.join()}`));
      const same = [...(N.legacyEncoderTable(label) as Map<string, number[]>)].every(([k, v]) => fixture.get(k)?.join() === v.join());
      expect(same).toBe(label !== 'big5' && label !== 'shift_jis');
    }
  });
  it('windows-1251 text that 0.1.0 reads as Shift_JIS (EE F1 = NEC-selected IBM ⅲ) saves its own bytes', async () => {
    const bytes = Buffer.from('cceef10a', 'hex'); // "Мос\n" in CP1251
    const o = decodeOld(bytes);
    expect(o.encoding).toBe('shift_jis');
    expect(decodeNew(bytes)).toEqual(o);
    expect(N.saveTableOf(o.text, o.encoding, bytes)).toBe('0.1.0');
    const f = path.join(dir, 'ru.md');
    fs.writeFileSync(f, bytes);
    const store = N.createFileMetaStore();
    const info = await N.readFileInfo(f, store);
    await N.writeFileAtomic(f, info.text, store);
    expect(fs.readFileSync(f).toString('hex')).toBe(bytes.toString('hex')); // WHATWG would write FA42 for ⅲ
    await N.writeFileAtomic(f, `${info.text}x`, store);
    expect(fs.readFileSync(f).toString('hex')).toBe(`${bytes.toString('hex')}78`);
  });
  it('a Big5 file an override chose saves with the WHATWG table (十 A451, 卅 A4CA), and a new character too', async () => {
    const text = '# 筆記\n\n十月十日是國慶日，學校放假一天。二十年前的老照片，記錄了外婆家門口那棵榕樹。卅年。\n';
    const bytes = iconv(text, 'BIG5');
    expect(decodeOld(bytes).encoding).toBe('gbk');
    expect(N.saveTableOf(text, 'big5', bytes)).toBeUndefined();
    // S4 (f): the reading is the dormant override's (passed explicitly); the save path is readFileInfo's.
    const r = decodeNew(bytes, true);
    expect(r).toMatchObject({ text, encoding: 'big5' });
    const meta = { encoding: r.encoding, bom: r.bom, eol: N.eolOf(r.text) };
    expect(N.encodeText(`${r.text}十\n`, meta).equals(iconv(`${text}十\n`, 'BIG5'))).toBe(true);
    // by default (overrides off) the file reads and saves exactly as 0.1.1 reads and saves it
    const f = path.join(dir, 'big5.md');
    fs.writeFileSync(f, bytes);
    const store = N.createFileMetaStore();
    const info = await N.readFileInfo(f, store);
    const o = decodeOld(bytes);
    expect(info.encoding).toBe(o.encoding);
    await N.writeFileAtomic(f, `${info.text}十\n`, store);
    expect(fs.readFileSync(f).equals(O.encodeText(`${o.text}十\n`, { encoding: o.encoding, bom: o.bom, eol: O.eolOf(o.text) }))).toBe(true);
  });
});

describe('S4 (c): one switch turns every override off', () => {
  it('DECODER_OVERRIDES is exported and OFF (S4 (f)); decodeBuffer(buf, false) and the default answer as 0.1.0 for every override', () => {
    expect(N.DECODER_OVERRIDES).toBe(false);
    const zh = '# 标题\n\n这是一个中文文档，包含一些内容。第二句话在这里。\n';
    const inputs: Buffer[] = [
      iconv('# 筆記\n\n這份報告會在下週三之前寄給各位董事。請將檔案儲存為純文字格式，並附上說明。\n', 'BIG5'), // 4: Big5
      Buffer.from(zh, 'utf16le'), // 1: BOM-less UTF-16
      Buffer.from('\u0001\u0002\u0003\u0004a\u0005\u0006', 'utf8'), // 2: binary (> 50 % hard controls)
      Buffer.concat([Buffer.from(zh, 'utf8'), Buffer.from([0xff])]), // 3: lenient UTF-8
    ];
    for (const b of inputs) {
      const on = (() => { try { return decodeNew(b, true); } catch { return 'THROW'; } })();
      const off = (() => { try { return decodeNew(b, false); } catch { return 'THROW'; } })();
      const byDefault = (() => { try { return decodeNew(b); } catch { return 'THROW'; } })();
      const fixture = (() => { try { return decodeOld(b); } catch { return 'THROW'; } })();
      expect(off).toEqual(fixture);
      expect(byDefault).toEqual(fixture);
      expect(on).not.toEqual(fixture); // each input is one an override answers
    }
  });
});

describe('What nobody covered (stage 2a): binaries and a UTF-8 file with one GBK paragraph', () => {
  const E = path.resolve(__dirname, '../node_modules/electron/dist/Electron.app/Contents');
  const bins = [`${E}/MacOS/Electron`, `${E}/Frameworks/Squirrel.framework/Versions/A/Squirrel`, path.resolve(__dirname, '../node_modules/fsevents/fsevents.node')]
    .filter((f) => fs.existsSync(f));
  it(`extensionless executables / native modules are refused (${bins.length} files), never read as U+FFFD text`, async () => {
    expect(bins.length).toBeGreaterThan(0);
    for (const f of bins) {
      const b = fs.readFileSync(f);
      expect(() => decodeOld(b)).toThrow();
      expect(() => decodeNew(b)).toThrow(N.UNDECODABLE_MESSAGE);
      expect(() => decodeNew(b, true)).toThrow(N.UNDECODABLE_MESSAGE); // the dormant overrides too (S4 (f))
      // with the NUL bytes taken out, too (the binary rule does not need them)
      const nz = Buffer.from(b.filter((x) => x !== 0));
      for (const ov of [undefined, true]) {
        let r: Decoded | null = null;
        try { r = decodeNew(nz, ov); } catch { r = null; }
        expect(r?.replaced).toBeUndefined();
      }
    }
  });
  it('a UTF-8 majority with one GBK paragraph: lenient UTF-8 (UTF-8 paragraphs intact) or 0.1.0\'s answer, never lenient GBK', () => {
    const paras = ['# 会议纪要', '周一上午九点在三楼会议室开项目例会，请大家提前十分钟到场。会议将讨论下季度的预算和招聘计划。', '- 负责人需要在周五之前提交报告，并说明风险。', '图书馆的阅览室很安静，只听得见翻书的声音。窗外的银杏叶落了一地。', '音乐会结束时，全场观众起立鼓掌，指挥转身向乐团致意。'];
    for (let g = 0; g < paras.length; g++) {
      const b = Buffer.concat(paras.flatMap((p, j) => [j === g ? iconv(p, 'GBK') : Buffer.from(p, 'utf8'), Buffer.from('\n\n')]));
      expect(decodeNew(b)).toEqual(decodeOld(b)); // default (S4 (f))
      const r = decodeNew(b, true); // the dormant overrides
      if (r.replaced) {
        expect(r.encoding).toBe('utf-8');
        for (let j = 0; j < paras.length; j++) if (j !== g) expect(r.text).toContain(paras[j]);
      } else expect(r).toEqual(decodeOld(b));
    }
  });
});
