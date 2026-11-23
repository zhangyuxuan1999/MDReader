// test/review-worker-guards.test.ts — regression test for findings-r3 (worker finding K):
//  1) `isToWorker` (src/shared/protocol.ts, frozen) validates only `.type`, so a message with a known
//     type and a missing payload passes the guard. It used to throw inside the render core, and an
//     exception in the worker's `onmessage` reaches the client as a worker `error` event → full restart
//     + 「渲染器已重启」 toast. `core.handle` now shape-checks every message and drops a malformed one
//     with a single console.warn, leaving the state untouched.
//  2) WorkerClientApi.setOptions is part of the frozen contract but nothing in the app calls it —
//     these assertions pin what it actually does so a regression is visible.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isToWorker } from '../src/shared/protocol';
import { unpackHtml } from '../src/shared/protocol';
import {
  BLOCK_STRIDE, B_ID, DEFAULT_RENDER_OPTIONS,
  type FromWorker, type HtmlMsg, type StructureMsg, type ToWorker,
} from '../src/shared/types';
import { createRenderCore } from '../src/worker/core';

function core() {
  const msgs: FromWorker[] = [];
  const c = createRenderCore((m) => msgs.push(m));
  c.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
  return { c, msgs };
}

describe('review: worker message validation', () => {
  const MALFORMED: unknown[] = [
    { type: 'edit', version: 2 },                  // no `changes`
    { type: 'need' },                              // no `ids`
    { type: 'setDoc', docId: 'x', version: 1 },    // no `text`
    { type: 'viewport' },                          // no lines
    { type: 'draft' },                             // no action
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isToWorker accepts every malformed message (type-only guard, src/shared is frozen)', () => {
    for (const m of MALFORMED) expect(isToWorker(m), JSON.stringify(m)).toBe(true);
  });

  it('the core drops the messages the guard let through instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwing: unknown[] = [];
    for (const m of MALFORMED) {
      const { c } = core();
      c.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# a\n\nb\n' });
      try {
        c.handle(m as ToWorker);
      } catch (e) {
        throwing.push({ msg: m, err: (e as Error).message });
      }
    }
    expect(throwing, 'render.worker.ts claims such messages are "ignored instead of throwing inside the core"').toEqual([]);
    expect(warn.mock.calls.length).toBe(MALFORMED.length); // exactly one warning per dropped message
  });

  it('a malformed `viewport` does not poison the auto-push window', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { c, msgs } = core();
    c.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# a\n\nb\n\nc\n' });
    c.handle({ type: 'viewport', firstLine: 1, lastLine: 5 });
    c.handle({ type: 'viewport' } as unknown as ToWorker);
    const deadline = Date.now() + 5000;
    while (!msgs.some((m) => m.type === 'idle')) {
      if (Date.now() > deadline) throw new Error('no idle');
      await new Promise((r) => setTimeout(r, 2));
    }
    const s = msgs.find((m): m is StructureMsg => m.type === 'structure')!;
    const first = s.blocks[B_ID];
    const pushed = msgs.filter((m): m is HtmlMsg => m.type === 'html').flatMap((m) => unpackHtml(m.batch));
    expect(s.blocks.length / BLOCK_STRIDE).toBe(3);
    expect(pushed.map((p) => p.id)).toContain(first);   // the window survived the malformed message
  });

  it('`draft` only accepts the four documented actions (no property lookup on the saver)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { c, msgs } = core();
    c.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'x' });
    expect(() => c.handle({ type: 'draft', action: 'constructor' } as unknown as ToWorker)).not.toThrow();
    expect(() => c.handle({ type: 'draft', action: 'toString' } as unknown as ToWorker)).not.toThrow();
    expect(msgs.some((m) => m.type === 'error')).toBe(false);
  });
});

describe('review: setOptions (contract API, never called by the app)', () => {
  const textOf = (msgs: FromWorker[]): string =>
    msgs.filter((m): m is HtmlMsg => m.type === 'html').flatMap((m) => unpackHtml(m.batch)).map((i) => i.payload).join('');

  const render = async (patch: Partial<typeof DEFAULT_RENDER_OPTIONS> | null, doc: string): Promise<string> => {
    const { c, msgs } = core();
    c.handle({ type: 'setDoc', docId: 'd', version: 1, text: doc });
    const s = msgs.find((m): m is StructureMsg => m.type === 'structure')!;
    if (patch) c.handle({ type: 'setOptions', options: patch });
    c.handle({ type: 'viewport', firstLine: 1, lastLine: s.lineCount });
    const ids: number[] = [];
    for (let o = 0; o < s.blocks.length; o += 4) ids.push(s.blocks[o]);
    c.handle({ type: 'need', ids });
    const deadline = Date.now() + 10000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2));
      if (msgs.some((m) => m.type === 'idle')) break;
      if (Date.now() > deadline) throw new Error('no idle');
    }
    return textOf(msgs);
  };

  it('breaks:true turns a single newline into <br>', async () => {
    expect(await render(null, 'a\nb\n')).not.toContain('<br>');
    expect(await render({ breaks: true }, 'a\nb\n')).toContain('<br>');
  });

  it('highlight:false drops the hljs classes', async () => {
    expect(await render(null, '```js\nconst a = 1;\n```\n')).toContain('hljs');
    expect(await render({ highlight: false }, '```js\nconst a = 1;\n```\n')).not.toContain('hljs');
  });

  it('linkify:false leaves a bare URL as text', async () => {
    expect(await render(null, 'see https://example.com now\n')).toContain('<a href="https://example.com"');
    expect(await render({ linkify: false }, 'see https://example.com now\n')).not.toContain('<a href="https://example.com"');
  });
});
