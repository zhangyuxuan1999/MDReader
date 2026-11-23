// @vitest-environment jsdom
// fix-session-1, decision U12 (call site): when baselineFaithful() says the serializer's Markdown for the
// untouched block does not render as the block shows, begin() undoes what it did (data-mdr-o marks, the
// formulas' contenteditable=false), the block is refused with 此块请在源码中编辑 and no session starts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ ok: true, calls: [] as string[] }));
vi.mock('../src/preview/fidelity', () => ({
  FIDELITY_GATE: true,
  baselineFaithful: (_b: Element, _k: number, baseline: string) => { gate.calls.push(baseline); return gate.ok; },
  sanitizerKept: () => true,
  renderedShows: () => null,
}));

import { createPreview } from '../src/preview/createPreview';
import { NOT_EDITABLE_TEXT } from '../src/preview/inlineEdit';
import { createBus } from '../src/shared/bus';
import type { PreviewApi, PreviewSourceAccess, ToastSpec } from '../src/shared/types';
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
  gate.ok = true;
  gate.calls = [];
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(): { pv: PreviewApi; toasts: ToastSpec[]; sessions: Array<number | null> } {
  const lines = ['a <span class="x">b</span>', '', 'next', ''];
  const source: PreviewSourceAccess = { read: (s, c) => lines.slice(s - 1, s - 1 + c).join('\n'), replace: () => {} };
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const bus = createBus();
  const toasts: ToastSpec[] = [];
  const sessions: Array<number | null> = [];
  bus.on('toast', (t) => { toasts.push(t); });
  bus.on('previewEdit:session', (e) => { sessions.push(e.id); });
  const pv = createPreview({ parent, bus, request: () => {}, viewport: () => {}, resync: () => {}, source });
  Object.defineProperty(pv.el, 'clientHeight', { value: 800, configurable: true });
  pv.setPreviewEditable(true);
  pv.applyStructure(structureFrom([[1, 2], [2, 2]]));
  frame();
  pv.applyHtml(htmlMsg([
    { id: 1, flags: 0, payload: '<p data-l="0">a <span class="x">b</span> <span class="md-math md-math--inline">x</span></p>' },
    { id: 2, flags: 0, payload: '<p data-l="0">next</p>' },
  ]));
  frame();
  return { pv, toasts, sessions };
}
function click(t: Element): void {
  for (const type of ['mousedown', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

describe('U12 baseline fidelity gate — call site in begin()', () => {
  it('a faithful baseline: the session starts (the gate saw the baseline)', () => {
    const { pv, sessions } = setup();
    const w = pv.el.querySelector<HTMLElement>('section.md-block[data-id="1"]')!;
    click(w.querySelector('p')!.firstChild!.parentElement!);
    expect(gate.calls.length).toBe(1);
    expect(w.classList.contains('is-editing')).toBe(true);
    expect(sessions).toEqual([1]);
  });

  it('an unfaithful baseline: refused with the toast, nothing of the session left on the block', () => {
    gate.ok = false;
    const { pv, toasts, sessions } = setup();
    const w = pv.el.querySelector<HTMLElement>('section.md-block[data-id="1"]')!;
    click(w.querySelector('p')!);
    expect(gate.calls.length).toBe(1);
    expect(w.classList.contains('is-editing')).toBe(false);
    expect(w.hasAttribute('contenteditable')).toBe(false);
    expect(w.querySelectorAll('[data-mdr-o]').length).toBe(0);
    expect(w.querySelector('.md-math')!.hasAttribute('contenteditable')).toBe(false);
    expect(toasts.map((t) => t.text)).toEqual([NOT_EDITABLE_TEXT]);
    expect(sessions).toEqual([]);
  });
});
