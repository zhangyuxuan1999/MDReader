// @vitest-environment jsdom
// test/review-dispose-leaks.test.ts — regression: subscriptions must not outlive their owner.
//  (1) createTheme()'s matchMedia 'change' listener is released by disposeTheme() (App.dispose calls it).
//  (2) createToolbar()'s registry.onChange(refresh) subscription is released by disposeToolbar().
// Both were unremovable before the fix round; these cases used to assert the leak.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTheme, disposeTheme } from '../src/app/theme';
import { createToolbar, disposeToolbar } from '../src/editor/toolbar';
import { createCommandRegistry } from '../src/app/registry';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('review: listeners that outlive their owner', () => {
  it('theme: disposeTheme removes the matchMedia change listener', () => {
    const listeners = new Set<() => void>();
    const mq = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    };
    (globalThis as unknown as { matchMedia: () => unknown }).matchMedia = () => mq;
    const theme = createTheme();
    expect(listeners.size).toBe(1);
    expect(theme.resolved()).toBe('light');

    // The App is disposed; a later OS theme change must not rewrite <html data-theme> any more.
    disposeTheme(theme);
    expect(listeners.size).toBe(0);
    document.documentElement.dataset.theme = 'probe';
    mq.matches = true;
    for (const fn of Array.from(listeners)) fn();
    expect(document.documentElement.dataset.theme).toBe('probe');
  });

  it('theme: onChange handlers stop firing after disposeTheme', () => {
    const listeners = new Set<() => void>();
    const mq = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    };
    (globalThis as unknown as { matchMedia: () => unknown }).matchMedia = () => mq;
    const theme = createTheme();
    let seen = 0;
    theme.onChange(() => { seen++; });
    theme.set('dark');
    expect(seen).toBe(1);
    disposeTheme(theme);
    theme.set('light');
    expect(seen).toBe(1);
  });

  it('toolbar: disposeToolbar releases the registry.onChange subscription', () => {
    const registry = createCommandRegistry();
    const header = document.createElement('header');
    document.body.appendChild(header);
    const toolbar = createToolbar(header, registry);
    const btn = header.querySelector<HTMLButtonElement>('button[data-cmd="file.save"]')!;
    const before = btn.title;

    disposeToolbar(toolbar);   // App.dispose() releases the subscription and removes the buttons
    header.remove();
    registry.register({ id: 'file.save', title: '保存X', scope: 'global', run() {} });
    const after = btn.title;
    expect(after).toBe(before);   // the detached toolbar is no longer driven by the registry
    expect(header.querySelector('button[data-cmd="file.save"]')).toBeNull();
  });
});
