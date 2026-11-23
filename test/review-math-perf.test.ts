// test/review-math-perf.test.ts — verifier: math.ts mathInline scans forward from every `$` looking for a
// closer; a paragraph with many unpaired `$` (prices) must not go quadratic.
import { describe, expect, it } from 'vitest';
import { createMarkdown } from '../src/worker/md';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';

function timeRender(source: string, math: boolean): number {
  const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math });
  if (math) md.enableMath();
  md.renderBlock('warm $x$ up', { references: {} });
  const t0 = performance.now();
  md.renderBlock(source, { references: {} });
  return performance.now() - t0;
}

describe('review: inline math parser cost on `$`-heavy prose', () => {
  it('a paragraph with 4000 dollar prices renders in reasonable time', () => {
    const words: string[] = [];
    for (let i = 0; i < 4000; i++) words.push(`$${i} 元`);
    const src = words.join(' ');   // ~30 KB, well under maxHtmlChars, so it is parsed by markdown-it
    const plain = timeRender(src.replace(/\$/g, '¥'), true);
    const dollars = timeRender(src, true);
    // eslint-disable-next-line no-console
    console.log(`review-math-perf: plain=${plain.toFixed(1)}ms dollars=${dollars.toFixed(1)}ms chars=${src.length}`);
    expect(dollars).toBeLessThan(200);
  });
  it('unpaired `$` followed by non-digits, 2000 of them', () => {
    const words: string[] = [];
    for (let i = 0; i < 2000; i++) words.push(`$abc`);
    const src = words.join(' ');
    const t = timeRender(src, true);
    // eslint-disable-next-line no-console
    console.log(`review-math-perf: $abc x2000 = ${t.toFixed(1)}ms`);
    expect(t).toBeLessThan(200);
  });
});
