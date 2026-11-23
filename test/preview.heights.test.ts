import { describe, expect, it } from 'vitest';
import { HeightModel, estimateHeight } from '../src/preview/heights';
import { BlockKind } from '../src/shared/types';
import { structureFrom } from './fixtures/fakeWorker';

function modelOf(spec: Array<[number, number, BlockKind?]>, heights?: number[]): HeightModel {
  const m = new HeightModel();
  const s = structureFrom(spec);
  const n = s.blocks.length / 4;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = heights ? heights[i] : estimateHeight(s.blocks[i * 4 + 3], s.blocks[i * 4 + 2]);
  m.setStructure(s.blocks, h);
  return m;
}

describe('estimateHeight', () => {
  it('follows the spec table with a 28px floor', () => {
    expect(estimateHeight(BlockKind.Heading, 1)).toBe(48);
    expect(estimateHeight(BlockKind.Hr, 1)).toBe(32);
    expect(estimateHeight(BlockKind.Code, 10)).toBe(24 + 230);
    expect(estimateHeight(BlockKind.Table, 3)).toBe(108);
    expect(estimateHeight(BlockKind.Prose, 3)).toBe(84);
    expect(estimateHeight(BlockKind.Prose, 0)).toBe(28);
  });
});

describe('HeightModel', () => {
  it('handles an empty document', () => {
    const m = new HeightModel();
    expect(m.count).toBe(0);
    expect(m.indexAtLine(5)).toBe(-1);
    expect(m.indexAtTop(100)).toBe(-1);
    expect(m.lineToScrollTop(1, 0)).toBe(0);
    expect(m.scrollTopToLine(50)).toEqual({ line: 1, fraction: 0 });
    expect(m.totalHeight()).toBe(0);
  });

  it('handles a single-block document', () => {
    const m = modelOf([[1, 4]], [100]);
    // bodyTop (the article's top padding) is part of the scrolled content, so every target is bodyTop px
    // further down — except the first bodyTop px of the document, where the padding is ramped back so the
    // very start stays at scrollTop 0 (the fresh-load state).
    m.bodyTop = 10;
    expect(m.lineToScrollTop(1, 0)).toBe(0);
    expect(m.lineToScrollTop(3, 0.5)).toBe(72.5);
    expect(m.lineToScrollTop(99, 0)).toBe(110);      // clamped to the block end
    expect(m.scrollTopToLine(72.5)).toEqual({ line: 3, fraction: 0.5 });
    expect(m.scrollTopToLine(-50).line).toBe(1);
    expect(m.scrollTopToLine(9999).line).toBe(4);   // never past the last line
  });

  it('builds tops lazily and finds blocks at boundaries', () => {
    const m = modelOf([[1, 2], [2, 3], [3, 1]], [50, 90, 30]);
    // `tops` / `heights` / `blocks` are persistent capacity buffers: only [0, count) is meaningful.
    expect(Array.from(m.tops().subarray(0, m.count))).toEqual([0, 50, 140]);
    expect(m.totalHeight()).toBe(170);
    expect(m.indexAtLine(1)).toBe(0);
    expect(m.indexAtLine(2)).toBe(0);
    expect(m.indexAtLine(3)).toBe(1);
    expect(m.indexAtLine(6)).toBe(2);
    expect(m.indexAtLine(100)).toBe(2);
    expect(m.indexAtLine(0)).toBe(0);
    expect(m.indexAtTop(0)).toBe(0);
    expect(m.indexAtTop(49.9)).toBe(0);
    expect(m.indexAtTop(50)).toBe(1);
    expect(m.indexAtTop(140)).toBe(2);
    expect(m.indexAtTop(1e6)).toBe(2);
    expect(m.indexAtTop(-5)).toBe(0);
  });

  it('marks tops dirty on setHeight and rebuilds', () => {
    const m = modelOf([[1, 1], [2, 1], [3, 1]], [10, 10, 10]);
    expect(m.tops()[2]).toBe(20);
    m.setHeight(0, 40);
    expect(m.tops()[1]).toBe(40);
    expect(m.tops()[2]).toBe(50);
  });

  it('round-trips lineToScrollTop ↔ scrollTopToLine', () => {
    const m = modelOf([[1, 3, BlockKind.Heading], [2, 7], [3, 40, BlockKind.Code], [4, 1, BlockKind.Hr], [5, 5]]);
    m.bodyTop = 24;
    for (let line = 1; line <= 56; line++) {
      for (const f of [0, 0.25, 0.5, 0.75]) {
        const top = m.lineToScrollTop(line, f);
        const back = m.scrollTopToLine(top);
        expect(back.line).toBe(line);
        expect(back.fraction).toBeCloseTo(f, 6);
      }
    }
    for (let top = 0; top < m.totalHeight(); top += 7.3) {
      const r = m.scrollTopToLine(top);
      expect(m.lineToScrollTop(r.line, r.fraction)).toBeCloseTo(top, 6);
    }
  });

  it('keeps the structure tiling: scrollTop at a block top maps to its start line', () => {
    const m = modelOf([[1, 3], [2, 2], [3, 5]], [84, 56, 140]);
    expect(m.scrollTopToLine(84)).toEqual({ line: 4, fraction: 0 });
    expect(m.scrollTopToLine(140)).toEqual({ line: 6, fraction: 0 });
    expect(m.lineToScrollTop(6, 0)).toBe(140);
  });
});

/** Block records [id, startLine, lineCount, kind] for a spliceBlocks/replaceStructure argument. */
function records(spec: Array<[id: number, start: number, lines: number, kind?: BlockKind]>): Int32Array {
  const a = new Int32Array(spec.length * 4);
  spec.forEach(([id, start, lines, kind], i) => {
    a[i * 4] = id; a[i * 4 + 1] = start; a[i * 4 + 2] = lines; a[i * 4 + 3] = kind ?? BlockKind.Prose;
  });
  return a;
}
const dump = (m: HeightModel): Array<[number, number, number]> =>
  Array.from({ length: m.count }, (_, i) => [m.id(i), m.startLine(i), m.lineCount(i)] as [number, number, number]);
const heightsOf = (m: HeightModel): number[] => Array.from(m.heights.subarray(0, m.count));

describe('HeightModel — persistent growable arrays (CONTRACT §7)', () => {
  it('splices blocks in place and shifts the start lines after the replaced range', () => {
    const m = modelOf([[1, 2], [2, 3], [3, 1], [4, 4]], [50, 90, 30, 70]);
    // block 2 (3 lines, index 1) becomes two blocks of 2 and 3 lines: +2 lines for everything after it
    m.spliceBlocks(1, 1, records([[2, 3, 2], [5, 5, 3]]), 2);
    m.setHeight(1, 56);
    m.setHeight(2, 84);
    expect(dump(m)).toEqual([[1, 1, 2], [2, 3, 2], [5, 5, 3], [3, 8, 1], [4, 9, 4]]);
    expect(heightsOf(m)).toEqual([50, 56, 84, 30, 70]);            // tail heights travelled with the blocks
    expect(Array.from(m.tops().subarray(0, m.count))).toEqual([0, 50, 106, 190, 220]);
    expect(m.indexAtLine(8)).toBe(3);
    expect(m.totalHeight()).toBe(290);
  });

  it('splices a removal in place', () => {
    const m = modelOf([[1, 2], [2, 3], [3, 1], [4, 4]], [50, 90, 30, 70]);
    m.spliceBlocks(1, 2, new Int32Array(0), -4);
    expect(dump(m)).toEqual([[1, 1, 2], [4, 3, 4]]);
    expect(heightsOf(m)).toEqual([50, 70]);
  });

  it('grows the buffers ×1.5 and reuses them: a same-shape splice allocates nothing', () => {
    const m = new HeightModel();
    m.setStructure(records(Array.from({ length: 1000 }, (_, i) => [i + 1, i + 1, 1])), new Float64Array(1000).fill(28));
    const cap = m.capacity;
    expect(cap).toBeGreaterThanOrEqual(1000);
    const blocks = m.blocks, heights = m.heights;
    for (let k = 0; k < 50; k++) m.spliceBlocks(500, 1, records([[501, 501, 1]]), 0);   // "typing" in one block
    expect(m.blocks).toBe(blocks);          // no reallocation
    expect(m.heights).toBe(heights);
    expect(m.capacity).toBe(cap);
    expect(m.count).toBe(1000);
    const tops = m.tops();
    m.setHeight(0, 40);
    expect(m.tops()).toBe(tops);            // tops is recomputed into the same buffer
    // growth beyond the capacity reallocates once, ×1.5, and keeps the existing heights
    m.spliceBlocks(1000, 0, records(Array.from({ length: cap }, (_, i) => [2000 + i, 1001 + i, 1])), cap);
    expect(m.capacity).toBeGreaterThanOrEqual(1000 + cap);
    expect(m.heights[0]).toBe(40);
    expect(m.count).toBe(1000 + cap);
  });

  it('replaceStructure keeps the heights of a surviving prefix and suffix', () => {
    const m = modelOf([[1, 1], [2, 1], [3, 1], [4, 1]], [10, 20, 30, 40]);
    // ids 1,2 survive as a prefix, id 4 as a suffix; one new block replaces id 3
    m.replaceStructure(records([[1, 1, 1], [2, 2, 1], [9, 3, 1], [8, 4, 1], [4, 5, 1]]), 2, 1);
    m.setHeight(2, 33);
    m.setHeight(3, 44);
    expect(heightsOf(m)).toEqual([10, 20, 33, 44, 40]);
    expect(dump(m)).toEqual([[1, 1, 1], [2, 2, 1], [9, 3, 1], [8, 4, 1], [4, 5, 1]]);
  });

  it('releases the capacity when the document shrinks by an order of magnitude', () => {
    const m = new HeightModel();
    m.setStructure(records(Array.from({ length: 5000 }, (_, i) => [i + 1, i + 1, 1])), new Float64Array(5000).fill(28));
    expect(m.capacity).toBeGreaterThanOrEqual(5000);
    m.replaceStructure(records([[1, 1, 1]]));
    expect(m.capacity).toBeLessThan(100);
    expect(m.count).toBe(1);
  });
});
