// Window geometry persistence (a tiny JSON in userData — electron-store is not allowed).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  sanitizeWindowState,
} from '../electron/windowState.mjs';

describe('sanitizeWindowState', () => {
  it('defaults to 1400×900', () => {
    expect(sanitizeWindowState(null)).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false });
    expect(DEFAULT_WIDTH).toBe(1400);
    expect(DEFAULT_HEIGHT).toBe(900);
  });

  it('keeps a sane stored size and position', () => {
    expect(sanitizeWindowState({ width: 1000, height: 700, x: 20, y: 40, maximized: true })).toEqual({
      width: 1000,
      height: 700,
      x: 20,
      y: 40,
      maximized: true,
    });
  });

  it('clamps to the minimum size and rounds', () => {
    const s = sanitizeWindowState({ width: 10, height: 10.6 });
    expect(s.width).toBe(MIN_WIDTH);
    expect(s.height).toBe(MIN_HEIGHT);
    expect(sanitizeWindowState({ width: 1000.4, height: 700.6 })).toMatchObject({ width: 1000, height: 701 });
  });

  it('ignores junk', () => {
    for (const junk of [undefined, 'x', 42, [], { width: NaN, height: Infinity, x: 'a', y: null }]) {
      const s = sanitizeWindowState(junk);
      expect(s.width).toBe(DEFAULT_WIDTH);
      expect(s.height).toBe(DEFAULT_HEIGHT);
      expect(s.x).toBeUndefined();
      expect(s.y).toBeUndefined();
    }
  });

  it('drops a position that is on no connected display any more', () => {
    const areas = [{ x: 0, y: 25, width: 1512, height: 957 }];
    expect(sanitizeWindowState({ width: 900, height: 600, x: 300, y: 100 }, areas)).toMatchObject({ x: 300, y: 100 });
    const off = sanitizeWindowState({ width: 900, height: 600, x: -2400, y: -900 }, areas);
    expect(off.x).toBeUndefined();
    expect(off.y).toBeUndefined();
  });

  it('only accepts x and y together', () => {
    expect(sanitizeWindowState({ x: 10 }).x).toBeUndefined();
    expect(sanitizeWindowState({ y: 10 }).y).toBeUndefined();
  });
});
