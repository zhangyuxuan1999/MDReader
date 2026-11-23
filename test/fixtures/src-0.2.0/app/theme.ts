// src/app/theme.ts — theme preference (LS_THEME) resolved against prefers-color-scheme and applied
// as <html data-theme>. index.html applies the same rule inline before first paint.
import { LS_THEME, type ResolvedTheme, type ThemeApi, type ThemePref } from '../shared/types';

const PREFS: ReadonlySet<string> = new Set<ThemePref>(['system', 'light', 'dark']);

/** ThemeApi (shared/types) is frozen, so the teardown hook lives in a side table keyed by the instance. */
const extras = new WeakMap<ThemeApi, { dispose(): void }>();

/** Releases the matchMedia subscription and drops every onChange handler (no-op for an unknown theme). */
export function disposeTheme(theme: ThemeApi): void {
  extras.get(theme)?.dispose();
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(LS_THEME);
    return v && PREFS.has(v) ? (v as ThemePref) : 'system';
  } catch {
    return 'system';
  }
}

function writePref(p: ThemePref): void {
  try {
    if (p === 'system') localStorage.removeItem(LS_THEME);
    else localStorage.setItem(LS_THEME, p);
  } catch {
    /* private mode: preference is session-only */
  }
}

export function createTheme(): ThemeApi {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const listeners = new Set<(t: ResolvedTheme) => void>();
  let pref = readPref();

  const resolve = (): ResolvedTheme => (pref === 'system' ? (mq?.matches ? 'dark' : 'light') : pref);
  let current = resolve();

  const apply = (): void => {
    const next = resolve();
    document.documentElement.dataset.theme = next;
    if (next === current) return;
    current = next;
    for (const fn of Array.from(listeners)) fn(next);
  };

  apply();
  const onMq = (): void => apply();
  mq?.addEventListener?.('change', onMq);

  const api: ThemeApi = {
    get: () => pref,
    set(p) {
      pref = p;
      writePref(p);
      apply();
    },
    resolved: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  extras.set(api, {
    dispose() {
      mq?.removeEventListener?.('change', onMq);
      listeners.clear();
    },
  });
  return api;
}
