// @vitest-environment jsdom
// fix-session-1, decision U10(b): createPreview puts data-mdr-x on a block wrapper at every mount of a block
// whose HTML flags carry HTML_FLAG_RESERVED, and removes it at every mount without it — on the normal,
// PLAIN and TRUSTED paths and for HTML held back during an edit session and mounted when it ends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { HTML_FLAG_PLAIN, HTML_FLAG_RESERVED, HTML_FLAG_TRUSTED, type PreviewApi, type PreviewSourceAccess } from '../src/shared/types';
import { htmlMsg, structureFrom } from './fixtures/fakeWorker';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };
class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(source?: PreviewSourceAccess): PreviewApi {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const pv = createPreview({ parent, bus: createBus(), request: () => {}, viewport: () => {}, resync: () => {}, source });
  Object.defineProperty(pv.el, 'clientHeight', { value: 800, configurable: true });
  pv.applyStructure(structureFrom([[1, 2], [2, 2]]));
  frame();
  return pv;
}
const wrap = (pv: PreviewApi, id: number): HTMLElement => pv.el.querySelector<HTMLElement>(`section.md-block[data-id="${id}"]`)!;

describe('U10(b) data-mdr-x follows HTML_FLAG_RESERVED at every mount', () => {
  it('normal path: set with the flag, removed by a later mount without it', () => {
    const pv = setup();
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_RESERVED, payload: '<p data-l="0">a <span class="md-math">x</span></p>' }, { id: 2, flags: 0, payload: '<p>b</p>' }]));
    frame();
    expect(wrap(pv, 1).hasAttribute('data-mdr-x')).toBe(true);
    expect(wrap(pv, 2).hasAttribute('data-mdr-x')).toBe(false);
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>a</p>' }, { id: 2, flags: HTML_FLAG_RESERVED, payload: '<p class="md-x">b</p>' }], 2));
    frame();
    expect(wrap(pv, 1).hasAttribute('data-mdr-x')).toBe(false);
    expect(wrap(pv, 2).hasAttribute('data-mdr-x')).toBe(true);
  });

  it('PLAIN and TRUSTED paths', () => {
    const pv = setup();
    pv.applyHtml(htmlMsg([
      { id: 1, flags: HTML_FLAG_PLAIN | HTML_FLAG_RESERVED, payload: 'plain <b data-md="x">text</b>' },
      { id: 2, flags: HTML_FLAG_TRUSTED | HTML_FLAG_RESERVED, payload: '<p>trusted</p>' },
    ]));
    frame();
    expect(wrap(pv, 1).hasAttribute('data-mdr-x')).toBe(true);
    expect(wrap(pv, 2).hasAttribute('data-mdr-x')).toBe(true);
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_PLAIN, payload: 'plain' }, { id: 2, flags: HTML_FLAG_TRUSTED, payload: '<p>t</p>' }], 2));
    frame();
    expect(wrap(pv, 1).hasAttribute('data-mdr-x')).toBe(false);
    expect(wrap(pv, 2).hasAttribute('data-mdr-x')).toBe(false);
  });

  it('HTML held back during an edit session gets the attribute when it mounts at the session end', () => {
    const lines = ['para', '', 'next', ''];
    const source: PreviewSourceAccess = {
      read: (s, c) => lines.slice(s - 1, s - 1 + c).join('\n'),
      replace: () => {},
    };
    const pv = setup(source);
    pv.setPreviewEditable(true);
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p data-l="0">para</p>' }, { id: 2, flags: 0, payload: '<p data-l="0">next</p>' }]));
    frame();
    const w = wrap(pv, 1);
    const p = w.querySelector('p')!;
    p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(w.classList.contains('is-editing')).toBe(true);
    // a payload with the flag arrives while editing: held, the wrapper is unchanged
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_RESERVED, payload: '<p data-l="0" data-mdr-ui="">para</p>' }], 2));
    frame();
    expect(w.querySelector('p')).toBe(p);
    expect(w.hasAttribute('data-mdr-x')).toBe(false);
    pv.endEditSession();
    frame();
    expect(w.querySelector('p')).not.toBe(p);
    expect(w.hasAttribute('data-mdr-x')).toBe(true);
  });
});
