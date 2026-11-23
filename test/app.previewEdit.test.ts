// @vitest-environment jsdom
// In-preview editing, the App half (CONTRACT §11): PreviewOptions.source wired to CodeMirror, the
// 「预览可编辑」 toggle (persisted; off by default for a user, on where the test hooks are installed: the
// release decision for 0.2.0) and how App's flows interact with a live session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, isolateHistory, undo } from '@codemirror/commands';
import { createBus } from '../src/shared/bus';
import { LS_PREVIEW_EDIT, type AppEvents, type OpenedFile, type PreviewApi, type PreviewOptions, type SaveResult } from '../src/shared/types';
import {
  commonEnds,
  createPreviewEdit,
  createSourceAccess,
  previewWriteGate,
  parsePreviewEditPref,
  PREVIEW_EDIT_USER_EVENT,
  shortcutKeyEvent,
} from '../src/app/previewEdit';
import { matchShortcut } from '../src/shared/keys';
import { installLayoutStubs } from './editor.helpers';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

installLayoutStubs();

// ------------------------------------------------------------------------------------------ source

function view(doc: string, head = 0): { view: EditorView; trs: Transaction[] } {
  const trs: Transaction[] = [];
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(head),
      extensions: [history(), EditorView.updateListener.of((u) => trs.push(...u.transactions))],
    }),
  });
  return { view: v, trs };
}

describe('createSourceAccess (PreviewOptions.source → CodeMirror)', () => {
  beforeEach(() => document.body.replaceChildren());

  it('read returns exactly the requested lines, "\\n"-joined, no trailing newline', () => {
    const { view: v } = view('a\nb\n\nc\nd');
    const src = createSourceAccess({ view: v });
    expect(src.read(1, 1)).toBe('a');
    expect(src.read(2, 3)).toBe('b\n\nc');
    expect(src.read(3, 1)).toBe('');           // a blank line is an empty string, not a missing one
    expect(src.read(1, 5)).toBe('a\nb\n\nc\nd');
    // Clamped to the document; impossible ranges read as ''.
    expect(src.read(4, 10)).toBe('c\nd');
    expect(src.read(9, 1)).toBe('');
    expect(src.read(1, 0)).toBe('');
  });

  it('replace swaps the lines for more or fewer lines in ONE tagged transaction', () => {
    const { view: v, trs } = view('# t\n\npara one\npara two\n\nnext');
    const src = createSourceAccess({ view: v });
    src.replace(3, 2, 'para **one**  \npara two\nthree');
    expect(v.state.doc.toString()).toBe('# t\n\npara **one**  \npara two\nthree\n\nnext');
    expect(trs).toHaveLength(1);
    const tr = trs[0];
    expect(tr.annotation(Transaction.userEvent)).toBe(PREVIEW_EDIT_USER_EVENT);
    expect(tr.isUserEvent('input')).toBe(true);
    expect(tr.scrollIntoView).toBe(false);

    src.replace(3, 3, 'short');
    expect(v.state.doc.toString()).toBe('# t\n\nshort\n\nnext');
    expect(trs).toHaveLength(2);
  });

  it("keeps the caller's trailing blank lines verbatim (the block's original separator)", () => {
    const { view: v } = view('p1\n\n\np2');
    const src = createSourceAccess({ view: v });
    // Block = lines 1..3 ("p1" + two blank lines); the preview re-appends them to its serialization.
    expect(src.read(1, 3)).toBe('p1\n\n');
    src.replace(1, 3, 'p1 *edited*\n\n');
    expect(v.state.doc.toString()).toBe('p1 *edited*\n\n\np2');
  });

  it('never scrolls and never moves focus', () => {
    const { view: v, trs } = view('x\n'.repeat(50) + 'end');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const src = createSourceAccess({ view: v });
    src.replace(40, 1, 'changed');
    expect(document.activeElement).toBe(outside);
    expect(v.hasFocus).toBe(false);
    expect(trs.every((t) => !t.scrollIntoView)).toBe(true);
    expect(trs.every((t) => t.effects.length === 0)).toBe(true);   // no scrollIntoView effect either
  });

  // Finding high 1 (docs/FINDINGS-inline-r1.md): the user is editing THAT block, so the editor caret — and with
  // it the status bar line, the TOC's active entry — must report it, wherever CodeMirror's caret sat before
  // (line 1 right after opening a file). Its trailing blank lines (the block's separator) are excluded.
  it('moves the caret to the end of the written block content, wherever it was before', () => {
    const doc = 'aaa\nbbb\nccc\nddd';
    // Inside (line 2) → end of the new text.
    let t = view(doc, 5);
    createSourceAccess({ view: t.view }).replace(2, 2, 'B\nCC\nX');
    expect(t.view.state.selection.main.head).toBe(4 + 'B\nCC\nX'.length);
    // Before the range (line 1, the state right after opening a file) → moved into the block.
    t = view(doc, 1);
    createSourceAccess({ view: t.view }).replace(2, 2, 'B');
    expect(t.view.state.doc.toString()).toBe('aaa\nB\nddd');
    expect(t.view.state.selection.main.head).toBe(5);
    expect(t.view.state.doc.lineAt(5).number).toBe(2);
    // After the range → moved into the block as well.
    t = view(doc, 13);                         // "ddd" col 1
    createSourceAccess({ view: t.view }).replace(2, 2, 'B');
    expect(t.view.state.selection.main.head).toBe(5);
    // Trailing blank lines (the block's separator, re-appended by the session) are not "the block".
    t = view('p1\n\n\np2', 6);                  // caret on "p2" col 1 (after the range)
    createSourceAccess({ view: t.view }).replace(1, 3, 'p1 *e*\n\n');
    expect(t.view.state.doc.toString()).toBe('p1 *e*\n\n\np2');
    expect(t.view.state.selection.main.head).toBe('p1 *e*'.length);
    // A block whose new text spans several lines → its last content line (an Enter split: both halves).
    t = view('one two\n\nnext', 0);
    createSourceAccess({ view: t.view }).replace(1, 2, 'one\n\ntwo\n');
    expect(t.view.state.doc.toString()).toBe('one\n\ntwo\n\nnext');
    const head = t.view.state.selection.main.head;
    expect(t.view.state.doc.lineAt(head).number).toBe(3);
    expect(head - t.view.state.doc.line(3).from).toBe(3);
  });

  // G14: a session that ends because the user clicked into the editor writes while the editor has the focus;
  // the caret the user just placed there must not jump back to the edited block.
  it('keeps the user\'s editor selection (mapped through the change) while the editor has the focus', () => {
    const doc = '甲段落文字。\n\n乙段落文字。\n\n丙段落文字。';
    const { view: v } = view(doc, doc.length);          // caret at the end of 丙
    v.contentDOM.focus();
    expect(v.hasFocus).toBe(true);
    createSourceAccess({ view: v }).replace(1, 1, '甲段落文字。ni');
    expect(v.state.doc.toString()).toBe('甲段落文字。ni\n\n乙段落文字。\n\n丙段落文字。');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    // A deletion before the caret maps it back by the deleted length; a selection stays a selection.
    v.dispatch({ selection: EditorSelection.range(v.state.doc.length - 6, v.state.doc.length) });
    createSourceAccess({ view: v }).replace(1, 2, '');
    expect(v.state.doc.sliceString(v.state.selection.main.from, v.state.selection.main.to)).toBe('丙段落文字。');
  });

  it('writes nothing when the text is unchanged (no empty version bump)', () => {
    const { view: v, trs } = view('one\ntwo');
    createSourceAccess({ view: v }).replace(2, 1, 'two');
    expect(trs).toHaveLength(0);
  });

  it('refuses a range that no longer fits the document (console.warn, no write)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { view: v, trs } = view('one\ntwo');
    const src = createSourceAccess({ view: v });
    src.replace(2, 5, 'x');
    src.replace(0, 1, 'x');
    src.replace(1, 0, 'x');
    expect(trs).toHaveLength(0);
    expect(v.state.doc.toString()).toBe('one\ntwo');
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('consecutive preview writes group into one undo step, like typing in the editor', () => {
    const { view: v } = view('hello\n\nnext');
    const src = createSourceAccess({ view: v });
    src.replace(1, 1, 'hello w');
    src.replace(1, 1, 'hello wo');
    src.replace(1, 1, 'hello world');
    expect(v.state.doc.toString()).toBe('hello world\n\nnext');
    undo(v);
    expect(v.state.doc.toString()).toBe('hello\n\nnext');
  });
});

describe('createSourceAccess.history (decision U1: ⌘Z / ⇧⌘Z in a session go through the source)', () => {
  beforeEach(() => document.body.replaceChildren());

  it('three preview writes within a burst are undone by ONE history(false); redo puts them back', () => {
    const { view: v } = view('hello\n\nnext');
    const writes = vi.fn();
    const src = createSourceAccess({ view: v }, writes);
    src.replace(1, 1, 'hello w');
    src.replace(1, 1, 'hello wo');
    src.replace(1, 1, 'hello world');
    expect(writes).toHaveBeenCalledTimes(3);
    // Undone typing: the caret goes back to where the typing began (line 1, after "hello").
    expect(src.history!(false)).toEqual({ line: 1, col: 5 });
    expect(v.state.doc.toString()).toBe('hello\n\nnext');
    expect(writes).toHaveBeenCalledTimes(4);
    expect(src.history!(false)).toBeNull();                       // nothing older
    // Redone typing: after it.
    expect(src.history!(true)).toEqual({ line: 1, col: 11 });
    expect(v.state.doc.toString()).toBe('hello world\n\nnext');
    expect(src.history!(true)).toBeNull();
    expect(writes).toHaveBeenCalledTimes(5);
  });

  it('null on an empty history (nothing written, onWrite not called)', () => {
    const { view: v, trs } = view('a\n\nb');
    const writes = vi.fn();
    const src = createSourceAccess({ view: v }, writes);
    expect(src.history!(false)).toBeNull();
    expect(src.history!(true)).toBeNull();
    expect(trs).toHaveLength(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns the position inside the block that changed, deep in the document (an Enter split is undone too)', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `para ${i + 1}`);
    lines[29] = 'one two';
    const { view: v } = view(lines.join('\n\n'), 0);   // caret on line 1, as right after opening a file
    const src = createSourceAccess({ view: v });
    const at = 59;                                       // "one two" is line 59 (paragraphs every 2 lines)
    expect(v.state.doc.line(at).text).toBe('one two');
    src.replace(at, 2, 'one\n\ntwo\n');                // Enter after "one": two paragraphs
    expect(v.state.doc.line(at + 2).text).toBe('two');
    const pos = src.history!(false)!;
    expect(v.state.doc.line(at).text).toBe('one two');
    expect(pos.line).toBe(at);
    expect(pos.col).toBeGreaterThanOrEqual(3);
    expect(pos.col).toBeLessThanOrEqual(4);
  });

  it('a write in another block is its own step', () => {
    const { view: v } = view('aaa\n\nbbb\n\nccc');
    const src = createSourceAccess({ view: v });
    src.replace(1, 1, 'aaaX');
    src.replace(5, 1, 'cccY');
    expect(src.history!(false)).toEqual({ line: 5, col: 3 });
    expect(v.state.doc.toString()).toBe('aaaX\n\nbbb\n\nccc');
    expect(src.history!(false)).toEqual({ line: 1, col: 3 });
    expect(v.state.doc.toString()).toBe('aaa\n\nbbb\n\nccc');
  });

  it('never scrolls and never moves focus (the same gate as a write)', () => {
    const { view: v, trs } = view('x\n'.repeat(50) + 'end');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const src = createSourceAccess({ view: v });
    src.replace(40, 1, 'changed');
    expect(src.history!(false)).toEqual({ line: 40, col: 1 });   // after the restored "x"
    expect(src.history!(true)).toEqual({ line: 40, col: 7 });
    expect(document.activeElement).toBe(outside);
    expect(v.hasFocus).toBe(false);
    expect(trs).toHaveLength(3);
    expect(trs.every((t) => !t.scrollIntoView)).toBe(true);
    expect(trs.map((t) => t.annotation(Transaction.userEvent))).toEqual([PREVIEW_EDIT_USER_EVENT, 'undo', 'redo']);
  });
});

describe('replace writes only what differs (history records what was typed)', () => {
  it('commonEnds: prefix / suffix lengths, never overlapping, never splitting a surrogate pair', () => {
    expect(commonEnds('hello', 'hello world')).toEqual([5, 0]);
    expect(commonEnds('abc', 'abc')).toEqual([3, 0]);
    expect(commonEnds('aXa', 'aYa')).toEqual([1, 1]);
    expect(commonEnds('aaa', 'aa')).toEqual([2, 0]);
    expect(commonEnds('', 'x')).toEqual([0, 0]);
    // '😀' = \ud83d\ude00 and '😃' = \ud83d\ude03 share the high surrogate: the pair stays whole.
    expect(commonEnds('a😀', 'a😃')).toEqual([1, 0]);
    expect(commonEnds('😀b', '😃b')[1]).toBe(1);
    expect(commonEnds('x\ude00', 'y\ude00')[1]).toBe(0);
  });

  it('the transaction changes only the differing range', () => {
    const { view: v, trs } = view('# t\n\nThe quick fox\n\nnext');
    createSourceAccess({ view: v }).replace(3, 1, 'The quick brown fox');
    const ranges: number[][] = [];
    trs[0].changes.iterChanges((fa, ta, fb, tb, ins) => ranges.push([fa, ta, fb, tb, ins.length]));
    const at = '# t\n\nThe quick '.length;
    expect(ranges).toEqual([[at, at, at, at + 'brown '.length, 'brown '.length]]);
    expect(v.state.doc.toString()).toBe('# t\n\nThe quick brown fox\n\nnext');
  });

  it('\\r\\n in the written text is measured as CodeMirror stores it', () => {
    const { view: v } = view('p\n\nq');
    createSourceAccess({ view: v }).replace(1, 1, 'p1\r\np2');
    expect(v.state.doc.toString()).toBe('p1\np2\n\nq');
    expect(v.state.selection.main.head).toBe('p1\np2'.length);
  });
});

// ------------------------------------------------------------------------------------------ toggle

function fakeStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { data, read: (k: string) => data.get(k) ?? null, write: (k: string, v: string) => void data.set(k, v) };
}

describe('previewWriteGate (a preview write\'s late cursor event is not the user\'s)', () => {
  it('consume() reports a write once', () => {
    const g = previewWriteGate();
    expect(g.consume()).toBe(false);
    g.note();
    g.note();
    expect(g.consume()).toBe(true);
    expect(g.consume()).toBe(false);
  });
});

describe('createPreviewEdit (the 预览可编辑 toggle and the session flag)', () => {
  it('defaultOn true (test hooks installed): ON and applied to the preview at startup without persisting', () => {
    const bus = createBus();
    const seen: boolean[] = [];
    bus.on('previewEdit:changed', (on) => seen.push(on));
    const preview = { setPreviewEditable: vi.fn(), endEditSession: vi.fn(), flushEditSession: vi.fn() };
    const store = fakeStore();
    const toggled: boolean[] = [];
    const ctl = createPreviewEdit({ bus, preview, ...store, onToggle: (on) => toggled.push(on), defaultOn: true });
    expect(ctl.isOn()).toBe(true);
    expect(preview.setPreviewEditable).toHaveBeenCalledWith(true);
    expect(seen).toEqual([true]);
    expect(toggled).toEqual([true]);
    expect(store.data.has(LS_PREVIEW_EDIT)).toBe(false);
  });

  it('defaultOn false (a user) or omitted, nothing stored: OFF, not persisted; toggle turns it on and stores 1', () => {
    for (const opts of [{ defaultOn: false }, {}]) {
      const bus = createBus();
      const seen: boolean[] = [];
      bus.on('previewEdit:changed', (on) => seen.push(on));
      const preview = { setPreviewEditable: vi.fn(), endEditSession: vi.fn(), flushEditSession: vi.fn() };
      const store = fakeStore();
      const toggled: boolean[] = [];
      const ctl = createPreviewEdit({ bus, preview, ...store, onToggle: (on) => toggled.push(on), ...opts });
      expect(ctl.isOn()).toBe(false);
      expect(preview.setPreviewEditable).toHaveBeenCalledWith(false);
      expect(preview.setPreviewEditable).not.toHaveBeenCalledWith(true);
      expect(seen).toEqual([false]);
      expect(toggled).toEqual([false]);
      expect(store.data.has(LS_PREVIEW_EDIT)).toBe(false);
      ctl.toggle();
      expect(ctl.isOn()).toBe(true);
      expect(store.data.get(LS_PREVIEW_EDIT)).toBe('1');
      expect(preview.setPreviewEditable).toHaveBeenLastCalledWith(true);
      expect(toggled).toEqual([false, true]);
      expect(seen).toEqual([false, true]);
    }
  });

  it('a stored value wins over defaultOn; a damaged one falls back to it', () => {
    for (const [stored, fallback, want] of [
      ['1', false, true], ['0', true, false], ['garbage', false, false], ['garbage', true, true],
    ] as const) {
      const preview = { setPreviewEditable: vi.fn(), endEditSession: vi.fn(), flushEditSession: vi.fn() };
      const ctl = createPreviewEdit({ bus: createBus(), preview, ...fakeStore({ [LS_PREVIEW_EDIT]: stored }), defaultOn: fallback });
      expect(ctl.isOn(), `${stored} / ${fallback}`).toBe(want);
      expect(preview.setPreviewEditable).toHaveBeenLastCalledWith(want);
    }
  });

  it('parsePreviewEditPref: 1 / true / on, 0 / false / off; anything else is the fallback', () => {
    for (const fallback of [false, true]) {
      for (const v of ['1', 'true', 'on']) expect(parsePreviewEditPref(v, fallback), v).toBe(true);
      for (const v of ['0', 'false', 'off']) expect(parsePreviewEditPref(v, fallback), v).toBe(false);
      for (const v of [null, '', 'yes', 'no', 'null', '2', 'garbage', 'ON', 'True', ' 1', '1 ', 'undefined']) {
        expect(parsePreviewEditPref(v, fallback), String(v)).toBe(fallback);
      }
    }
  });

  it('restores a stored OFF, and toggling persists 0/1 and announces it', () => {

    const bus = createBus();
    const seen: boolean[] = [];
    bus.on('previewEdit:changed', (on) => seen.push(on));
    const preview = { setPreviewEditable: vi.fn(), endEditSession: vi.fn(), flushEditSession: vi.fn() };
    const store = fakeStore({ [LS_PREVIEW_EDIT]: '0' });
    const ctl = createPreviewEdit({ bus, preview, ...store });
    expect(ctl.isOn()).toBe(false);
    expect(preview.setPreviewEditable).toHaveBeenLastCalledWith(false);
    ctl.toggle();
    expect(ctl.isOn()).toBe(true);
    expect(store.data.get(LS_PREVIEW_EDIT)).toBe('1');
    expect(preview.setPreviewEditable).toHaveBeenLastCalledWith(true);
    ctl.toggle();
    expect(store.data.get(LS_PREVIEW_EDIT)).toBe('0');
    expect(seen).toEqual([false, true, false]);
  });

  it('tracks previewEdit:session; commit() / flush() always reach the preview (G16); turning off commits first', () => {
    const bus = createBus();
    const order: string[] = [];
    const preview = {
      setPreviewEditable: vi.fn((on: boolean) => order.push(`editable:${on}`)),
      endEditSession: vi.fn(() => order.push('end')),
      flushEditSession: vi.fn(() => order.push('flush')),
    };
    const sessions: boolean[] = [];
    const ctl = createPreviewEdit({ bus, preview, ...fakeStore(), onSession: (a) => sessions.push(a) });
    order.length = 0;
    // G16: no live session, but a resume after a merge / ⌘Z may be pending in the preview: end() drops it.
    ctl.commit();
    ctl.flush();
    expect(preview.endEditSession).toHaveBeenCalledTimes(1);
    expect(preview.flushEditSession).toHaveBeenCalledTimes(1);
    order.length = 0;
    bus.emit('previewEdit:session', { id: 7 });
    bus.emit('previewEdit:session', { id: 9 });   // moved to another block: still one active stretch
    expect(ctl.sessionActive()).toBe(true);
    expect(ctl.sessionId()).toBe(9);
    ctl.flush();
    expect(preview.flushEditSession).toHaveBeenCalledTimes(2);
    expect(ctl.sessionActive()).toBe(true);
    ctl.commit();
    expect(preview.endEditSession).toHaveBeenCalledTimes(2);
    ctl.set(false);
    expect(order).toEqual(['flush', 'end', 'end', 'editable:false']);
    bus.emit('previewEdit:session', { id: null });
    expect(ctl.sessionActive()).toBe(false);
    expect(sessions).toEqual([true, false]);
    ctl.off();
    bus.emit('previewEdit:session', { id: 1 });
    expect(ctl.sessionActive()).toBe(false);
  });

  it('shortcutKeyEvent builds a keydown that matchShortcut accepts', () => {
    for (const s of ['Mod-b', 'Mod-i', 'Mod-e', 'Mod-k', 'Mod-Shift-e']) {
      const e = shortcutKeyEvent(s);
      expect(e.type).toBe('keydown');
      expect(matchShortcut(e, s)).toBe(true);
    }
    expect(matchShortcut(shortcutKeyEvent('Mod-e'), 'Mod-Shift-e')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ App

// createApp with the preview, the worker and the persistent stores replaced by fakes: the preview is the
// other engineer's module (and its session is DOM work jsdom cannot layout), the worker needs a real
// Worker, and the stores need IndexedDB. Everything App itself does runs for real — CodeMirror included.
const hoisted = vi.hoisted(() => ({
  previewOpts: null as PreviewOptions | null,
  preview: null as (PreviewApi & { calls: string[]; editable: boolean }) | null,
  saves: [] as string[],
}));

vi.mock('../src/preview/createPreview', () => ({
  createPreview: (o: PreviewOptions) => {
    hoisted.previewOpts = o;
    const el = document.createElement('div');
    el.className = 'mdr-preview';
    o.parent.appendChild(el);
    const calls: string[] = [];
    const p = {
      el, calls, editable: false,
      applyStructure() {}, applyStructureDelta() {}, applyHtml() {}, applyOutline() {},
      blockCount: () => 1,
      blockAtLine: (line: number) => ({ index: 0, id: 1, startLine: line, lineCount: 1, kind: 0 as const }),
      blockOfElement: (e: Element) => {
        const s = e.closest('section.md-block') as HTMLElement | null;
        return s ? { index: 0, id: Number(s.dataset.id), startLine: Number(s.dataset.start), lineCount: Number(s.dataset.lines), kind: 0 as const } : null;
      },
      elementOfBlock: () => null,
      setPreviewEditable(on: boolean) { calls.push(`editable:${on}`); p.editable = on; },
      isPreviewEditable: () => p.editable,
      endEditSession() { calls.push('end'); },
      flushEditSession() { calls.push('flush'); },
      lineToScrollTop: () => 0,
      scrollTopToLine: () => ({ line: 1, fraction: 0 }),
      topVisible: () => ({ line: 1, fraction: 0 }),
      isLineVisible: () => true,
      scrollToLine() {},
      onScroll: () => () => {},
      setFocusLine() {},
      setVisible() {},
      mountAll: async () => {},
      dispose() {},
    };
    hoisted.preview = p;
    return p;
  },
}));
vi.mock('../src/preview/scrollSync', () => ({
  createScrollSync: () => ({ setEnabled() {}, syncNow() {}, dispose() {} }),
}));
vi.mock('../src/app/workerClient', () => ({
  createWorkerClient: () => ({
    setDoc() {}, edit() {}, viewport() {}, need() {}, setOptions() {}, draft() {},
    exportHtml: async () => '', resync() {}, dispose() {},
  }),
}));
vi.mock('../src/files/drafts', () => ({
  createDraftStore: () => ({ get: async () => undefined, del: async () => {} }),
}));
vi.mock('../src/files/recent', () => ({
  createRecentStore: () => ({
    list: async () => [], push: async () => {}, remove: async () => {},
    findByHandle: async () => undefined, findByPath: async () => undefined,
  }),
}));
vi.mock('../src/files/fileService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/fileService')>();
  return {
    ...orig,
    createFileService: () => {
      const svc = {
        canSaveInPlace: true,
        newFile: (): OpenedFile => ({ docId: orig.UNTITLED_ID, name: '未命名.md', text: '', lastModified: 0, source: 'new' }),
        open: async () => null,
        openHandle: async () => { throw new Error('unused'); },
        fromDrop: async () => null,
        save: async (file: OpenedFile, text: string): Promise<SaveResult> => {
          hoisted.saves.push(text);
          return { ok: true, savedAt: Date.now(), file: { ...file, text } };
        },
        saveAs: async (text: string, name: string): Promise<SaveResult> => {
          hoisted.saves.push(text);
          return { ok: true, savedAt: Date.now(), file: { docId: 'x', name, text, lastModified: 0, source: 'fsa' } };
        },
      };
      return svc;
    },
  };
});

describe('createApp wiring', () => {
  let root: HTMLElement;
  let app: Awaited<ReturnType<typeof import('../src/app/App').createApp>> | null = null;

  const start = async (ls: Record<string, string> = {}) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
    root = document.createElement('div');
    document.body.appendChild(root);
    const { createApp } = await import('../src/app/App');
    app = await createApp(root);
    return app;
  };
  const key = (target: EventTarget, init: KeyboardEventInit) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const modKey = (target: EventTarget, k: string, shift = false) =>
    key(target, { key: shift ? k.toUpperCase() : k, code: `Key${k.toUpperCase()}`, ctrlKey: true, shiftKey: shift });
  /** A mounted block the fake preview reports as being edited (CONTRACT §11 DOM: section.md-block.is-editing). */
  const editingSection = (start: number, lines: number) => {
    const s = document.createElement('section');
    s.className = 'md-block is-editing';
    s.setAttribute('contenteditable', 'true');
    s.dataset.id = '1';
    s.dataset.start = String(start);
    s.dataset.lines = String(lines);
    s.textContent = 'x';
    hoisted.preview!.el.appendChild(s);
    return s;
  };
  const toolbarBtn = (cmd: string) => root.querySelector<HTMLButtonElement>(`.mdr-toolbar__btn[data-cmd="${cmd}"]`)!;

  beforeEach(() => {
    hoisted.saves.length = 0;
    document.body.replaceChildren();
  });
  afterEach(() => {
    app?.dispose();
    app = null;
    root?.remove();
  });

  it('hands the preview a source wired to the live CodeMirror document', async () => {
    const a = await start();
    await a.loadText('# T\n\nalpha\nbeta\n\nomega', 'doc.md');
    const src = hoisted.previewOpts!.source!;
    expect(src).toBeDefined();
    expect(src.read(3, 2)).toBe('alpha\nbeta');
    const v0 = a.editor.version;
    src.replace(3, 2, 'alpha  \nbeta `x`');
    expect(a.getText()).toBe('# T\n\nalpha  \nbeta `x`\n\nomega');
    expect(a.editor.version).toBe(v0 + 1);
  });

  it('预览可编辑 is ON by default where the test hooks are installed (vitest: DEV): preview told, toolbar pressed, registered as global ⌘⇧E', async () => {
    const a = await start();
    expect(hoisted.preview!.calls).toContain('editable:true');
    const btn = toolbarBtn('view.togglePreviewEdit');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // Next to the mode buttons.
    expect(btn.previousElementSibling?.getAttribute('data-cmd')).toBe('view.mode.preview');
    const cmd = a.registry.get('view.togglePreviewEdit')!;
    expect(cmd).toMatchObject({ title: '预览可编辑（实验性）', shortcut: 'Mod-Shift-e', scope: 'global' });
    expect(btn.title.startsWith('预览可编辑（实验性） (')).toBe(true);
  });

  it('预览可编辑 is OFF by default for a user (no test hooks: production build without ?perf=1)', async () => {
    vi.stubEnv('DEV', false);
    try {
      const a = await start();
      expect(window.__mdr).toBeUndefined();   // the hooks really are absent
      expect(hoisted.preview!.calls).toContain('editable:false');
      expect(hoisted.preview!.calls).not.toContain('editable:true');
      expect(hoisted.preview!.editable).toBe(false);
      const btn = toolbarBtn('view.togglePreviewEdit');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.title.startsWith('预览可编辑（实验性） (')).toBe(true);
      expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBeNull();
      const shown: string[] = [];
      const seen: boolean[] = [];
      a.bus.on('previewEdit:changed', (on) => seen.push(on));
      const texts = () => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent ?? '');
      modKey(document.body, 'e', true);
      expect(hoisted.preview!.editable).toBe(true);
      expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('1');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      shown.push(...texts());
      modKey(document.body, 'e', true);
      expect(hoisted.preview!.editable).toBe(false);
      expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('0');
      shown.push(...texts());
      expect(seen).toEqual([true, false]);
      expect(shown.some((t) => t.includes('预览可编辑（实验性）：开'))).toBe(true);
      expect(shown.some((t) => t.includes('预览可编辑：关'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('⌘⇧E toggles, persists and announces; a stored OFF survives a restart', async () => {
    const a = await start();
    const seen: boolean[] = [];
    a.bus.on('previewEdit:changed', (on) => seen.push(on));
    modKey(document.body, 'e', true);
    expect(hoisted.preview!.editable).toBe(false);
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('0');
    expect(toolbarBtn('view.togglePreviewEdit').getAttribute('aria-pressed')).toBe('false');
    expect(seen).toEqual([false]);
    app!.dispose();
    app = null;

    await start({ [LS_PREVIEW_EDIT]: '0' });
    expect(hoisted.preview!.editable).toBe(false);
    expect(toolbarBtn('view.togglePreviewEdit').getAttribute('aria-pressed')).toBe('false');
    toolbarBtn('view.togglePreviewEdit').click();
    expect(hoisted.preview!.editable).toBe(true);
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('1');
  });

  it('⌘S flushes the session (keeps it live), so the saved text includes its last serialization', async () => {
    const a = await start();
    await a.loadText('para\n\nnext', 'doc.md');
    a.bus.emit('previewEdit:session', { id: 1 });
    // The session's pending frame is written by flushEditSession: model that as a write through `source`.
    const p = hoisted.preview!;
    p.flushEditSession = () => {
      p.calls.push('flush');
      hoisted.previewOpts!.source!.replace(1, 1, 'para **bold**');
    };
    p.calls.length = 0;
    modKey(document.body, 's');
    await vi.waitFor(() => expect(hoisted.saves).toHaveLength(1));
    expect(p.calls).toEqual(['flush']);
    expect(hoisted.saves[0]).toBe('para **bold**\n\nnext');
    expect(a.getText()).toBe('para **bold**\n\nnext');
  });

  it('status bar shows 预览编辑 while a session is live', async () => {
    const a = await start();
    const mode = root.querySelector<HTMLElement>('.mdr-statusbar__item[data-stat="mode"]')!;
    const before = mode.textContent;
    a.bus.emit('previewEdit:session', { id: 4 });
    expect(mode.textContent).toBe(`${before} · 预览编辑`);
    expect(mode.dataset.previewEdit).toBe('1');
    a.bus.emit('previewEdit:session', { id: null });
    expect(mode.textContent).toBe(before);
    expect(mode.dataset.previewEdit).toBeUndefined();
  });

  it('mode switches and new/open guards end the session first', async () => {
    const a = await start();
    a.bus.emit('previewEdit:session', { id: 1 });
    const p = hoisted.preview!;
    p.calls.length = 0;
    a.registry.run('view.mode.preview');
    expect(p.calls).toContain('end');
    p.calls.length = 0;
    await a.registry.run('file.new');
    await vi.waitFor(() => expect(p.calls).toContain('end'));
  });

  it('an editor command during a session does NOT switch to split / focus the editor; ⌘B goes to the session', async () => {
    const a = await start();
    await a.loadText('one\n\ntwo', 'doc.md');
    a.registry.run('view.mode.preview');
    const section = editingSection(1, 1);
    a.bus.emit('previewEdit:session', { id: 1 });
    const got: KeyboardEvent[] = [];
    section.addEventListener('keydown', (e) => got.push(e));
    const before = a.getText();
    (document.activeElement as HTMLElement | null)?.blur();   // loadText focused the editor (split at the time)
    expect(a.editor.hasFocus()).toBe(false);

    // ⌘B pressed with focus outside the contenteditable → the shortcuts hook → App → forwarded.
    modKey(document.body, 'b');
    expect(a.layout.getMode()).toBe('preview');
    expect(a.editor.hasFocus()).toBe(false);
    expect(a.getText()).toBe(before);
    expect(got).toHaveLength(1);
    expect(matchShortcut(got[0], 'Mod-b')).toBe(true);

    // A session host the shortcut listener does not recognise as editable must not ping-pong the event.
    section.removeAttribute('contenteditable');
    modKey(document.body, 'b');
    expect(got).toHaveLength(2);
    section.setAttribute('contenteditable', 'true');

    // The toolbar's 加粗 while the session is live: same route, CodeMirror untouched.
    toolbarBtn('edit.bold').click();
    expect(got).toHaveLength(3);
    expect(a.getText()).toBe(before);
    expect(a.layout.getMode()).toBe('preview');
  });

  it('an editor command the session does not implement commits it, then runs in the editor on that block', async () => {
    const a = await start();
    await a.loadText('one\n\ntwo', 'doc.md');
    a.registry.run('view.mode.preview');
    editingSection(3, 1);
    a.bus.emit('previewEdit:session', { id: 1 });
    const p = hoisted.preview!;
    p.calls.length = 0;
    p.endEditSession = () => {
      p.calls.push('end');
      a.bus.emit('previewEdit:session', { id: null });
    };
    // 标题 1 via the shortcut path (focus outside the editor).
    key(document.body, { key: '1', code: 'Digit1', ctrlKey: true });
    // routeToSession ends the session; the mode switch to split commits again (G16: unconditional, a no-op now).
    expect(p.calls).toEqual(['end', 'end']);
    expect(a.layout.getMode()).toBe('split');
    // Applied to the block that was being edited (line 3), not to CodeMirror's stale caret line.
    expect(a.getText()).toBe('one\n\n# two');
  });

  it('without a session the old behaviour stands: ⌘B in 预览 switches to split and runs in the editor', async () => {
    const a = await start();
    await a.loadText('word', 'doc.md');
    a.registry.run('view.mode.preview');
    modKey(document.body, 'b');
    expect(a.layout.getMode()).toBe('split');
    expect(a.getText()).toBe('****word');
  });

  const frames = (n = 2) => new Promise<void>((r) => {
    const step = (left: number): void => { if (left <= 0) r(); else requestAnimationFrame(() => step(left - 1)); };
    step(n);
  });

  // Finding high 1: the cursor notification a preview write causes is the preview's edit. It reports the edited
  // block's line (status bar, TOC) but as `typing: false`, so the cursor-follow (scroll sync) and the focus line
  // — both of which follow typing IN THE EDITOR — leave the preview alone.
  it('a preview write is announced as the edited block, never as editor typing (status bar follows it)', async () => {
    const a = await start();
    await a.loadText('a\n\nb\n\nc\n\nd', 'doc.md');
    (document.activeElement as HTMLElement | null)?.blur();
    await frames();
    const cursors: Array<AppEvents['doc:cursor']> = [];
    const lines: Array<AppEvents['focus:line']> = [];
    a.bus.on('doc:cursor', (e) => cursors.push(e));
    a.bus.on('focus:line', (e) => lines.push(e));
    a.bus.emit('previewEdit:session', { id: 1 });
    hoisted.previewOpts!.source!.replace(5, 1, 'c edited');
    await vi.waitFor(() => expect(cursors.length).toBeGreaterThan(0));
    expect(cursors).toEqual([{ line: 5, col: 'c edited'.length, typing: false }]);
    expect(lines).toEqual([]);
    expect(a.editor.hasFocus()).toBe(false);
    const pos = root.querySelector<HTMLElement>('.mdr-statusbar__item[data-stat="pos"]');
    expect(pos?.textContent).toContain('5');
  });

  it('a preview write claims no focus line even when the editor has focus (mode switch commits the session)', async () => {
    const a = await start();
    await a.loadText('a\n\nb\n\nc', 'doc.md');
    a.editor.focus();
    await frames();
    const cursors: Array<AppEvents['doc:cursor']> = [];
    const lines: Array<AppEvents['focus:line']> = [];
    a.bus.on('doc:cursor', (e) => cursors.push(e));
    a.bus.on('focus:line', (e) => lines.push(e));
    hoisted.previewOpts!.source!.replace(3, 1, 'b2');
    await vi.waitFor(() => expect(cursors.length).toBe(1));
    // G14: the editor has the focus, so its caret (line 1) stays where the user put it.
    expect(cursors[0]).toEqual({ line: 1, col: 0, typing: false });
    expect(lines).toEqual([]);
    // The write's mark is gone with the notification it caused: the user's next keystroke in the editor is typing.
    a.editor.view.dispatch({ changes: { from: 0, insert: 'x' }, selection: { anchor: 1 }, userEvent: 'input.type' });
    await vi.waitFor(() => expect(cursors.length).toBe(2));
    expect(cursors[1]).toEqual({ line: 1, col: 1, typing: true });
    expect(lines).toEqual([{ line: 1, source: 'editor' }]);
  });

  it('a session undo / redo (source.history) is announced like a preview write: typing false, no focus line, no focus', async () => {
    const a = await start();
    await a.loadText('a\n\nb\n\nc', 'doc.md');
    (document.activeElement as HTMLElement | null)?.blur();
    const src = hoisted.previewOpts!.source!;
    a.bus.emit('previewEdit:session', { id: 1 });
    src.replace(3, 1, 'b typed');
    await frames();
    const cursors: Array<AppEvents['doc:cursor']> = [];
    const lines: Array<AppEvents['focus:line']> = [];
    a.bus.on('doc:cursor', (e) => cursors.push(e));
    a.bus.on('focus:line', (e) => lines.push(e));
    expect(src.history!(false)).toEqual({ line: 3, col: 1 });
    expect(a.getText()).toBe('a\n\nb\n\nc');
    await vi.waitFor(() => expect(cursors.length).toBe(1));
    expect(cursors[0]).toEqual({ line: 3, col: 1, typing: false });
    expect(src.history!(true)).toEqual({ line: 3, col: 7 });
    await vi.waitFor(() => expect(cursors.length).toBe(2));
    expect(cursors[1]).toEqual({ line: 3, col: 7, typing: false });
    expect(lines).toEqual([]);
    expect(a.editor.hasFocus()).toBe(false);
  });

  // Decision U2.
  it('⌘Z / ⇧⌘Z outside the editor and outside a session step the document history (no mode switch, no focus)', async () => {
    const a = await start();
    await a.loadText('one\n\ntwo', 'doc.md');
    a.editor.view.dispatch({ changes: { from: 3, insert: ' more' }, userEvent: 'input.type' });
    expect(a.getText()).toBe('one more\n\ntwo');
    a.registry.run('view.mode.preview');
    (document.activeElement as HTMLElement | null)?.blur();
    let e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: false, bubbles: true, cancelable: true });
    // (jsdom is not a Mac: Mod = Ctrl)
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(a.getText()).toBe('one\n\ntwo');
    expect(a.layout.getMode()).toBe('preview');
    expect(a.editor.hasFocus()).toBe(false);
    modKey(toolbarBtn('view.mode.split'), 'z', true);   // ⇧⌘Z from a toolbar button
    expect(a.getText()).toBe('one more\n\ntwo');
    expect(a.layout.getMode()).toBe('preview');
    // Nothing left to redo: a no-op, not an error.
    e = new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(a.getText()).toBe('one more\n\ntwo');
  });

  it('a session that is live while the focus is elsewhere is committed before an outside ⌘Z', async () => {
    const a = await start();
    await a.loadText('para\n\nnext', 'doc.md');
    const p = hoisted.preview!;
    p.endEditSession = () => {
      p.calls.push('end');
      hoisted.previewOpts!.source!.replace(1, 1, 'para typed');
      a.bus.emit('previewEdit:session', { id: null });
    };
    a.bus.emit('previewEdit:session', { id: 1 });
    (document.activeElement as HTMLElement | null)?.blur();
    p.calls.length = 0;
    modKey(document.body, 'z');
    expect(p.calls).toEqual(['end']);
    // The session's last text reached the source and was then undone as one step.
    expect(a.getText()).toBe('para\n\nnext');
  });

  // U2 as amended (CONTRACT §11, Switch-off audit decisions OFFD-1; Checkpoint-C decisions RVS-3; fix-session-e B2):
  // ⌘Z / ⇧⌘Z from outside the editor run CodeMirror's own undo / redo; the step's cursor notification is editor typing
  // with ONE mark (follow) that the preview's cursor-follow obeys although the editor has no focus; no focus or mode
  // change; a step that changes nothing leaves no mark; a tick, a preview write and typing stay unmarked.
  // fix-session-f (Checkpoint-D decisions, "U2 as amended is narrowed to the switch-off configuration"): that route is
  // the switch OFF's (these cases now store '0': the hooks of the test make the switch ON by default); with the switch
  // ON the experimental feature keeps its quiet route (source.history: undone, no scroll, no follow mark).
  describe('U2 as amended: an outside ⌘Z is CodeMirror\'s undo, shown in both panes', () => {
    /** Typing in the editor: the caret goes to `at` first (CodeMirror's undo restores the selection before the change). */
    const typed = (a: Awaited<ReturnType<typeof start>>, at: number, text: string) => {
      a.editor.view.dispatch({ selection: { anchor: at } });
      a.editor.view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type', annotations: isolateHistory.of('full') });
    };
    const watch = (a: Awaited<ReturnType<typeof start>>) => {
      const cursors: Array<AppEvents['doc:cursor']> = [];
      const lines: Array<AppEvents['focus:line']> = [];
      a.bus.on('doc:cursor', (e) => cursors.push(e));
      a.bus.on('focus:line', (e) => lines.push(e));
      return { cursors, lines };
    };

    for (const mode of ['split', 'preview'] as const) {
      it(`${mode} mode: the step is announced as typing with follow; the focus line moves; focus and mode stay`, async () => {
        const a = await start({ [LS_PREVIEW_EDIT]: '0' });
        await a.loadText('one\n\ntwo\n\nthree', 'doc.md');
        typed(a, 'one\n\ntwo\n\nthree'.length, ' more');
        a.registry.run(`view.mode.${mode}`);
        (document.activeElement as HTMLElement | null)?.blur();
        await frames();
        const { cursors, lines } = watch(a);
        const active = document.activeElement;
        modKey(document.body, 'z');
        expect(a.getText()).toBe('one\n\ntwo\n\nthree');
        expect(document.activeElement).toBe(active);
        expect(a.layout.getMode()).toBe(mode);
        await vi.waitFor(() => expect(cursors.length).toBe(1));
        expect(cursors[0]).toEqual({ line: 5, col: 5, typing: true, follow: true });
        expect(lines).toEqual([{ line: 5, source: 'editor' }]);
        modKey(document.body, 'z', true);                       // ⇧⌘Z: CodeMirror's redo, the same way
        expect(a.getText()).toBe('one\n\ntwo\n\nthree more');
        await vi.waitFor(() => expect(cursors.length).toBe(2));
        expect(cursors[1]).toEqual({ line: 5, col: 10, typing: true, follow: true });
        expect(document.activeElement).toBe(active);
        expect(a.layout.getMode()).toBe(mode);
        expect(a.editor.hasFocus()).toBe(false);
      });
    }

    it('ten presses in a row: ten steps, each notification marked, the focus never moves', async () => {
      const a = await start({ [LS_PREVIEW_EDIT]: '0' });
      await a.loadText('base', 'doc.md');
      for (let k = 0; k < 10; k++) typed(a, a.getText().length, String(k));
      expect(a.getText()).toBe('base0123456789');
      (document.activeElement as HTMLElement | null)?.blur();
      await frames();
      const { cursors } = watch(a);
      for (let k = 0; k < 10; k++) {
        modKey(document.body, 'z');
        await vi.waitFor(() => expect(cursors.length).toBe(k + 1));
        expect(cursors[k]).toEqual({ line: 1, col: 13 - k, typing: true, follow: true });
        expect(document.activeElement).toBe(document.body);
      }
      expect(a.getText()).toBe('base');
    });

    it('a press with nothing to undo leaves no mark: the next typing and a later tick are not marked', async () => {
      const a = await start({ [LS_PREVIEW_EDIT]: '0' });
      await a.loadText('- [ ] task\n\npara', 'doc.md');
      (document.activeElement as HTMLElement | null)?.blur();
      await frames();
      const { cursors } = watch(a);
      modKey(document.body, 'z');
      modKey(document.body, 'z', true);
      await frames(3);
      expect(cursors).toEqual([]);
      expect(a.getText()).toBe('- [ ] task\n\npara');
      a.bus.emit('source:edit', { kind: 'toggleTask', line: 1 });  // a tick in the preview
      await vi.waitFor(() => expect(cursors.length).toBe(1));
      expect(a.getText()).toBe('- [x] task\n\npara');
      expect(cursors[0].follow).toBeUndefined();
      a.editor.focus();
      typed(a, a.getText().length, '!');                         // typing in the editor
      await vi.waitFor(() => expect(cursors.length).toBe(2));
      expect(cursors[1]).toEqual({ line: 3, col: 5, typing: true });
    });

    it('the mark belongs to the step\'s notification only: a tick right after it is unmarked', async () => {
      const a = await start({ [LS_PREVIEW_EDIT]: '0' });
      await a.loadText('- [ ] task\n\npara', 'doc.md');
      typed(a, a.getText().length, ' x');
      (document.activeElement as HTMLElement | null)?.blur();
      await frames();
      const { cursors } = watch(a);
      modKey(document.body, 'z');
      await vi.waitFor(() => expect(cursors.length).toBe(1));
      expect(cursors[0].follow).toBe(true);
      a.bus.emit('source:edit', { kind: 'toggleTask', line: 1 });
      await vi.waitFor(() => expect(cursors.length).toBe(2));
      expect(cursors[1].follow).toBeUndefined();
    });

    // fix-session-f (Checkpoint-D decisions): with the switch on, after Esc, the step takes the experimental feature's
    // quiet route (was: CodeMirror's undo, which put the caret where it stood before the session — here line 1 — and
    // threw both panes there): undone, the caret on the change, no follow mark, the focus line not moved, no focus.
    it('with the switch on, after Esc ended a session: the quiet route (source.history), no follow mark, no scroll', async () => {
      const a = await start();
      await a.loadText('a\n\nb\n\nc', 'doc.md');
      (document.activeElement as HTMLElement | null)?.blur();
      const src = hoisted.previewOpts!.source!;
      a.bus.emit('previewEdit:session', { id: 1 });
      src.replace(3, 1, 'b typed');
      a.bus.emit('previewEdit:session', { id: null });           // Esc
      await frames();
      const { cursors, lines } = watch(a);
      const scrolls: number[] = [];
      a.editor.view.scrollDOM.addEventListener('scroll', () => scrolls.push(a.editor.view.scrollDOM.scrollTop));
      modKey(document.body, 'z');
      expect(a.getText()).toBe('a\n\nb\n\nc');
      await vi.waitFor(() => expect(cursors.length).toBe(1));
      expect(cursors[0]).toEqual({ line: 3, col: 1, typing: false });   // the caret on the change, a preview step
      await frames(3);
      expect(cursors.length).toBe(1);
      expect(lines).toEqual([]);
      expect(scrolls).toEqual([]);
      expect(document.activeElement).toBe(document.body);
      modKey(document.body, 'z', true);                            // ⇧⌘Z: the same route
      expect(a.getText()).toBe('a\n\nb typed\n\nc');
      await vi.waitFor(() => expect(cursors.length).toBe(2));
      expect(cursors[1].follow).toBeUndefined();
      expect(cursors[1].typing).toBe(false);
    });

    it('with the switch on and no session: the quiet route as well (undone, no follow mark, no focus or mode change)', async () => {
      const a = await start();
      await a.loadText('one\n\ntwo\n\nthree', 'doc.md');
      typed(a, 'one\n\ntwo\n\nthree'.length, ' more');
      (document.activeElement as HTMLElement | null)?.blur();
      await frames();
      const { cursors, lines } = watch(a);
      modKey(document.body, 'z');
      expect(a.getText()).toBe('one\n\ntwo\n\nthree');
      await vi.waitFor(() => expect(cursors.length).toBe(1));
      expect(cursors[0]).toEqual({ line: 5, col: 5, typing: false });
      expect(lines).toEqual([]);
      expect(a.editor.hasFocus()).toBe(false);
      expect(a.layout.getMode()).toBe('split');
    });

    it('the switch turned off after a session: CodeMirror\'s own route, marked', async () => {
      const a = await start();
      await a.loadText('a\n\nb\n\nc', 'doc.md');
      (document.activeElement as HTMLElement | null)?.blur();
      const src = hoisted.previewOpts!.source!;
      a.bus.emit('previewEdit:session', { id: 1 });
      src.replace(3, 1, 'b typed');
      a.bus.emit('previewEdit:session', { id: null });
      a.registry.run('view.togglePreviewEdit');                    // off
      expect(toolbarBtn('view.togglePreviewEdit').getAttribute('aria-pressed')).toBe('false');
      (document.activeElement as HTMLElement | null)?.blur();
      await frames();
      const { cursors } = watch(a);
      modKey(document.body, 'z');
      expect(a.getText()).toBe('a\n\nb\n\nc');
      await vi.waitFor(() => expect(cursors.length).toBe(1));
      expect(cursors[0]).toMatchObject({ typing: true, follow: true });
    });

    // fix-session-f (Checkpoint-D decisions): a live session exists only with the switch on, so its step takes the quiet
    // route: the commit's write and the step are both the preview's (was: CodeMirror's undo, marked follow).
    it('a live session committed by the outside ⌘Z itself (switch on): one notification, the preview\'s (no follow)', async () => {
      const a = await start();
      await a.loadText('para\n\nnext', 'doc.md');
      const p = hoisted.preview!;
      p.endEditSession = () => {
        p.calls.push('end');
        hoisted.previewOpts!.source!.replace(1, 1, 'para typed');
        a.bus.emit('previewEdit:session', { id: null });
      };
      a.bus.emit('previewEdit:session', { id: 1 });
      (document.activeElement as HTMLElement | null)?.blur();
      await frames();
      const { cursors } = watch(a);
      modKey(document.body, 'z');
      expect(a.getText()).toBe('para\n\nnext');
      await vi.waitFor(() => expect(cursors.length).toBe(1));
      expect(cursors[0]).toMatchObject({ typing: false });
      expect(cursors[0].follow).toBeUndefined();
      await frames(3);
      expect(cursors.length).toBe(1);
    });
  });

  // Low finding: editor-only shortcuts inside a session were silent no-ops.
  it('an editor-only shortcut pressed inside a session shows a hint and changes nothing; ⌘B stays the session\'s', async () => {
    const a = await start();
    await a.loadText('one\n\ntwo', 'doc.md');
    a.registry.run('view.mode.preview');
    const section = editingSection(1, 1);
    a.bus.emit('previewEdit:session', { id: 1 });
    const p = hoisted.preview!;
    p.calls.length = 0;
    const before = a.getText();
    let e = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true, cancelable: true });
    section.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(root.textContent).toContain('标题 1：预览编辑中不可用，按 Esc 结束编辑后再按');
    expect(a.getText()).toBe(before);
    expect(a.layout.getMode()).toBe('preview');
    expect(p.calls).toEqual([]);                     // the session is not ended
    e = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true });
    section.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);           // no browser find bar over a half-mounted preview
    expect(root.textContent).toContain('查找');
    // The session's own keys are left to it.
    e = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true });
    section.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    // Without a session the same key in some other contenteditable is not ours.
    a.bus.emit('previewEdit:session', { id: null });
    e = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, bubbles: true, cancelable: true });
    section.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('typing in the preview does not let the editor claim the focus line', async () => {
    const a = await start();
    await a.loadText('a\n\nb\n\nc', 'doc.md');
    const lines: Array<AppEvents['focus:line']> = [];
    a.bus.on('focus:line', (e) => lines.push(e));
    a.bus.emit('previewEdit:session', { id: 1 });
    a.bus.emit('doc:cursor', { line: 5, col: 0, typing: true });
    expect(lines).toEqual([]);
    a.bus.emit('previewEdit:session', { id: null });
    a.bus.emit('doc:cursor', { line: 5, col: 0, typing: true });
    expect(lines).toEqual([{ line: 5, source: 'editor' }]);
  });
});
