// Adversarial review (verify:review#2, 2026-11-20) of the 0.1.1 hotfix's decodeBuffer
// (electron/fileIO.mjs). The BOM-less UTF-16 sniff runs BEFORE strict UTF-8: plain ASCII Markdown that
// is strictly valid UTF-8 but carries a NUL byte every ~20–30 characters is read as UTF-16LE (CJK
// mojibake). 0.1.0 read it as UTF-8; a save then would write UTF-16LE over the user's file.
import { describe, expect, it } from 'vitest';
import { decodeBuffer } from '../electron/fileIO.mjs';

function asciiWithNuls(every: number): Buffer {
  const base = '# Title\n\nThis is a perfectly normal paragraph of english text written in markdown, with some words.\n';
  let s = '';
  let i = 0;
  for (const ch of base.repeat(20)) {
    s += ch;
    if (++i % every === 0) s += '\u0000';
  }
  let buf = Buffer.from(s, 'utf8');
  if (buf.length % 2) buf = Buffer.concat([buf, Buffer.from('\n')]);
  return buf;
}

describe('review#2: strictly valid UTF-8 with sparse NULs', () => {
  for (const every of [12, 20, 30]) {
    it(`a NUL after every ${every}th character still decodes as UTF-8`, () => {
      const buf = asciiWithNuls(every);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/\u0000/g, '')).toContain('perfectly normal'); // valid UTF-8
      const r = decodeBuffer(buf);
      expect(r.encoding).toBe('utf-8');
      expect(decodeBuffer(buf, true).encoding).toBe('utf-8'); // the dormant override 1 too (S4 (f): off by default)
      expect(r.text.replace(/\u0000/g, '')).toContain('perfectly normal');
    });
  }
});
