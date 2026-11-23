// verify-decoder (0.2.0 stage 2c) — repro tests and save-back semantics for the S4 decoder.
//   perl -e 'alarm 110; exec @ARGV' npx vitest run test/v3-dec-decoder.test.ts
// "DEC-n" blocks FAIL on the candidate today and define "fixed"; the "holds" blocks pass today and pin
// down behaviour this verifier attacked (step 3: save-back for every way a file can be read).
// Reference for "what 0.1.0 / 0.1.1 did": the frozen decoder test/fixtures/fileIO-0.1.0.mjs.
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
const decodeNew = (b: Buffer, ov?: boolean) => N.decodeBuffer(b, ov) as Decoded;
const decodeOld = (b: Buffer) => O.decodeBuffer(b) as Decoded;
const gbkTable = N.legacyEncoderTable('gbk') as Map<string, number[]>;
const encGbk = (s: string): Buffer => Buffer.from([...s].flatMap((ch) => gbkTable.get(ch)!));
const H = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const A = (s: string) => Buffer.from(s, 'latin1');
const FFFD = String.fromCharCode(0xfffd);
const changed = (a: Buffer, b: Buffer) => {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
};
/** The meta readFileInfo stores, and the bytes an unmodified save writes with it. */
const metaOf = (d: Decoded, b: Buffer) => {
  const table = d.replaced ? undefined : N.saveTableOf(d.text, d.encoding, b);
  return { encoding: d.encoding, bom: d.bom, eol: N.eolOf(d.text), ...(table ? { table } : {}) };
};
const saveNew = (d: Decoded, b: Buffer, add = '') => N.encodeText(d.text + add, metaOf(d, b)) as Buffer;
const saveOld = (d: Decoded, add = '') => O.encodeText(d.text + add, { encoding: d.encoding, bom: d.bom, eol: O.eolOf(d.text) }) as Buffer;

const dir = fs.mkdtempSync(path.join(process.env.V3_DEC_TMP || os.tmpdir(), 'v3-dec-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------------------
describe('DEC-1: clean GBK whose characters happen to be UTF-8-shaped is read as lenient UTF-8', () => {
  // 小 D0A1, 时 CAB1, 元 D4AA, 千 C7A7, 一 D2BB: lead C2–DF + trail A1–BF = a valid UTF-8 2-byte sequence.
  const sheet = (rows: number, unit: string, head: string) =>
    `# ${head}\n\n| 日期 | 时长 |\n|---|---|\n` +
    Array.from({ length: rows }, (_, i) => `| 11-${String(i + 1).padStart(2, '0')} | ${8 + (i % 3)}${unit} |`).join('\n') + '\n';
  const cases: [string, string][] = [
    ['timesheet, 20 rows of 小时', sheet(20, '小时', '工时')],
    ['budget, 30 rows of 千元', sheet(30, '千元', '预算')],
    ['timesheet, 40 rows, longer heading', sheet(40, '小时', '十一月工时统计表')],
    ['run log, 20 lines', '# 跑步记录\n\n' + Array.from({ length: 20 }, (_, i) => `- 11/${i + 1} 1小时`).join('\n') + '\n'],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      const b = encGbk(text);
      expect(decodeOld(b)).toMatchObject({ text, encoding: 'gbk' }); // 0.1.0 / 0.1.1: right
      const n = decodeNew(b);
      expect({ encoding: n.encoding, replaced: n.replaced ?? 0, head: n.text.slice(0, 12) })
        .toEqual({ encoding: 'gbk', replaced: 0, head: text.slice(0, 12) }); // candidate: utf-8 + U+FFFD
    });
  }
});

describe('DEC-2: a Shift_JIS reading that neither table gives back: the save rewrites bytes 0.1.1 kept', () => {
  // NEC-style Shift_JIS: ⅰ as EEEF (NEC-selected IBM, 10×), ≒ as 8790 (NEC row 13, 1×), half-width ｱ
  // before LF (so GBK and Big5 fail and 0.1.0 answers shift_jis, the true reading).
  const parts: Buffer[] = [];
  for (let i = 0; i < 10; i++) parts.push(A('- '), H('eeef'), A(' item\n'));
  parts.push(A('x '), H('8790'), A(' y '), H('b1'), A('\n'));
  const b = Buffer.concat(parts);
  for (const ov of [true, false]) {
    it(`overrides ${ov ? 'on' : 'off'}: no more bytes changed than 0.1.1's save changed`, () => {
      const o = decodeOld(b);
      const n = decodeNew(b, ov);
      expect(o.encoding).toBe('shift_jis');
      expect(n).toMatchObject({ text: o.text, encoding: 'shift_jis' });
      const oldChanged = changed(saveOld(o), b); // 2: 8790 -> 81E0
      const newChanged = changed(saveNew(n, b), b); // 22: every EEEF -> FA40 as well
      expect(oldChanged).toBe(2);
      expect(newChanged).toBeLessThanOrEqual(oldChanged);
    });
  }
});

// ------------------------------------------------------------------------------------------------
describe('holds: G23 variations (duplicate-mapped characters, save tables)', () => {
  it('Big5 chosen by the override: 十 A451, 卅 A4CA, box drawing F9F9/F9F8 save byte-exact, new 十 is A451', () => {
    const t = '這份報告說明了專案目前的進度，以及下個階段需要處理的問題。第十章、卅年、╔═╗、圖書館週末開放時間為上午九點到下午五點。\n';
    const big5 = N.legacyEncoderTable('big5') as Map<string, number[]>;
    const b = Buffer.from([...t].flatMap((c) => big5.get(c)!));
    expect(b.includes(H('a451'))).toBe(true);
    // S4 (f): the overrides are off in 0.2.0; this pins the dormant override (passed explicitly).
    const n = decodeNew(b, true);
    expect(n).toMatchObject({ text: t, encoding: 'big5' });
    expect(saveNew(n, b).equals(b)).toBe(true);
    const s = saveNew(n, b, '十卅═');
    expect(s.subarray(0, b.length).equals(b)).toBe(true);
    expect(s.subarray(b.length).toString('hex')).toBe('a451a4caf9f9');
  });
  it('Big5 bytes with 〸 A2CC (ETEN suzhou ten, decodes to 十): no Big5 override, 0.1.0 reading kept, exact save', () => {
    const t = '這份報告說明了專案目前的進度，以及下個階段需要處理的問題。圖書館週末開放時間為上午九點到下午五點。';
    const big5 = N.legacyEncoderTable('big5') as Map<string, number[]>;
    const b = Buffer.concat([Buffer.from([...t].flatMap((c) => big5.get(c)!)), H('a2cc'), A('\n')]);
    const n = decodeNew(b);
    const o = decodeOld(b);
    expect(n.encoding).toBe(o.encoding);
    expect(saveNew(n, b).equals(b)).toBe(true);
  });
  it('Shift_JIS chosen by the override (CP932 bytes: ⅰ FA40, ① 8740): exact save; new ≒ is 81E0, ⅰ FA40', () => {
    const t = 'ファイルを保存してから、もう一度開いてください。この機能はまだ実験的なものなので、ご注意ください。ⅰ①\n';
    const sj = N.legacyEncoderTable('shift_jis') as Map<string, number[]>;
    const b = Buffer.from([...t].flatMap((c) => sj.get(c)!));
    expect(b.includes(H('fa40'))).toBe(true);
    // S4 (f): the overrides are off in 0.2.0; this pins the dormant override (passed explicitly).
    const n = decodeNew(b, true);
    expect(n).toMatchObject({ text: t, encoding: 'shift_jis' });
    expect(metaOf(n, b).table).toBeUndefined();
    const s = saveNew(n, b, '≒ⅰ');
    expect(s.subarray(0, b.length).equals(b)).toBe(true);
    expect(s.subarray(b.length).toString('hex')).toBe('81e0fa40');
  });
  it('0.1.0 Shift_JIS answer that only 0.1.0\'s table gives back (EEEF, no row-13 duplicate): table 0.1.0, exact, +x exact, new ⅰ EEEF as in 0.1.1', () => {
    const b = Buffer.concat([A('- '), H('eeef'), A(' a '), H('b1'), A('\n')]);
    const o = decodeOld(b);
    const n = decodeNew(b);
    expect(o.encoding).toBe('shift_jis');
    expect(n.text).toBe(o.text);
    expect(metaOf(n, b).table).toBe('0.1.0');
    expect(saveNew(n, b).equals(b)).toBe(true);
    expect(saveNew(n, b, 'x').equals(Buffer.concat([b, A('x')]))).toBe(true);
    expect(saveNew(n, b, 'ⅰ').equals(saveOld(o, 'ⅰ'))).toBe(true);
  });
});

describe('holds: step 3, unmodified / +1 ASCII saves for every way a file is read', () => {
  const zh = '# 笔记\n\n今天的会议讨论了下一个版本的发布计划。\n- 待办：修复已知问题\n';
  const cases: [string, Buffer][] = [
    ['utf-8', Buffer.from(zh, 'utf8')],
    ['utf-8 + BOM', Buffer.concat([H('efbbbf'), Buffer.from(zh, 'utf8')])],
    ['utf-8 CRLF, no trailing newline', Buffer.from(zh.replace(/\n/g, '\r\n').replace(/\r\n$/, ''), 'utf8')],
    ['utf-16le + BOM', Buffer.concat([H('fffe'), Buffer.from(zh, 'utf16le')])],
    ['utf-16be + BOM', Buffer.concat([H('feff'), Buffer.from(zh, 'utf16le').swap16()])],
    ['utf-16le no BOM', Buffer.from('# notes\n\nplain ascii text in utf-16\n', 'utf16le')],
    ['utf-16be no BOM', Buffer.from('# notes\n\nplain ascii text in utf-16\n', 'utf16le').swap16()],
    ['gbk', encGbk(zh)],
    ['gbk CRLF', encGbk(zh.replace(/\n/g, '\r\n'))],
    ['windows-1252', A('Caf\xe9 cr\xe8me br\xfbl\xe9e \xff\n')],
  ];
  for (const [name, b] of cases) {
    it(name, () => {
      const n = decodeNew(b);
      expect(n.replaced).toBeUndefined();
      expect(saveNew(n, b).equals(b)).toBe(true);
      const plus = saveNew(n, b, 'x');
      // the untouched bytes are the original bytes (no trailing-newline special case: the x goes last)
      expect(plus.subarray(0, b.length).equals(b)).toBe(true);
    });
  }
  // K24 (H27): pre-existing (identical in 0.1.1), deferred past 0.2.0 by the lead (Stage-2c decisions).
  it.fails('DEC-3 (pre-existing, same in 0.1.1): GB18030 with a four-byte sequence cannot be saved back (save refuses, nothing written)', () => {
    const b = Buffer.concat([encGbk('# 标题\n'), H('95328236'), A('\n')]);
    const n = decodeNew(b);
    const o = decodeOld(b);
    expect(n).toMatchObject({ text: o.text, encoding: 'gbk' });
    expect(() => saveOld(o)).toThrow(/另存为/);
    // fixed when this passes: a gb18030 reading saves back byte-exact
    expect(saveNew(n, b).equals(b)).toBe(true);
  });
  it('lenient UTF-8 (K11): the save writes EF BF BD exactly where the invalid bytes were, nothing else changes', () => {
    const good = Buffer.from('# ' + '一二三四五六七八九十'.repeat(3) + '\n', 'utf8');
    const b = Buffer.concat([good, H('ff'), A(' a '), H('e4b8'), A('\n')]);
    // S4 (f): K11 lapses in 0.2.0 (overrides off); this pins the dormant override 3 (passed explicitly).
    const n = decodeNew(b, true);
    expect(n).toMatchObject({ encoding: 'utf-8', replaced: 2 });
    expect(n.text.split(FFFD).length - 1).toBe(2);
    expect(saveNew(n, b).equals(Buffer.concat([good, H('efbfbd'), A(' a '), H('efbfbd'), A('\n')]))).toBe(true);
  });
});

describe('holds: meta (incl. meta.table) across 另存为, reload, a change on disk, two files in a row', () => {
  const sj = Buffer.concat([A('- '), H('eeef'), A(' a '), H('b1'), A('\n')]); // table 0.1.0 (see above)
  const gb = encGbk('# 标题\n\n正文。\n');
  it('read → save exact → changed on disk → conflict once → retry keeps the table → reload recomputes', async () => {
    const store = N.createFileMetaStore();
    const p = path.join(dir, 'a.md');
    fs.writeFileSync(p, sj);
    const info = await N.readFileInfo(p, store);
    expect(store.get(fs.realpathSync(p)).table).toBe('0.1.0');
    await N.writeFileAtomic(p, info.text, store);
    expect(fs.readFileSync(p).equals(sj)).toBe(true);
    expect(store.get(fs.realpathSync(p)).table).toBe('0.1.0');
    const t = Date.now() / 1000 + 5;
    fs.writeFileSync(p, sj);
    fs.utimesSync(p, t, t);
    await expect(N.writeFileAtomic(p, info.text + 'x', store)).rejects.toThrow();
    await N.writeFileAtomic(p, info.text + 'x', store);
    expect(fs.readFileSync(p).equals(Buffer.concat([sj, A('x')]))).toBe(true);
    const again = await N.readFileInfo(p, store);
    expect(again.encoding).toBe('shift_jis');
    expect(store.get(fs.realpathSync(p)).table).toBe('0.1.0');
  });
  it('two files in a row keep their own meta; 另存为 drops the table and writes UTF-8 (as 0.1.1)', async () => {
    const store = N.createFileMetaStore();
    const p1 = path.join(dir, 'sj.md');
    const p2 = path.join(dir, 'gb.md');
    fs.writeFileSync(p1, sj);
    fs.writeFileSync(p2, gb);
    const i1 = await N.readFileInfo(p1, store);
    const i2 = await N.readFileInfo(p2, store);
    await N.writeFileAtomic(p2, i2.text, store);
    await N.writeFileAtomic(p1, i1.text, store);
    expect(fs.readFileSync(p1).equals(sj)).toBe(true);
    expect(fs.readFileSync(p2).equals(gb)).toBe(true);
    const target = path.join(dir, 'copy.md');
    await N.adoptSaveTarget(target, p1, store);
    expect(store.get(path.join(fs.realpathSync(dir), 'copy.md')) ?? store.get(target)).toMatchObject({ encoding: 'utf-8' });
    await N.writeFileAtomic(target, i1.text, store);
    expect(fs.readFileSync(target).toString('utf8')).toBe(i1.text);
    // and the shipped shell does the same with the same inputs
    const os2 = O.createFileMetaStore();
    const target2 = path.join(dir, 'copy-010.md');
    await O.readFileInfo(p1, os2);
    await O.adoptSaveTarget(target2, p1, os2);
    await O.writeFileAtomic(target2, i1.text, os2);
    expect(fs.readFileSync(target2).equals(fs.readFileSync(target))).toBe(true);
  });
});
