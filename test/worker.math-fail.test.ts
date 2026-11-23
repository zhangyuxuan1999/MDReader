// test/worker.math-fail.test.ts — the KaTeX-failure path (SPEC §9): when `import('katex')` rejects the
// worker must turn math off, report 「公式渲染不可用」 exactly once and keep rendering everything else.
// This is the coverage the (now deleted) `math.__setMathState` test hook was written for but never had
// (findings-r3, "Dead exports"). The mock is file-scoped: vitest isolates module state per test file.
import { describe, expect, it, vi } from 'vitest';

vi.mock('katex', () => {
  throw new Error('katex unavailable (mocked)');
});

import { unpackHtml } from '../src/shared/protocol';
import { DEFAULT_RENDER_OPTIONS, type FromWorker, type HtmlMsg, type StructureMsg } from '../src/shared/types';
import { T } from '../src/shared/i18n';
import { createRenderCore } from '../src/worker/core';
import { loadMath, mathFailed, mathReady, renderTex } from '../src/worker/math';

describe('KaTeX unavailable', () => {
  it('the core reports it once, disables math and still renders the document', async () => {
    const msgs: FromWorker[] = [];
    const core = createRenderCore((m) => msgs.push(m));
    core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
    core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# T\n\n$x = 1$ and text\n\nplain\n' });
    const s = msgs.find((m): m is StructureMsg => m.type === 'structure')!;
    core.handle({ type: 'viewport', firstLine: 1, lastLine: s.lineCount });
    const deadline = Date.now() + 10000;
    while (!msgs.some((m) => m.type === 'idle')) {
      if (Date.now() > deadline) throw new Error('no idle');
      await new Promise((r) => setTimeout(r, 2));
    }
    const errors = msgs.filter((m): m is Extract<FromWorker, { type: 'error' }> => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: T.mathUnavailable, fatal: false });
    const html = msgs.filter((m): m is HtmlMsg => m.type === 'html').flatMap((m) => unpackHtml(m.batch)).map((i) => i.payload).join('');
    expect(html).toContain('<h1');
    expect(html).toContain('plain');
    expect(html).not.toContain('katex');
  });

  // these run after the core test on purpose: the loader latches `failed` on its first attempt
  it('loadMath resolves false instead of rejecting', async () => {
    await expect(loadMath()).resolves.toBe(false);
    expect(mathReady()).toBe(false);
    expect(mathFailed()).toBe(true);
  });

  it('renderTex falls back to escaped <code>', () => {
    expect(renderTex('a < b', false)).toBe('<code>a &lt; b</code>');
  });

});
