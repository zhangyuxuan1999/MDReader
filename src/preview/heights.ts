// src/preview/heights.ts — the preview height model (SPEC §5.3). Pure maths over the structure
// array: `heights` per block (estimate or measured), `tops` prefix sums rebuilt lazily, `bodyTop`
// (offset of the article inside the scroller). No DOM access: every query is a binary search.
//
// The three arrays are PERSISTENT and growable (CONTRACT §7): they are allocated with spare capacity
// (×1.5 growth), spliced in place with `copyWithin` and only ever replaced when the document outgrows
// the capacity (or shrinks far below it). A keystroke on a 100k-block document must not allocate a
// 0.8 MB Float64Array — V8 puts every allocation over 128 KB in large-object space, which only a major
// GC reclaims, and 600 keystrokes of that churn were the bulk of the P13 1.45 GB peak.
import { B_ID, B_KIND, B_LINES, B_START, BLOCK_STRIDE, BlockKind, type Line } from '../shared/types';

const MIN_HEIGHT = 28;
/** Spare-capacity growth factor and floor for the persistent arrays. */
const GROWTH = 1.5, MIN_CAPACITY = 16;

/** Estimated wrapper height (px) for a pending block, by kind and line count. */
export function estimateHeight(kind: number, lines: number): number {
  let h: number;
  switch (kind) {
    case BlockKind.Heading: h = 48; break;
    case BlockKind.Hr: h = 32; break;
    case BlockKind.Code: h = 24 + 23 * lines; break;
    case BlockKind.Table: h = 36 * lines; break;
    default: h = 28 * lines;
  }
  return h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

export class HeightModel {
  /** Block table, BLOCK_STRIDE ints per block. Only `[0, count * BLOCK_STRIDE)` is meaningful — the buffer
   *  keeps spare capacity so edits can splice in place. */
  blocks: Int32Array = new Int32Array(0);
  count = 0;
  /** Height per block (estimate or measurement). Only `[0, count)` is meaningful (see `blocks`). */
  heights: Float64Array = new Float64Array(0);
  /** Geometric offset (px) of block 0 from the scroller's top border edge — the article's `padding-top`.
   *  It is NOT part of the line ↔ scrollTop mapping (see `lineToScrollTop`); the preview uses it only where
   *  it needs the real position of a block relative to the viewport (window, eviction, isLineVisible). */
  bodyTop = 0;
  private topsArr: Float64Array = new Float64Array(0);
  private topsDirty = false;

  /** Blocks the current buffers can hold without reallocating. */
  get capacity(): number { return this.heights.length; }

  /** Grows the buffers to hold `n` blocks (×1.5, never shrinks); the first `count` entries are carried over. */
  private grow(n: number): void {
    if (n <= this.heights.length) return;
    const cap = Math.max(MIN_CAPACITY, n, Math.ceil(this.heights.length * GROWTH));
    const b = new Int32Array(cap * BLOCK_STRIDE);
    b.set(this.blocks.subarray(0, this.count * BLOCK_STRIDE));
    const h = new Float64Array(cap);
    h.set(this.heights.subarray(0, this.count));
    this.blocks = b;
    this.heights = h;
    this.topsArr = new Float64Array(0);   // rebuilt at the new capacity on demand
    this.topsDirty = true;
  }

  /**
   * Full structure (reset / reconcile path, `applyStructure`). The `prefix` leading and `suffix` trailing
   * blocks of the CURRENT structure keep their heights (their ids survived the reconcile); the caller fills
   * every other slot. The buffers are reused unless the document outgrew them — or shrank so far below the
   * capacity that keeping it would waste megabytes (switching from huge.md back to a small file).
   */
  replaceStructure(blocks: Int32Array, prefix = 0, suffix = 0): void {
    const n = blocks.length / BLOCK_STRIDE;
    const cap = this.heights.length;
    if (n > cap || (cap > 4 * MIN_CAPACITY && 4 * n < cap)) {
      const next = n > cap ? Math.max(MIN_CAPACITY, n, Math.ceil(cap * GROWTH)) : Math.max(MIN_CAPACITY, n);
      const h = new Float64Array(next);
      if (prefix > 0) h.set(this.heights.subarray(0, Math.min(prefix, n)), 0);
      if (suffix > 0) h.set(this.heights.subarray(this.count - suffix, this.count), n - suffix);
      this.heights = h;
      this.blocks = new Int32Array(next * BLOCK_STRIDE);
      this.topsArr = new Float64Array(0);
    } else if (suffix > 0 && n !== this.count) {
      this.heights.copyWithin(n - suffix, this.count - suffix, this.count);
    }
    this.blocks.set(blocks, 0);
    this.count = n;
    this.topsDirty = true;
  }

  /**
   * In-place splice (CONTRACT §7 structure delta): `blocks[index, index+removed)` is replaced by `inserted`
   * and every block after the replaced range keeps its id/kind/lineCount and gets `startLine += lineDelta`.
   * Heights travel with the blocks that moved; the heights of the inserted range are left as they are — the
   * caller owns the measured-height table and fills them right after. Allocates nothing while the capacity
   * holds, which is the whole point of the delta protocol.
   */
  spliceBlocks(index: number, removed: number, inserted: Int32Array, lineDelta: number): void {
    const ins = inserted.length / BLOCK_STRIDE;
    const oldCount = this.count;
    const tailFrom = index + removed;
    const newCount = oldCount - removed + ins;
    this.grow(newCount);
    const b = this.blocks, h = this.heights;
    if (ins !== removed && tailFrom < oldCount) {
      b.copyWithin((index + ins) * BLOCK_STRIDE, tailFrom * BLOCK_STRIDE, oldCount * BLOCK_STRIDE);
      h.copyWithin(index + ins, tailFrom, oldCount);
    }
    if (ins > 0) b.set(inserted, index * BLOCK_STRIDE);
    if (lineDelta !== 0) {
      for (let o = (index + ins) * BLOCK_STRIDE + B_START, end = newCount * BLOCK_STRIDE; o < end; o += BLOCK_STRIDE) {
        b[o] += lineDelta;
      }
    }
    this.count = newCount;
    this.topsDirty = true;
  }

  /** Convenience for tests / one-shot construction: a full structure with explicit heights. */
  setStructure(blocks: Int32Array, heights: Float64Array): void {
    this.replaceStructure(blocks);
    this.heights.set(heights.subarray(0, this.count), 0);
    this.topsDirty = true;
  }

  setHeight(index: number, h: number): void {
    if (this.heights[index] === h) return;
    this.heights[index] = h;
    this.topsDirty = true;
  }

  id(i: number): number { return this.blocks[i * BLOCK_STRIDE + B_ID]; }
  startLine(i: number): Line { return this.blocks[i * BLOCK_STRIDE + B_START]; }
  lineCount(i: number): number { return this.blocks[i * BLOCK_STRIDE + B_LINES]; }
  kind(i: number): BlockKind { return this.blocks[i * BLOCK_STRIDE + B_KIND] as BlockKind; }

  /** Prefix sums of `heights`, rebuilt in place on demand (≈0.05 ms for 30k blocks); like `heights`,
   *  only `[0, count)` is meaningful. */
  tops(): Float64Array {
    if (this.topsDirty || this.topsArr.length < this.count) {
      const n = this.count;
      if (this.topsArr.length < n) this.topsArr = new Float64Array(this.heights.length);
      const t = this.topsArr, h = this.heights;
      let acc = 0;
      for (let i = 0; i < n; i++) { t[i] = acc; acc += h[i]; }
      this.topsDirty = false;
    }
    return this.topsArr;
  }

  totalHeight(): number {
    const n = this.count;
    if (n === 0) return 0;
    return this.tops()[n - 1] + this.heights[n - 1];
  }

  /** Index of the block containing `line` (clamped to [0, count-1]; -1 for an empty document). */
  indexAtLine(line: Line): number {
    const n = this.count;
    if (n === 0) return -1;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.startLine(mid) <= line) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Index of the block whose [top, top+height) contains `relTop` (px relative to block 0), clamped. */
  indexAtTop(relTop: number): number {
    const n = this.count;
    if (n === 0) return -1;
    const t = this.tops();
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= relTop) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * scrollTop that brings `line` (+ fraction of that line) flush with the top edge of the scroller.
   *
   * `bodyTop` (the article's top padding) is part of the scroller's content, so a block's box starts at
   * `bodyTop + tops()[i]`: it must be added, or every jump would land `bodyTop` px short of the top edge.
   * The first `bodyTop` pixels of the document are the exception — there is nothing above them to scroll
   * away — so the padding is handed back over that stretch as a continuous, monotone ramp: the very start
   * maps to scrollTop 0, exactly the state a freshly loaded document is in, instead of pressing the H1
   * against the toolbar. `scrollTopToLine` inverts the same ramp, so the round trip stays a bijection (P10).
   */
  lineToScrollTop(line: Line, fraction: number): number {
    const i = this.indexAtLine(line);
    if (i < 0) return 0;
    const start = this.startLine(i), lines = this.lineCount(i);
    let pos = (line - start) + fraction;
    if (pos < 0) pos = 0; else if (pos > lines) pos = lines;
    const top = this.tops()[i] + (pos / lines) * this.heights[i];
    return top >= this.bodyTop ? top + this.bodyTop : Math.max(0, top * 2);
  }

  /** Inverse of lineToScrollTop (same origin and ramp, `bodyTop` included). */
  scrollTopToLine(top: number): { line: Line; fraction: number } {
    const rel = top >= 2 * this.bodyTop ? top - this.bodyTop : top / 2;
    const i = this.indexAtTop(rel);
    if (i < 0) return { line: 1, fraction: 0 };
    const h = this.heights[i];
    let within = h > 0 ? (rel - this.tops()[i]) / h : 0;
    if (within < 0) within = 0; else if (within > 1) within = 1;
    const lines = this.lineCount(i);
    let pos = within * lines;
    const last = lines - 1;
    if (pos > last + 0.999) pos = last + 0.999;   // stay inside the block's last line
    const off = Math.floor(pos + 1e-7);           // absorb float noise from the forward mapping
    return { line: this.startLine(i) + off, fraction: Math.max(0, pos - off) };
  }
}
