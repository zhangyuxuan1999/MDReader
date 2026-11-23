import { describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../src/app/registry';
import type { Command } from '../src/shared/types';

const cmd = (over: Partial<Command> = {}): Command => ({ id: 'file.save', title: '保存', scope: 'global', run: () => {}, ...over });

describe('createCommandRegistry', () => {
  it('registers, gets and lists commands (re-register replaces)', () => {
    const r = createCommandRegistry();
    r.register(cmd());
    r.register(cmd({ id: 'file.open', title: '打开' }));
    r.register(cmd({ title: '保存 v2' }));
    expect(r.get('file.save')?.title).toBe('保存 v2');
    expect(r.list().map((c) => c.id)).toEqual(['file.save', 'file.open']);
    expect(r.get('edit.bold')).toBeUndefined();
  });

  it('run() executes enabled commands and reports unknown/disabled ones', () => {
    const r = createCommandRegistry();
    const run = vi.fn();
    r.register(cmd({ run }));
    r.register(cmd({ id: 'file.open', run, enabled: () => false }));
    expect(r.run('file.save')).toBe(true);
    expect(r.run('file.open')).toBe(false);
    expect(r.run('edit.bold')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('run() survives throwing and rejecting commands', async () => {
    const r = createCommandRegistry();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    r.register(cmd({ run: () => { throw new Error('boom'); } }));
    r.register(cmd({ id: 'file.open', run: () => Promise.reject(new Error('async boom')) }));
    expect(r.run('file.save')).toBe(true);
    expect(r.run('file.open')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('onChange fires on register and can be unsubscribed', () => {
    const r = createCommandRegistry();
    const fn = vi.fn();
    const off = r.onChange(fn);
    r.register(cmd());
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    r.register(cmd({ id: 'file.open' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
