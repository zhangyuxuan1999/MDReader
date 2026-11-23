// test/review-heights.test.ts — verifier: HeightModel forward/inverse mapping round trip.
import { describe, expect, it } from 'vitest';
import { HeightModel } from '../src/preview/heights';
import { BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START } from '../src/shared/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

describe('review: height model round trip', () => {
  it('scrollTopToLine(lineToScrollTop(l, f)) ≈ (l, f) for random models', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 200);
      const arr = new Int32Array(n * BLOCK_STRIDE);
      const h = new Float64Array(n);
      let line = 1;
      for (let i = 0; i < n; i++) {
        const lc = 1 + Math.floor(r() * 30);
        arr[i * BLOCK_STRIDE + B_ID] = i + 1;
        arr[i * BLOCK_STRIDE + B_START] = line;
        arr[i * BLOCK_STRIDE + B_LINES] = lc;
        arr[i * BLOCK_STRIDE + B_KIND] = 0;
        h[i] = 28 + Math.floor(r() * 500);
        line += lc;
      }
      const m = new HeightModel();
      m.bodyTop = Math.floor(r() * 60);
      m.setStructure(arr, h);
      const total = line - 1;
      for (let k = 0; k < 200; k++) {
        const l = 1 + Math.floor(r() * total);
        const f = r() * 0.99;
        const top = m.lineToScrollTop(l, f);
        const back = m.scrollTopToLine(top);
        expect(back.line, `seed ${seed} l=${l} f=${f}`).toBe(l);
        expect(Math.abs(back.fraction - f), `seed ${seed} l=${l} f=${f}`).toBeLessThan(0.02);
      }
      // edges
      expect(m.scrollTopToLine(-100).line).toBe(1);
      const end = m.scrollTopToLine(1e9);
      expect(end.line).toBe(total);
      expect(m.indexAtLine(0)).toBe(0);
      expect(m.indexAtLine(1e9)).toBe(n - 1);
    }
  });
});
