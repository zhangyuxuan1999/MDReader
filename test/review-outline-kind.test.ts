// test/review-outline-kind.test.ts — regression test for findings-r3 (worker finding D):
// a 2-line setext heading whose first line contains a `|` used to be classified `Table` by
// segmenter.kindOf (the table rule only asked "does the next line look like dashes?"), which made
// outline.updateOutline skip the block entirely — even though markdown-it renders it as a real <h2>.
// Result: the heading was in the preview but not in the outline / TOC / export heading ids.
// Fixed by matching GFM's actual rule: the delimiter row must have the SAME cell count as the header
// row, so `配置项 | 说明` (2 cells) + `---` (1 cell) stays Prose and the setext scan finds the heading.
import { describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS, type FromWorker, type OutlineEntry, type StructureMsg } from '../src/shared/types';
import { createRenderCore } from '../src/worker/core';
import { buildBlocks, kindOf, segmentAll } from '../src/worker/segmenter';
import { buildOutline } from '../src/worker/outline';
import { createMarkdown } from '../src/worker/md';

const DOC = ['配置项 | 说明', '---', '', '正文。', '', '普通标题', '---', '', '尾巴。', ''].join('\n');

function run(text: string): { structure: StructureMsg; outline: OutlineEntry[] } {
  const msgs: FromWorker[] = [];
  const core = createRenderCore((m) => msgs.push(m));
  core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
  core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
  const structure = msgs.find((m): m is StructureMsg => m.type === 'structure')!;
  const om = msgs.find((m) => m.type === 'outline') as { items: OutlineEntry[] } | undefined;
  return { structure, outline: om?.items ?? [] };
}

describe('review: setext heading containing a pipe stays in the outline', () => {
  it('markdown-it renders both underlined lines as <h2>', () => {
    const md = createMarkdown(DEFAULT_RENDER_OPTIONS);
    const html = md.md.render(DOC);
    expect(html).toMatch(/<h2[^>]*>配置项 \| 说明<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>普通标题<\/h2>/);
  });

  it('kindOf agrees with markdown-it: the pipe-bearing setext block is NOT a table', () => {
    const lines = DOC.split('\n');
    const segs = segmentAll(lines);
    expect(kindOf(lines, segs[0].start)).toBe(BlockKind.Prose);   // 配置项 | 说明 / ---  (2 cells vs 1)
    expect(kindOf(lines, segs[2].start)).toBe(BlockKind.Prose);   // 普通标题 / ---
  });

  it('real tables are still tables (the delimiter row matches the header row)', () => {
    expect(kindOf(['| a |', '---'], 0)).toBe(BlockKind.Table);
    expect(kindOf(['a | b', '--- | ---'], 0)).toBe(BlockKind.Table);
    expect(kindOf(['| a | b |', '| :-- | --: |'], 0)).toBe(BlockKind.Table);
    expect(kindOf(['a | b | c', '---|---'], 0)).toBe(BlockKind.Prose);   // 3 cells vs 2
    expect(kindOf(['a \\| b', '---'], 0)).toBe(BlockKind.Table);         // an escaped pipe is not a cell break
  });

  it('the block-level render of that block is still an <h2> (preview shows a heading)', () => {
    const md = createMarkdown(DEFAULT_RENDER_OPTIONS);
    const r = md.renderBlock('配置项 | 说明\n---', { references: {} });
    expect(r.html).toContain('<h2');
  });

  it('the outline lists both rendered <h2> headings', () => {
    const { outline } = run(DOC);
    expect(outline.map((e) => e.text)).toEqual(['配置项 | 说明', '普通标题']);
    expect(outline.map((e) => e.line)).toEqual([1, 6]);
    expect(new Set(outline.map((e) => e.slug)).size).toBe(2);
  });

  it('a fresh (non-incremental) outline build agrees', () => {
    const lines = DOC.split('\n');
    let n = 1;
    const blocks = buildBlocks(lines, () => n++);
    expect(buildOutline(blocks, lines).entries.map((e) => e.text)).toEqual(['配置项 | 说明', '普通标题']);
  });
});
