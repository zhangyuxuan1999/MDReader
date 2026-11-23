// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTheme } from '../src/app/theme';
import { LS_THEME } from '../src/shared/types';

/** Minimal MediaQueryList fake whose `matches` can be flipped by the test. */
function fakeMatchMedia(initialDark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn(() => mql as unknown as MediaQueryList);
  return {
    setDark(d: boolean) {
      mql.matches = d;
      for (const fn of listeners) fn();
    },
  };
}

describe('createTheme', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it('defaults to system and follows prefers-color-scheme', () => {
    const mq = fakeMatchMedia(false);
    const theme = createTheme();
    expect(theme.get()).toBe('system');
    expect(theme.resolved()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    const fn = vi.fn();
    theme.onChange(fn);
    mq.setDark(true);
    expect(theme.resolved()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(fn).toHaveBeenCalledWith('dark');
  });

  it('explicit preference wins over the media query and is persisted', () => {
    const mq = fakeMatchMedia(true);
    const theme = createTheme();
    const fn = vi.fn();
    theme.onChange(fn);
    theme.set('light');
    expect(theme.resolved()).toBe('light');
    expect(localStorage.getItem(LS_THEME)).toBe('light');
    expect(fn).toHaveBeenCalledWith('light');
    mq.setDark(false);
    mq.setDark(true);
    expect(fn).toHaveBeenCalledTimes(1); // media changes are ignored while explicit
    theme.set('system');
    expect(localStorage.getItem(LS_THEME)).toBeNull();
    expect(theme.resolved()).toBe('dark');
  });

  it('restores a persisted preference and ignores garbage', () => {
    fakeMatchMedia(false);
    localStorage.setItem(LS_THEME, 'dark');
    expect(createTheme().resolved()).toBe('dark');
    localStorage.setItem(LS_THEME, 'purple');
    expect(createTheme().get()).toBe('system');
  });

  it('does not notify when the resolved theme is unchanged', () => {
    fakeMatchMedia(true);
    const theme = createTheme();
    const fn = vi.fn();
    theme.onChange(fn);
    theme.set('dark'); // system already resolved to dark
    expect(fn).not.toHaveBeenCalled();
  });
});
