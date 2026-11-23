// @vitest-environment jsdom
// The 视图 → 切换主题 cycle (src/app/App.ts `nextThemePref`, fix round 2).
// The old toggle only ever wrote an explicit light/dark preference: after one ⇧⌘L the window stopped
// following the macOS appearance and nothing in the app could hand it back.
import { describe, expect, it } from 'vitest';
import { nextThemePref } from '../src/app/App';
import type { ResolvedTheme, ThemePref } from '../src/shared/types';

/** Walks the cycle the way pressing ⇧⌘L repeatedly does, under a fixed system appearance. */
function walk(system: ResolvedTheme, presses: number, start: ThemePref = 'system'): Array<{ pref: ThemePref; seen: ResolvedTheme }> {
  const out: Array<{ pref: ThemePref; seen: ResolvedTheme }> = [];
  let pref = start;
  const resolvedOf = (p: ThemePref): ResolvedTheme => (p === 'system' ? system : p);
  for (let i = 0; i < presses; i++) {
    pref = nextThemePref(pref, resolvedOf(pref), system);
    out.push({ pref, seen: resolvedOf(pref) });
  }
  return out;
}

describe('nextThemePref', () => {
  it('flips what the user sees on every press', () => {
    for (const system of ['light', 'dark'] as ResolvedTheme[]) {
      const steps = walk(system, 6);
      let previous: ResolvedTheme = system;
      for (const s of steps) {
        expect(s.seen, `system=${system}`).not.toBe(previous);
        previous = s.seen;
      }
    }
  });

  it('comes back to 跟随系统 instead of pinning a preference for good', () => {
    expect(walk('light', 4).map((s) => s.pref)).toEqual(['dark', 'system', 'dark', 'system']);
    expect(walk('dark', 4).map((s) => s.pref)).toEqual(['light', 'system', 'light', 'system']);
  });

  it('un-pins a preference stored by an earlier session', () => {
    // mdr.theme = 'dark' left over from an earlier session, system light: the first press already
    // hands the window back to the system (and turns it light, so the press is visible).
    expect(walk('light', 2, 'dark').map((s) => s)).toEqual([
      { pref: 'system', seen: 'light' },
      { pref: 'dark', seen: 'dark' },
    ]);
    // A pin that matches the system appearance still flips first, and lands on 'system' after.
    expect(nextThemePref('light', 'light', 'light')).toBe('dark');
    expect(nextThemePref('dark', 'dark', 'light')).toBe('system');
    expect(nextThemePref('dark', 'dark', 'dark')).toBe('light');
    expect(nextThemePref('light', 'light', 'dark')).toBe('system');
  });
});
