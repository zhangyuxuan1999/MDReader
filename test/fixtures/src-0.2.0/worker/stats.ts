// src/worker/stats.ts — per-block counts (SPEC 4.3.8) and running document totals.
import type { DocStats } from '../shared/types';

export interface BlockCounts { chars: number; charsNoSpace: number; cjk: number; latinWords: number }

const CJK_STRIP = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN_WORD = /[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Unicode code point in one of the Han / Hiragana / Katakana / Hangul script ranges. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3041 && cp <= 0x30ff && cp !== 0x30fb) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff66 && cp <= 0xff9f) ||
    (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3005 && cp <= 0x3007) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff) ||
    (cp >= 0x20000 && cp <= 0x323af)
  );
}

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x3000 || c === 0x2028 || c === 0x2029 || (c >= 0x2000 && c <= 0x200a);
}

/** Counts for one block source. `chars` includes the line terminator that follows the block. */
export function blockCounts(source: string): BlockCounts {
  let spaces = 0;
  let cjk = 0;
  for (let i = 0; i < source.length; i++) {
    let c = source.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < source.length) {
      c = source.codePointAt(i)!;
      i++;
    } else if (isSpace(c)) {
      spaces++;
      continue;
    }
    if (isCjk(c)) cjk++;
  }
  const stripped = cjk > 0 ? source.replace(CJK_STRIP, ' ') : source;
  let latinWords = 0;
  LATIN_WORD.lastIndex = 0;
  while (LATIN_WORD.test(stripped)) latinWords++;
  return { chars: source.length + 1, charsNoSpace: source.length - spaces, cjk, latinWords };
}

export function emptyStats(): DocStats {
  return { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: 0, readingMinutes: 0 };
}

export function addCounts(t: DocStats, b: BlockCounts, sign: 1 | -1): void {
  t.chars += sign * b.chars;
  t.charsNoSpace += sign * b.charsNoSpace;
  t.cjk += sign * b.cjk;
  t.latinWords += sign * b.latinWords;
}

/** Snapshot for a StructureMsg: the running totals plus derived fields. */
export function finaliseStats(t: DocStats, lineCount: number, blockCount: number): DocStats {
  const chars = blockCount === 0 ? 0 : t.chars - 1; // the last block has no following terminator
  const readingMinutes = chars === 0 ? 0 : Math.max(1, Math.ceil(t.cjk / 400 + t.latinWords / 200));
  return { chars, charsNoSpace: t.charsNoSpace, cjk: t.cjk, latinWords: t.latinWords, lines: lineCount, readingMinutes };
}
