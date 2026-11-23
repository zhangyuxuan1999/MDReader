// @vitest-environment jsdom
// test/v6-vr-loader.test.ts — verify-review (stage 2f, after fix round 5): rule L's createPreview / loader races that
// the prototype's tests do not cover, each on a FRESH module graph (vi.resetModules: the chunk is not loaded yet):
//   on → off → on while the chunk is on its way: one shared request, one instance, editable, the earlier promise
//   says the same; dispose while it is on its way: nothing installed, the promise says false; a chunk that fails:
//   the promise rejects, nothing installed, a second press asks again and rejects again, no unhandled rejection; a
//   module that arrives while a load is on its way and a new press comes (installed synchronously): no second instance.
// "Instance" is counted by the hint bar createInlineEdit puts into the page (one per instance).
// Run: perl -e 'alarm 60; exec @ARGV' npx vitest run test/v6-vr-loader.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewApi, PreviewSourceAccess } from '../src/shared/types';

class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
const unhandled: unknown[] = [];
process.on('unhandledRejection', (e) => { unhandled.push(e); });

function source(): PreviewSourceAccess {
  const lines = ['para one', '', 'para two'];
  return { read: (s, c) => lines.slice(s - 1, s - 1 + c).join('\n'), replace: () => {}, history: () => null };
}
async function fresh(): Promise<{ preview: () => PreviewApi; loader: typeof import('../src/preview/inlineEditLoader') }> {
  vi.resetModules();
  const { createPreview } = await import('../src/preview/createPreview');
  const { createBus } = await import('../src/shared/bus');
  const loader = await import('../src/preview/inlineEditLoader');
  const preview = (): PreviewApi => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return createPreview({ parent, bus: createBus(), request: () => {}, viewport: () => {}, resync: () => {}, source: source() });
  };
  return { preview, loader };
}
const hints = (): number => document.querySelectorAll('.mdr-preview__edit-hint').length;
afterEach(() => { document.body.replaceChildren(); vi.doUnmock('../src/preview/inlineEdit'); });

describe('rule L: createPreview and the loader under races', () => {
  it('on → off → on while the chunk is on its way: one request, one instance, editable', async () => {
    const { preview, loader } = await fresh();
    expect(loader.inlineEditLoaded()).toBeNull();
    const pv = preview();
    const p1 = pv.setPreviewEditable(true);
    expect(p1).toBeInstanceOf(Promise);
    expect(pv.setPreviewEditable(false)).toBeUndefined();
    const p2 = pv.setPreviewEditable(true);
    expect(p2).toBe(p1);                                       // the same load, not a second request
    await expect(p2).resolves.toBe(true);
    expect(pv.isPreviewEditable()).toBe(true);
    expect(hints()).toBe(1);
    pv.dispose();
    expect(hints()).toBe(0);
  });

  it('on → off while it is on its way: the promise says false, nothing installed; on later: installed at once', async () => {
    const { preview } = await fresh();
    const pv = preview();
    const p = pv.setPreviewEditable(true) as Promise<boolean>;
    expect(pv.setPreviewEditable(false)).toBeUndefined();
    await expect(p).resolves.toBe(false);
    expect(hints()).toBe(0);
    expect(pv.isPreviewEditable()).toBe(false);
    expect(pv.setPreviewEditable(true)).toBeUndefined();     // the chunk is here now
    expect(pv.isPreviewEditable()).toBe(true);
    expect(hints()).toBe(1);
    pv.dispose();
  });

  it('dispose while the chunk is on its way: nothing installed, the promise says false', async () => {
    const { preview } = await fresh();
    const pv = preview();
    const p = pv.setPreviewEditable(true) as Promise<boolean>;
    pv.dispose();
    await expect(p).resolves.toBe(false);
    expect(hints()).toBe(0);
  });

  it('the module arrives while a load is on its way and a press comes in between: one instance', async () => {
    const { preview, loader } = await fresh();
    const pv = preview();
    const p = pv.setPreviewEditable(true) as Promise<boolean>;
    await loader.loadInlineEdit();                            // the module is here; createPreview's then may not have run
    const r = pv.setPreviewEditable(true);
    await p;
    await r;
    expect(pv.isPreviewEditable()).toBe(true);
    expect(hints()).toBe(1);
    pv.dispose();
  });

  it('a chunk that cannot be loaded: rejected, nothing installed, a second press rejects again, nothing unhandled', async () => {
    vi.resetModules();
    vi.doMock('../src/preview/inlineEdit', () => { throw new Error('chunk failed (test)'); });
    const { preview } = await fresh_noReset();
    const pv = preview();
    const before = unhandled.length;
    const p = pv.setPreviewEditable(true) as Promise<boolean>;
    await expect(p).rejects.toThrow();
    expect(hints()).toBe(0);
    expect(pv.isPreviewEditable()).toBe(false);
    const p2 = pv.setPreviewEditable(true) as Promise<boolean>;
    expect(p2).toBeInstanceOf(Promise);
    expect(p2).not.toBe(p);                                   // asked again (the browser answers from its module map)
    await expect(p2).rejects.toThrow();
    expect(pv.setPreviewEditable(false)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled.length - before).toBe(0);
    pv.dispose();
  });
});

async function fresh_noReset(): Promise<{ preview: () => PreviewApi }> {
  const { createPreview } = await import('../src/preview/createPreview');
  const { createBus } = await import('../src/shared/bus');
  return {
    preview: () => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      return createPreview({ parent, bus: createBus(), request: () => {}, viewport: () => {}, resync: () => {}, source: source() });
    },
  };
}
