// Adversarial review (verify:review#1, 2026-11-20): valid UTF-8 Markdown that the installed 0.1.0
// opened must still open in the 0.1.1 hotfix. The hotfix's decodeBuffer refuses strict UTF-8 with
// more than 2 % control characters as "binary" — terminal output with ANSI colour codes (ESC) or
// form feeds pasted into a .md crosses that line easily.
import { describe, expect, it } from 'vitest';
import { decodeBuffer } from '../electron/fileIO.mjs';
// @ts-expect-error untyped .mjs: the installed 0.1.0's fileIO, frozen as a fixture (byte-identical to the extracted bundle's copy)
import { decodeBuffer as decodeOld } from './fixtures/fileIO-0.1.0.mjs';

const ESC = '\u001b';
function ansiDoc(lines: number): string {
  let s = '# 测试日志\n\n下面是终端输出（带颜色）：\n\n```\n';
  for (let i = 0; i < lines; i++) s += `${ESC}[32m✓${ESC}[0m test case number ${i} passes ${ESC}[2m(${i} ms)${ESC}[0m\n`;
  return s + '```\n';
}

describe('review: valid UTF-8 with control characters', () => {
  it('a Markdown file with ANSI-coloured terminal output: 0.1.0 opens it, 0.1.1 refuses it', () => {
    const text = ansiDoc(20);
    const buf = Buffer.from(text, 'utf8');
    const old = decodeOld(buf);
    expect(old.text).toBe(text); // installed app shows it
    let neu: unknown = null;
    let err: unknown = null;
    try {
      neu = decodeBuffer(buf);
      decodeBuffer(buf, true); // the dormant override 2 must not refuse it either (S4 (f))
    } catch (e) {
      err = e;
    }
    // Report what the hotfix does (the assertion below documents the regression).
    expect({ refused: !!err, message: err instanceof Error ? err.message : null, sameText: (neu as { text?: string } | null)?.text === text })
      .toEqual({ refused: false, message: null, sameText: true });
  });

  it('a single coloured line is still accepted (below 2 %)', () => {
    const text = `# 标题\n\n${'正文。'.repeat(200)}\n\n${ESC}[31mred${ESC}[0m\n`;
    expect(decodeBuffer(Buffer.from(text, 'utf8')).text).toBe(text);
    expect(decodeBuffer(Buffer.from(text, 'utf8'), true).text).toBe(text); // the dormant override 2 too (S4 (f))
  });

  it('form feeds (page breaks) between sections', () => {
    const text = Array.from({ length: 30 }, (_, i) => `## S${i}\n\nok\n\f`).join('\n');
    const old = decodeOld(Buffer.from(text, 'utf8'));
    expect(old.text).toBe(text);
    let ok = true;
    try {
      ok = decodeBuffer(Buffer.from(text, 'utf8')).text === text && decodeBuffer(Buffer.from(text, 'utf8'), true).text === text; // default and the dormant override 2 (S4 (f))
    } catch {
      ok = false;
    }
    expect(ok).toBe(true);
  });
});
