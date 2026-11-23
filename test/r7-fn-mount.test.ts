// @vitest-environment jsdom
// test/r7-fn-mount.test.ts — fix-san (round 7), rule SAN (CONTRACT §11, Round-7 decisions): mounting ONE block never
// throws out of the mount of the others; a block whose sanitization throws shows as the render-error block (.md-error:
// the notice and the block's HTML as TEXT, never as markup), every other block mounts as usual.
//
// In Chromium `<?form>` is a processing instruction named "form", on which DOMPurify 3.4 throws "Illegal invocation"
// (its clobbering probe calls Element's `attributes` getter on it). jsdom's parser reads it as a comment and does not
// throw, so the throw is reproduced here by wrapping the real sanitizer: any payload holding `<?form` throws as in
// Chromium, everything else goes through the real sanitizeToFragment. bench/verify/r7-fn-san.mjs covers the real throw.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/preview/sanitize', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/preview/sanitize')>();
  return {
    ...real,
    sanitizeToFragment: (html: string): DocumentFragment => {
      if (/<\?form/i.test(html)) throw new TypeError('Illegal invocation');
      return real.sanitizeToFragment(html);
    },
  };
});

import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { HTML_FLAG_RESERVED, type PreviewApi } from '../src/shared/types';
import { htmlMsg, structureFrom } from './fixtures/fakeWorker';

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };
const NOTICE = '渲染此段落时出错：Illegal invocation';

class FakeResizeObserver {
  static failOn: string | null = null;
  constructor(public cb: unknown) {}
  observe(t: Element): void {
    if (FakeResizeObserver.failOn !== null && (t as HTMLElement).dataset.id === FakeResizeObserver.failOn) throw new Error('observe failed');
  }
  unobserve(): void { /* */ }
  disconnect(): void { /* */ }
}

function setup(clientHeight = 800): PreviewApi {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const pv = createPreview({ parent, bus: createBus(), request: vi.fn(), viewport: vi.fn(), resync: vi.fn() });
  Object.defineProperty(pv.el, 'clientHeight', { value: clientHeight, configurable: true });
  (pv.el as HTMLElement & { scrollTo(o: ScrollToOptions): void }).scrollTo = (o) => { pv.el.scrollTop = o.top ?? 0; };
  return pv;
}
const block = (pv: PreviewApi, id: number): HTMLElement => pv.el.querySelector<HTMLElement>(`.md-block[data-id="${id}"]`)!;

/** The render-error block, built from text only: exactly div.md-error > p + pre, the payload verbatim as the pre's text. */
function expectErrorBlock(w: HTMLElement, payload: string): void {
  expect(w.classList.contains('is-pending')).toBe(false);
  expect(w.childElementCount).toBe(1);
  const box = w.firstElementChild as HTMLElement;
  expect(box.tagName).toBe('DIV');
  expect(box.className).toBe('md-error');
  expect(Array.from(w.querySelectorAll('*'), (e) => e.tagName)).toEqual(['DIV', 'P', 'PRE']);
  expect(box.children[0].textContent).toBe(NOTICE);
  expect(box.children[1].textContent).toBe(payload);
  for (const e of Array.from(w.querySelectorAll('*'))) {
    expect(e.attributes.length, e.tagName).toBe(e === box ? 1 : 0);
    for (const c of Array.from(e.childNodes)) expect([1, 3]).toContain(c.nodeType);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  FakeResizeObserver.failOn = null;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); performance.clearMarks(); });

describe('rule SAN: a block the sanitizer cannot take', () => {
  it('the first render: the block shows the notice and its HTML as text, its neighbours mount', () => {
    const pv = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1], [3, 1]]));
    frame();
    const bad = '<p data-l="0"><?form><img src="x" onerror="alert(1)"><b>bold</b><script>s()</script></p>';
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p data-l="0">before</p>' }, { id: 2, flags: 0, payload: bad }, { id: 3, flags: 0, payload: '<p data-l="0">after</p>' }]));
    expect(() => frame()).not.toThrow();
    expect(block(pv, 1).innerHTML).toBe('<p data-l="0">before</p>');
    expect(block(pv, 3).innerHTML).toBe('<p data-l="0">after</p>');
    expectErrorBlock(block(pv, 2), bad);
    expect(pv.el.querySelector('img, b, script')).toBeNull();
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
  });

  it('many blocks, several of them bad, in one flush: every good block mounts, every bad one is the error block', () => {
    const pv = setup();
    const n = 40;
    const spec: Array<[number, number]> = Array.from({ length: n }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    frame();
    const payload = (id: number): string => (id % 7 === 3 ? `<div data-l="0">x <?FORM a="b"> ${id}</div>` : `<p data-l="0">p${id}</p>`);
    pv.applyHtml(htmlMsg(spec.map(([id]) => ({ id, flags: 0, payload: payload(id) }))));
    for (let k = 0; k < 4; k++) expect(() => frame()).not.toThrow();
    for (const [id] of spec) {
      const w = block(pv, id);
      if (id % 7 === 3) expectErrorBlock(w, payload(id));
      else expect(w.innerHTML, String(id)).toBe(`<p data-l="0">p${id}</p>`);
    }
  });

  it('a later update: a good block turns bad (error block), then good again (rendered again)', () => {
    const pv = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p data-l="0">one</p>' }, { id: 2, flags: 0, payload: '<p data-l="0">two</p>' }]));
    frame();
    expect(block(pv, 2).innerHTML).toBe('<p data-l="0">two</p>');
    pv.applyStructure(structureFrom([[1, 1], [2, 1]], 2, [2]));
    const bad = '<p data-l="0">two <?form ?> typed</p>';
    pv.applyHtml(htmlMsg([{ id: 2, flags: 0, payload: bad }], 2));
    expect(() => frame()).not.toThrow();
    expectErrorBlock(block(pv, 2), bad);
    expect(block(pv, 1).innerHTML).toBe('<p data-l="0">one</p>');
    pv.applyStructure(structureFrom([[1, 1], [2, 1]], 3, [2]));
    pv.applyHtml(htmlMsg([{ id: 2, flags: 0, payload: '<p data-l="0">two again</p>' }], 3));
    frame();
    expect(block(pv, 2).innerHTML).toBe('<p data-l="0">two again</p>');
    expect(pv.el.querySelector('.md-error')).toBeNull();
  });

  it('the reserved-name mark is still set on the error block; mountAll resolves', async () => {
    const pv = setup(10);
    const spec: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    frame();
    const done = vi.fn();
    void pv.mountAll().then(done);
    for (let i = 0; i < 4; i++) frame();
    const bad = '<p data-l="0" data-md="x"><?form></p>';
    pv.applyHtml(htmlMsg(spec.map(([id]) => (id === 5 ? { id, flags: HTML_FLAG_RESERVED, payload: bad } : { id, flags: 0, payload: `<p>${id}</p>` }))));
    for (let i = 0; i < 4; i++) frame();
    await Promise.resolve();
    expect(done).toHaveBeenCalled();
    expectErrorBlock(block(pv, 5), bad);
    expect(block(pv, 5).hasAttribute('data-mdr-x')).toBe(true);
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
  });

  it('whatever else throws while one block mounts, the others still mount (the error is thrown again on its own)', () => {
    const pv = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1], [3, 1]]));
    frame();
    FakeResizeObserver.failOn = '2';
    pv.applyHtml(htmlMsg([1, 2, 3].map((id) => ({ id, flags: 0, payload: `<p>b${id}</p>` }))));
    expect(() => frame()).toThrow('observe failed');   // the deferred re-throw, after the flush finished
    for (const id of [1, 2, 3]) expect(block(pv, id).innerHTML).toBe(`<p>b${id}</p>`);
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
  });
});
