// @vitest-environment jsdom
// src/app/toast.ts — the toast bar, and in particular its coalescing memory.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToasts, FAILURES_FOLDED, MAX_FAILURES } from '../src/app/toast';

describe('createToasts', () => {
  const hosts: HTMLElement[] = [];
  const mount = () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    hosts.push(parent);
    return { parent, api: createToasts(parent) };
  };
  const texts = (parent: HTMLElement) =>
    Array.from(parent.querySelectorAll('.mdr-toast__text')).map((t) => t.textContent);
  afterEach(() => {
    for (const h of hosts.splice(0)) h.remove();
  });

  it('coalesces an identical action-less toast into one counted entry', () => {
    const { parent, api } = mount();
    api.show({ text: '打不开链接' });
    api.show({ text: '打不开链接' });
    api.show({ text: '打不开链接' });
    expect(texts(parent)).toEqual(['打不开链接 ×3']);
  });

  it('keeps two toasts with buttons apart (two decisions, two toasts)', () => {
    const { parent, api } = mount();
    api.show({ text: '发现未保存的草稿', actions: [{ label: '恢复', run: () => {} }] });
    api.show({ text: '发现未保存的草稿', actions: [{ label: '恢复', run: () => {} }] });
    expect(parent.querySelectorAll('.mdr-toast')).toHaveLength(2);
  });

  it('shows a fresh toast after the element was removed from the DOM by someone else', () => {
    // The stale coalescing entry used to swallow the next identical message entirely: 保存失败 was
    // reported once and then never again for the rest of the session.
    const { parent, api } = mount();
    api.show({ text: '保存失败：没有访问该文件的权限', kind: 'error' });
    for (const el of Array.from(parent.querySelectorAll('.mdr-toast'))) el.remove();
    expect(texts(parent)).toEqual([]);
    api.show({ text: '保存失败：没有访问该文件的权限', kind: 'error' });
    expect(texts(parent)).toEqual(['保存失败：没有访问该文件的权限']);
  });

  it('shows the message again after its own dismiss, with the count reset', () => {
    const { parent, api } = mount();
    const dismiss = api.show({ text: '已保存' });
    api.show({ text: '已保存' });
    expect(texts(parent)).toEqual(['已保存 ×2']);
    dismiss();
    expect(texts(parent)).toEqual([]);
    api.show({ text: '已保存' });
    expect(texts(parent)).toEqual(['已保存']);
  });

  it('runs an action once and dismisses the toast', () => {
    const { parent, api } = mount();
    const run = vi.fn();
    api.show({ text: '发现未保存的草稿', actions: [{ label: '恢复', run }] });
    (parent.querySelector('.mdr-toast__btn') as HTMLButtonElement).click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(parent.querySelectorAll('.mdr-toast')).toHaveLength(0);
  });

  it('an error toast with timeoutMs 0 stays until its × is pressed (a failed open, R3)', () => {
    vi.useFakeTimers();
    try {
      const { parent, api } = mount();
      api.show({ text: '无法打开「a.md」：找不到这个文件', kind: 'error', timeoutMs: 0 });
      api.show({ text: '普通错误', kind: 'error' });
      vi.advanceTimersByTime(60_000);
      expect(texts(parent)).toEqual(['无法打开「a.md」：找不到这个文件']);
      parent.querySelector<HTMLButtonElement>('.mdr-toast__close')!.click();
      expect(texts(parent)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  // G34: persistent open-failure toasts, one per file, capped.
  describe('failure toasts by key', () => {
    const fail = (n: string) => ({ text: `无法打开「${n}」：找不到这个文件`, kind: 'error' as const, timeoutMs: 0 });

    it('a new failure of the same key replaces the old one; clearFailure removes it', () => {
      const { parent, api } = mount();
      api.failure('/a.md', fail('a.md'));
      api.failure('/a.md', { ...fail('a.md'), text: '无法打开「a.md」：没有读取这个文件的权限' });
      expect(texts(parent)).toEqual(['无法打开「a.md」：没有读取这个文件的权限']);
      api.clearFailure('/a.md');
      expect(texts(parent)).toEqual([]);
      api.clearFailure('/nope.md');   // unknown key: nothing happens
      expect(texts(parent)).toEqual([]);
    });

    it('two keys with the same text stay two toasts (never coalesced), and an ordinary toast is not touched', () => {
      const { parent, api } = mount();
      api.show({ text: '无法打开「x.md」：找不到这个文件', kind: 'error' });
      api.failure('/a/x.md', fail('x.md'));
      api.failure('/b/x.md', fail('x.md'));
      expect(texts(parent)).toEqual(['无法打开「x.md」：找不到这个文件', '无法打开「x.md」：找不到这个文件', '无法打开「x.md」：找不到这个文件']);
      api.clearFailure('/a/x.md');
      expect(texts(parent)).toHaveLength(2);
    });

    it(`at most ${MAX_FAILURES} on screen (the newest); the rest fold into one counting line`, () => {
      const { parent, api } = mount();
      for (let i = 0; i < 10; i++) api.failure(`/m${i}.md`, fail(`m${i}.md`));
      expect(texts(parent)).toEqual([FAILURES_FOLDED(7), fail('m7.md').text, fail('m8.md').text, fail('m9.md').text]);
      expect(parent.querySelectorAll('.mdr-toast')).toHaveLength(MAX_FAILURES + 1);
      // A file that opens fine: its (hidden) failure goes, the count follows.
      api.clearFailure('/m0.md');
      expect(texts(parent)).toEqual([FAILURES_FOLDED(6), fail('m7.md').text, fail('m8.md').text, fail('m9.md').text]);
      // A visible one opens fine: the newest hidden one moves up.
      api.clearFailure('/m9.md');
      expect(texts(parent)).toEqual([FAILURES_FOLDED(5), fail('m6.md').text, fail('m7.md').text, fail('m8.md').text]);
    });

    it('× on a failure acknowledges it; × on the counting line acknowledges all it stands for', () => {
      const { parent, api } = mount();
      for (let i = 0; i < 5; i++) api.failure(`/m${i}.md`, fail(`m${i}.md`));
      const close = (text: string) => {
        const el = Array.from(parent.querySelectorAll('.mdr-toast')).find((t) => t.querySelector('.mdr-toast__text')!.textContent === text)!;
        (el.querySelector('.mdr-toast__close') as HTMLButtonElement).click();
      };
      close(fail('m4.md').text);
      expect(texts(parent)).toEqual([FAILURES_FOLDED(1), fail('m1.md').text, fail('m2.md').text, fail('m3.md').text]);
      close(FAILURES_FOLDED(1));
      expect(texts(parent)).toEqual([fail('m1.md').text, fail('m2.md').text, fail('m3.md').text]);
      // m0 was acknowledged by the counting line: a later clear of it is a no-op.
      api.clearFailure('/m0.md');
      expect(texts(parent)).toHaveLength(3);
      api.dispose();
      expect(parent.querySelectorAll('.mdr-toast')).toHaveLength(0);
    });
  });
});
