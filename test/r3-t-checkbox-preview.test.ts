// @vitest-environment jsdom
// test/r3-t-checkbox-preview.test.ts — fix-trust (stage 2d, round 3): U16 (CONTRACT §11) through createPreview.
// interactions.ts checks a checkbox's line against its block's line range and the source line only when its deps
// provide lineCountOf / sourceLine; createPreview.ts (not fix-trust's file) must wire them. These cases FAIL until
// that wiring is in (fix-trust's request to integrate) and pass after it. The blocks are NOT flagged: U16 holds
// whatever the U10 flag says (a forgery the scan missed, simulated by HTML sent without HTML_FLAG_RESERVED).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import type { PreviewApi, PreviewSourceAccess } from '../src/shared/types';
import { htmlMsg, structureFrom } from './fixtures/fakeWorker';

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

// lines 1-2: block 1 (a task list); 3-4: block 2 (a paragraph and a blank line); 5-6: block 3 (a task list)
const LINES = ['- [ ] pay the rent', '- [ ] call the bank', 'Read the terms', '', '- [ ] sign the lease', ''];

function setup(): { pv: PreviewApi; edits: number[] } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const bus = createBus();
  const edits: number[] = [];
  bus.on('source:edit', (e) => { edits.push(e.line); });
  const source: PreviewSourceAccess = {
    read: (start, count) => LINES.slice(start - 1, start - 1 + count).join('\n'),
    replace: () => {},
  };
  const pv = createPreview({ parent, bus, request: () => {}, viewport: () => {}, resync: () => {}, source });
  Object.defineProperty(pv.el, 'clientHeight', { value: 800, configurable: true });
  pv.applyStructure(structureFrom([[1, 2], [2, 2], [3, 2]]));
  frame();
  return { pv, edits };
}
/** A real click: its press on the box (U24), then the click. */
const click = (b: HTMLInputElement): boolean => {
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  return !b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
};

describe('U16 through createPreview: the wrapper\'s own line range and the source line decide', () => {
  it('a forged data-l past the block (onto a task line of another block) and one onto a non-task line write nothing', () => {
    const { pv, edits } = setup();
    pv.applyHtml(htmlMsg([
      { id: 1, flags: 0, payload: '<ul data-l="0"><li class="task-list-item" data-l="0"><input type="checkbox"> pay the rent</li><li class="task-list-item" data-l="1"><input type="checkbox"> call the bank</li></ul>' },
      // block 2 starts at line 3: data-l 2 names line 5 (block 3's task), data-l 1 names line 4 (blank, no task)
      { id: 2, flags: 0, payload: '<p data-l="0">Read the terms <ul><li class="task-list-item" data-l="2"><input type="checkbox"> forged</li><li class="task-list-item" data-l="1"><input type="checkbox"> blank</li></ul></p>' },
      { id: 3, flags: 0, payload: '<ul data-l="0"><li class="task-list-item" data-l="0"><input type="checkbox"> sign the lease</li></ul>' },
    ]));
    frame();
    const [past, blank] = Array.from(pv.el.querySelectorAll<HTMLInputElement>('[data-id="2"] input'));
    expect(click(past)).toBe(true);
    expect(past.checked).toBe(false);
    expect(click(blank)).toBe(true);
    expect(edits).toEqual([]);
    const own = pv.el.querySelectorAll<HTMLInputElement>('[data-id="1"] input')[1];
    expect(click(own)).toBe(false);
    expect(edits).toEqual([2]);
  });
});
