// test/v4-dec-off.test.ts — verify-decoder (0.2.0 stage 2d, fix round 3): variations of the r2 groups
// H7 (a clean legacy reading replaced), H23 (the save table) and the "is off really off" proof, against
// the frozen 0.1.0 fixture. Runs in the system Node (bench/electron/v4-dec-diff.mjs runs the same kind of
// checks in the Electron main process). All bytes come from /usr/bin/iconv (real encoders) or literal hex.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as neu from '../electron/fileIO.mjs';
import * as old from './fixtures/fileIO-0.1.0.mjs';
// @ts-expect-error plain .mjs helper without types
import { writeDormant } from '../bench/verify/v4-dec-diff.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-dec-off-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const iconv = (s: string, to: string): Buffer => spawnSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(s, 'utf8') }).stdout as Buffer;
const H = (h: string): Buffer => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const A = (s: string): Buffer => Buffer.from(s, 'latin1');
const reading = (f: () => { text: string; encoding: string; bom: boolean; replaced?: number }) => {
  try {
    const r = f();
    return [r.text, r.encoding, r.bom, r.replaced ?? 0];
  } catch (e) {
    return 'ERR ' + (e as Error).message;
  }
};
function diffCount(a: Buffer, b: Buffer): number {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}
/** Real readFileInfo / writeFileAtomic of a module: [info, bytes after an unmodified save, after + 'x' at the end]. */
async function roundTrip(M: typeof neu, buf: Buffer, tag: string) {
  const p = path.join(tmp, `${tag}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(p, buf);
  const store = M.createFileMetaStore();
  let info;
  try {
    info = await M.readFileInfo(p, store);
  } catch (e) {
    fs.rmSync(p, { force: true });
    return { info: 'ERR ' + (e as Error).message, same: buf, edited: buf };
  }
  await M.writeFileAtomic(p, info.text, store);
  const same = fs.readFileSync(p);
  await M.writeFileAtomic(p, info.text.replace(/\r\n?/g, '\n') + 'x', store);
  const edited = fs.readFileSync(p);
  fs.rmSync(p, { force: true });
  return { info: [info.text, info.encoding, (info as { replacedBytes?: number }).replacedBytes ?? 0], same, edited };
}
async function sameAsOld(buf: Buffer, tag: string) {
  expect(reading(() => neu.decodeBuffer(buf))).toEqual(reading(() => old.decodeBuffer(buf)));
  const n = await roundTrip(neu, buf, tag + '-n');
  const o = await roundTrip(old as unknown as typeof neu, buf, tag + '-o');
  expect(n.info).toEqual(o.info);
  expect(diffCount(n.same, buf)).toBeLessThanOrEqual(diffCount(o.same, buf));
  expect(diffCount(n.edited.subarray(0, buf.length), buf)).toBeLessThanOrEqual(diffCount(o.edited.subarray(0, buf.length), buf));
  return { n, o };
}

const sheet = '# 工时\n\n| 日期 | 时长 | 金额 |\n|---|---|---|\n' + Array.from({ length: 40 }, (_, i) => `| 11-${String(i + 1).padStart(2, '0')} | ${8 + (i % 3)}小时 | ${i * 37}元 |`).join('\n') + '\n';

describe('H7 variations: a clean GBK reading stays 0.1.0\'s (overrides off)', () => {
  it('timesheet, CRLF, cut inside the last character, NUL-padded, 240 KB (past the dormant sampling)', async () => {
    const g = iconv(sheet, 'GBK');
    const crlf = iconv(sheet.replace(/\n/g, '\r\n'), 'GBK');
    const big = iconv(sheet.repeat(220), 'GBK');
    expect(big.length).toBeGreaterThan(4 * 24 * 1024 * 2);
    for (const [tag, b] of [['sheet', g], ['crlf', crlf], ['cut', g.subarray(0, g.length - 5)], ['nul', Buffer.concat([g, Buffer.alloc(8)])], ['big', big]] as const) {
      const { n } = await sameAsOld(b, tag);
      if (tag !== 'cut' && tag !== 'nul') {
        expect(n.info[1]).toBe('gbk');
        expect(n.edited.equals(Buffer.concat([b, A('x')]))).toBe(true);
      }
    }
  });
  it('H7-only characters (小时元一 …): the bytes are valid UTF-8, read as UTF-8 by both (pre-existing, unchanged)', async () => {
    const b = iconv('# 小时\n\n小时一元小时一元\n', 'GBK');
    const { n } = await sameAsOld(b, 'h7only');
    expect(n.info[1]).toBe('utf-8');
  });
});

describe('H23 variations: the save table never changes more bytes than 0.1.1', () => {
  it('NEC-style Shift_JIS (EEEF x10 + 8790): same respelling as 0.1.1, also with a mixed-EOL and a CR-only copy', async () => {
    const p: Buffer[] = [];
    for (let i = 0; i < 10; i++) p.push(A('- '), H('eeef'), A(' item\n'));
    p.push(A('x '), H('8790'), A(' y '), H('b1'), A('\n'));
    const nec = Buffer.concat(p);
    await sameAsOld(nec, 'nec');
    await sameAsOld(Buffer.from(nec.toString('latin1').replace(/\n/g, (m, i) => (i % 3 ? '\r\n' : '\n')), 'latin1'), 'nec-mixed');
    await sameAsOld(Buffer.from(nec.toString('latin1').replace(/\n/g, '\r'), 'latin1'), 'nec-cr');
  });
  it('CP932 file (ⅰ FA40, ① 8740, half-width kana before ASCII): exact save with the WHATWG table; typed 纊 / ≒ / ⅰ are not refused', async () => {
    const b = iconv('ｺｰﾄﾞ,ⅰ①,1\nﾃｽﾄ,ⅱ②,2\n', 'CP932');
    const r = neu.decodeBuffer(b);
    expect(r).toEqual(old.decodeBuffer(b));
    expect(r.encoding).toBe('shift_jis');
    expect(neu.saveTableOf(r.text, r.encoding, b)).toBeUndefined();
    expect(neu.encodeText(r.text, { encoding: 'shift_jis', bom: false, eol: 'lf' }).equals(b)).toBe(true);
    for (const ch of ['纊', '≒', 'ⅰ', '髙', '￢']) {
      const out = neu.encodeText(r.text + ch, { encoding: 'shift_jis', bom: false, eol: 'lf' });
      expect(out.subarray(0, b.length).equals(b)).toBe(true);
      expect(new TextDecoder('shift_jis').decode(out)).toBe(r.text + ch);
    }
    await sameAsOld(b, 'cp932');
    // the same file with CRLF on one line only (K10): 0.1.0's table, as 0.1.1
    const mixed = Buffer.concat([b.subarray(0, b.indexOf(0x0a)), A('\r'), b.subarray(b.indexOf(0x0a))]);
    expect(neu.saveTableOf(neu.decodeBuffer(mixed).text, 'shift_jis', mixed)).toBe('0.1.0');
    await sameAsOld(mixed, 'cp932-mixed');
  });
});

describe('off is off: the dormant override helpers are never entered by the default configuration', () => {
  it('a copy whose helpers throw reads and saves every input like the tree', async () => {
    const dormantPath = writeDormant(path.resolve(__dirname, '../electron/fileIO.mjs'), tmp);
    const D = await import(dormantPath);
    const inputs = [
      iconv(sheet, 'GBK'), iconv(sheet.repeat(300), 'GBK'), Buffer.concat([Buffer.from(sheet.repeat(300)), H('ff')]),
      Buffer.from('ab\0c\0d\0e\0', 'latin1'), Buffer.from('plain\n', 'utf16le'), Buffer.alloc(200_000), H('ff'), Buffer.alloc(0),
      iconv('這份報告說明了專案目前的進度。第十章、卅年。', 'BIG5'), iconv('ﾃｽﾄ,1\n', 'CP932'), A('Caf\xe9\n'),
    ];
    for (const b of inputs) {
      expect(reading(() => D.decodeBuffer(b))).toEqual(reading(() => old.decodeBuffer(b)));
      const n = await roundTrip(D, b, 'dormant').catch((e: Error) => ({ err: e.message }));
      expect(JSON.stringify(n)).not.toContain('DORMANT');
    }
  });
});
