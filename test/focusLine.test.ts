// @vitest-environment jsdom
// test/focusLine.test.ts — the focus line (CONTRACT §9): one subtle tint per pane, mirrored into the other.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { createPreview } from '../src/preview/createPreview';
import { pickFocusElement } from '../src/preview/focusLine';
import { createEditor, disposeEditor, type DisposableEditorApi } from '../src/editor/createEditor';
import { wireFocusLine } from '../src/app/focusLine';
import { createBus } from '../src/shared/bus';
import { BlockKind, type EventBus, type Line, type PreviewApi } from '../src/shared/types';
import { htmlMsg, structureFrom } from './fixtures/fakeWorker';
import { createFakeRegistry, installLayoutStubs } from './editor.helpers';

installLayoutStubs();

// ---------------------------------------------------------------- element choice
describe('pickFocusElement', () => {
  const wrapperOf = (html: string): HTMLElement => {
    const w = document.createElement('section');
    w.className = 'md-block';
    w.innerHTML = html;
    return w;
  };

  it('prefers the deepest element when nested elements share the same data-l', () => {
    const w = wrapperOf('<ul><li data-l="0"><p data-l="0">one</p></li><li data-l="1"><p data-l="1">two</p></li></ul>');
    expect(pickFocusElement(w, 0).tagName).toBe('P');
    expect(pickFocusElement(w, 0).textContent).toBe('one');
    expect(pickFocusElement(w, 1).textContent).toBe('two');
  });

  it('takes the largest data-l that does not pass the line (a fence tints its <pre>)', () => {
    const w = wrapperOf('<p data-l="0">intro</p><pre class="md-code" data-l="2"><code>a\nb\nc</code></pre>');
    expect(pickFocusElement(w, 0).tagName).toBe('P');
    expect(pickFocusElement(w, 1).tagName).toBe('P');       // still inside the paragraph's block lines
    expect(pickFocusElement(w, 2).tagName).toBe('PRE');
    expect(pickFocusElement(w, 5).tagName).toBe('PRE');      // a line inside the fence
  });

  it('falls back to the wrapper when nothing is marked or nothing precedes the line', () => {
    const bare = wrapperOf('<hr>');
    expect(pickFocusElement(bare, 3)).toBe(bare);
    const later = wrapperOf('<p data-l="4">late</p>');
    expect(pickFocusElement(later, 0)).toBe(later);
    expect(pickFocusElement(bare, Number.NaN)).toBe(bare);
  });
});

// ---------------------------------------------------------------- preview side
const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };
const focusEls = (pv: PreviewApi): HTMLElement[] => Array.from(pv.el.querySelectorAll<HTMLElement>('.is-focus'));

class FakeResizeObserver {
  observe(): void { /* no layout in jsdom */ }
  unobserve(): void { /* ditto */ }
  disconnect(): void { /* ditto */ }
}

function setupPreview(): { pv: PreviewApi; bus: EventBus; request: ReturnType<typeof vi.fn> } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const bus = createBus();
  const request = vi.fn();
  const pv = createPreview({ parent, bus, request, viewport: vi.fn(), resync: vi.fn() });
  Object.defineProperty(pv.el, 'clientHeight', { value: 800, configurable: true });
  return { pv, bus, request };
}

describe('preview setFocusLine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKED] });
    const base = Date.now();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); performance.clearMarks(); });

  /** Two blocks: lines 1-3 (a list) and lines 4-6 (a paragraph + fence). */
  const load = (pv: PreviewApi): void => {
    pv.applyStructure(structureFrom([[1, 3, BlockKind.List], [2, 3, BlockKind.Prose]]));
    frame();
  };
  const mount = (pv: PreviewApi): void => {
    pv.applyHtml(htmlMsg([
      { id: 1, flags: 0, payload: '<ul><li data-l="0"><p data-l="0">one</p></li><li data-l="2"><p data-l="2">two</p></li></ul>' },
      { id: 2, flags: 0, payload: '<p data-l="0">para</p><pre class="md-code" data-l="1"><code>x</code></pre>' },
    ]));
    frame(); frame();
  };

  it('tints exactly one element, the innermost one covering the line', () => {
    const { pv } = setupPreview();
    load(pv);
    mount(pv);
    pv.setFocusLine(3);
    expect(focusEls(pv).map((e) => e.textContent)).toEqual(['two']);
    pv.setFocusLine(5);
    const hit = focusEls(pv);
    expect(hit).toHaveLength(1);
    expect(hit[0].tagName).toBe('PRE');
    pv.setFocusLine(null);
    expect(focusEls(pv)).toHaveLength(0);
  });

  it('re-applies the tint when the focused block mounts later', () => {
    const { pv } = setupPreview();
    load(pv);
    pv.setFocusLine(4);
    // Nothing is mounted yet: the pending wrapper carries the tint.
    expect(focusEls(pv)).toHaveLength(1);
    expect(focusEls(pv)[0].classList.contains('md-block')).toBe(true);
    mount(pv);
    frame();
    const hit = focusEls(pv);
    expect(hit).toHaveLength(1);
    expect(hit[0].tagName).toBe('P');
    expect(hit[0].textContent).toBe('para');
  });

  it('re-applies the tint when the focused block is re-rendered', () => {
    const { pv } = setupPreview();
    load(pv);
    mount(pv);
    pv.setFocusLine(5);
    expect(focusEls(pv)[0].tagName).toBe('PRE');
    pv.applyHtml(htmlMsg([{ id: 2, flags: 0, payload: '<p data-l="0">para</p><pre class="md-code" data-l="1"><code>y</code></pre>' }], 2));
    frame(); frame();
    const hit = focusEls(pv);
    expect(hit).toHaveLength(1);
    expect(hit[0].tagName).toBe('PRE');
    expect(hit[0].isConnected).toBe(true);
  });

  it('ignores non-finite input and clamps a line past the end into the last block', () => {
    const { pv } = setupPreview();
    load(pv);
    mount(pv);
    pv.setFocusLine(3);
    expect(focusEls(pv).map((e) => e.textContent)).toEqual(['two']);
    pv.setFocusLine(Number.NaN);          // no-op: keeps what is shown
    expect(focusEls(pv).map((e) => e.textContent)).toEqual(['two']);
    pv.setFocusLine(9_999);               // past the end: the last block, never more than one element
    const hit = focusEls(pv);
    expect(hit).toHaveLength(1);
    expect(hit[0].closest('.md-block')?.dataset.id).toBe('2');
  });

  /** Selects the whole contents of `node` and delivers the `selectionchange` jsdom does not fire. */
  const selectContents = (node: Node): void => {
    const sel = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  };

  it('re-announces a selection on a line the editor took over in the meantime', () => {
    const { pv, bus } = setupPreview();
    const seen: Array<{ line: Line; source: string }> = [];
    bus.on('focus:line', (e) => seen.push(e));
    load(pv);
    mount(pv);
    const para = pv.el.querySelector<HTMLElement>('.md-block[data-id="2"] p')!;
    selectContents(para);
    frame();
    expect(seen).toEqual([{ line: 4, source: 'preview' }]);
    // The same selection again while nothing moved: coalesced away (dragging fires this per mouse move).
    selectContents(para);
    frame();
    expect(seen).toHaveLength(1);
    // The editor takes the focus line over — the preview's tint moves with it.
    pv.setFocusLine(1);
    expect(focusEls(pv)[0].textContent).toBe('one');
    // Re-selecting the same text is a fresh gesture now, and both panes must follow it again.
    selectContents(para);
    frame();
    expect(seen).toEqual([{ line: 4, source: 'preview' }, { line: 4, source: 'preview' }]);
    expect(focusEls(pv)).toEqual([para]);
  });

  it('schedules no frame for a selection outside the preview (the editor caret)', () => {
    const { pv, bus } = setupPreview();
    const seen: unknown[] = [];
    bus.on('focus:line', (e) => seen.push(e));
    load(pv);
    mount(pv);
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame');
    selectContents(outside);
    expect(raf).not.toHaveBeenCalled();
    frame();
    expect(seen).toEqual([]);
    expect(focusEls(pv)).toHaveLength(0);
  });

  it('a click in the preview tints here and announces the line on the bus', () => {
    const { pv, bus } = setupPreview();
    const seen: Array<{ line: Line; source: string }> = [];
    bus.on('focus:line', (e) => seen.push(e));
    load(pv);
    mount(pv);
    const target = pv.el.querySelector<HTMLElement>('.md-block[data-id="2"] pre')!;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(seen).toEqual([{ line: 5, source: 'preview' }]);
    expect(focusEls(pv)).toEqual([target]);
  });
});

// ---------------------------------------------------------------- editor side
describe('editor setPeerLine', () => {
  const setup = (doc: string) => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const editor = createEditor({ parent, bus: createBus(), registry: createFakeRegistry(), theme: 'light' }) as DisposableEditorApi;
    editor.setDoc(doc);
    return { editor, parent };
  };
  const peerLines = (editor: DisposableEditorApi): string[] =>
    Array.from(editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-peerLine'), (e) => e.textContent ?? '');

  afterEach(() => { document.body.replaceChildren(); });

  it('decorates the line and marks the editor so the caret line stands down', () => {
    const { editor } = setup('one\ntwo\nthree\nfour');
    editor.setPeerLine(3);
    expect(peerLines(editor)).toEqual(['three']);
    expect(editor.view.dom.classList.contains('mdr-peer-active')).toBe(true);
    // No caret move, no focus stolen.
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.hasFocus()).toBe(false);
    editor.setPeerLine(null);
    expect(peerLines(editor)).toEqual([]);
    expect(editor.view.dom.classList.contains('mdr-peer-active')).toBe(false);
    disposeEditor(editor);
  });

  it('is cleared by a user selection transaction', () => {
    const { editor } = setup('one\ntwo\nthree\nfour');
    editor.setPeerLine(2);
    expect(peerLines(editor)).toEqual(['two']);
    editor.view.dispatch({ selection: EditorSelection.single(editor.view.state.doc.line(4).from) });
    expect(peerLines(editor)).toEqual([]);
    expect(editor.view.dom.classList.contains('mdr-peer-active')).toBe(false);
    disposeEditor(editor);
  });

  it('clamps out-of-range lines and ignores NaN', () => {
    const { editor } = setup('one\ntwo\nthree');
    editor.setPeerLine(99);
    expect(peerLines(editor)).toEqual(['three']);
    editor.setPeerLine(0);
    expect(peerLines(editor)).toEqual(['one']);
    editor.setPeerLine(Number.NaN);
    expect(peerLines(editor)).toEqual([]);
    disposeEditor(editor);
  });

  it('survives typing in another line and follows the edit', () => {
    const { editor } = setup('one\ntwo\nthree');
    editor.setPeerLine(3);
    editor.view.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });
    expect(peerLines(editor)).toEqual(['three']);
    disposeEditor(editor);
  });
});

// ---------------------------------------------------------------- app wiring
describe('wireFocusLine', () => {
  function harness(hasFocus = true) {
    const bus = createBus();
    const peer: Array<Line | null> = [];
    const focus: Array<Line | null> = [];
    const editor = { hasFocus: () => hasFocus, setPeerLine: (l: Line | null) => peer.push(l) };
    const preview = { setFocusLine: (l: Line | null) => focus.push(l) };
    return { bus, peer, focus, wiring: wireFocusLine(bus, editor, preview) };
  }

  it('mirrors the editor caret into the preview while the editor has focus', () => {
    const { bus, focus, peer } = harness(true);
    bus.emit('doc:cursor', { line: 7, col: 0, typing: false });
    expect(focus).toEqual([7]);
    expect(peer).toEqual([]);
  });

  it('mirrors a typing cursor even when the editor is not focused, but not a programmatic move', () => {
    const { bus, focus } = harness(false);
    bus.emit('doc:cursor', { line: 4, col: 0, typing: false });
    expect(focus).toEqual([]);
    bus.emit('doc:cursor', { line: 4, col: 0, typing: true });
    expect(focus).toEqual([4]);
  });

  it('mirrors a preview focus into the editor as a peer line', () => {
    const { bus, peer, focus } = harness(true);
    bus.emit('focus:line', { line: 12, source: 'preview' });
    expect(peer).toEqual([12]);
    expect(focus).toEqual([]);
  });

  it('reset() clears both panes and swallows the cursor event setDoc schedules', () => {
    const { bus, peer, focus, wiring } = harness(true);
    wiring.reset();
    expect(peer).toEqual([null]);
    expect(focus).toEqual([null]);
    bus.emit('doc:cursor', { line: 1, col: 0, typing: false });   // the one setDoc caused
    expect(focus).toEqual([null]);
    bus.emit('doc:cursor', { line: 2, col: 0, typing: false });   // the user, afterwards
    expect(focus).toEqual([null, 2]);
  });

  it('reassert() puts the last focus line back after a programmatic editor focus', () => {
    const { bus, peer, focus, wiring } = harness(true);
    bus.emit('focus:line', { line: 3, source: 'preview' });
    expect(peer).toEqual([3]);
    // What a mode switch does: editor.focus() → the editor drops the mirror by itself.
    peer.length = 0;
    wiring.reassert();
    expect(peer).toEqual([3]);
    expect(focus).toEqual([]);
    // The editor owning the line is re-applied on the preview side instead.
    bus.emit('focus:line', { line: 9, source: 'editor' });
    wiring.reassert();
    expect(focus).toEqual([9, 9]);
    expect(peer).toEqual([3]);
  });

  it('reassert() does nothing before any focus and after reset()', () => {
    const { bus, peer, focus, wiring } = harness(true);
    wiring.reassert();
    expect(peer).toEqual([]);
    expect(focus).toEqual([]);
    bus.emit('focus:line', { line: 5, source: 'preview' });
    wiring.reset();
    peer.length = 0; focus.length = 0;
    wiring.reassert();
    expect(peer).toEqual([]);
    expect(focus).toEqual([]);
  });

  it('a cursor event caused by a preview write never claims the focus line, focused or not', () => {
    const bus = createBus();
    const focus: Array<Line | null> = [];
    let fromPreview = true;
    let focused = true;
    wireFocusLine(bus, { hasFocus: () => focused, setPeerLine: () => {} }, { setFocusLine: (l) => focus.push(l) }, {
      previewWrite: () => fromPreview,
    });
    bus.emit('doc:cursor', { line: 4, col: 0, typing: false });
    focused = false;
    bus.emit('doc:cursor', { line: 4, col: 0, typing: true });
    expect(focus).toEqual([]);
    fromPreview = false;
    bus.emit('doc:cursor', { line: 6, col: 0, typing: true });
    expect(focus).toEqual([6]);
  });

  it('while a preview session is live an unfocused typing event (a checkbox write) does not claim it either', () => {
    const bus = createBus();
    const focus: Array<Line | null> = [];
    let editing = true;
    wireFocusLine(bus, { hasFocus: () => false, setPeerLine: () => {} }, { setFocusLine: (l) => focus.push(l) }, {
      previewEditing: () => editing,
    });
    bus.emit('doc:cursor', { line: 2, col: 0, typing: true });
    expect(focus).toEqual([]);
    editing = false;
    bus.emit('doc:cursor', { line: 2, col: 0, typing: true });
    expect(focus).toEqual([2]);
  });

  it('off() unsubscribes both handlers', () => {
    const { bus, peer, focus, wiring } = harness(true);
    wiring.off();
    bus.emit('doc:cursor', { line: 3, col: 0, typing: true });
    bus.emit('focus:line', { line: 3, source: 'preview' });
    expect(focus).toEqual([]);
    expect(peer).toEqual([]);
  });
});
