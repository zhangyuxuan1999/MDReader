// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { language } from '@codemirror/language';
import { createBus } from '../src/shared/bus';
import { createEditor, disposeEditor, LANGUAGE_TIER_FULL_MAX, LANGUAGE_TIER_MARKDOWN_MAX, LARGE_DOC_TOAST, LONG_LINE_MAX, languageTierFor, maxLineLength, type DisposableEditorApi } from '../src/editor/createEditor';
import type { ToastSpec } from '../src/shared/types';
import { createFakeRegistry, installLayoutStubs } from './editor.helpers';
import type { TextChange } from '../src/shared/types';

installLayoutStubs();

function setup(doc = '') {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const registry = createFakeRegistry();
  const bus = createBus();
  const toasts: ToastSpec[] = [];
  bus.on('toast', (t) => toasts.push(t));
  const editor = createEditor({ parent, bus, registry, theme: 'light' }) as DisposableEditorApi;
  if (doc) editor.setDoc(doc);
  return { parent, registry, editor, bus, toasts };
}

const lines = (chars: number): string => 'x\n'.repeat(Math.ceil(chars / 2));

beforeEach(() => {
  document.body.replaceChildren();
});

describe('createEditor', () => {
  it('mounts CodeMirror in the parent and registers every edit.* command', () => {
    const { parent, registry } = setup();
    expect(parent.querySelector('.cm-editor')).not.toBeNull();
    const ids = registry.list().map((c) => c.id).sort();
    expect(ids).toEqual([
      'edit.bold', 'edit.code', 'edit.find', 'edit.gotoLine', 'edit.heading1', 'edit.heading2', 'edit.heading3',
      'edit.heading4', 'edit.heading5', 'edit.heading6', 'edit.italic', 'edit.link', 'edit.paragraph', 'edit.toggleTask',
    ]);
    for (const c of registry.list()) expect(c.scope).toBe('editor');
    expect(registry.get('edit.bold')?.shortcut).toBe('Mod-b');
    expect(registry.get('edit.gotoLine')?.shortcut).toBe('Mod-Alt-g');
  });

  it('setDoc replaces the text, bumps the version, resets history and does not call onChanges', () => {
    const { editor } = setup();
    const seen: number[] = [];
    editor.onChanges((v) => seen.push(v));
    expect(editor.version).toBe(0);
    editor.view.dispatch({ changes: { from: 0, insert: 'typed' } });
    expect(editor.version).toBe(1);
    expect(seen).toEqual([1]);

    const v = editor.setDoc('fresh\ndoc');
    expect(v).toBe(2);
    expect(editor.version).toBe(2);
    expect(editor.getText()).toBe('fresh\ndoc');
    expect(editor.lineCount()).toBe(2);
    expect(seen).toEqual([1]);
    // History was cleared by setDoc: undo has nothing to revert.
    expect(undo(editor.view)).toBe(false);
    expect(editor.getText()).toBe('fresh\ndoc');
  });

  it('onChanges fires synchronously once per transaction with original-coordinate changes', () => {
    const { editor } = setup('abc');
    const calls: Array<[number, TextChange[]]> = [];
    const off = editor.onChanges((v, ch) => calls.push([v, ch]));
    editor.view.dispatch({ changes: [{ from: 1, to: 2, insert: 'XX' }, { from: 3, insert: '!' }] });
    expect(calls).toEqual([[2, [{ from: 1, to: 2, insert: 'XX' }, { from: 3, to: 3, insert: '!' }]]]);
    off();
    editor.view.dispatch({ changes: { from: 0, insert: 'z' } });
    expect(calls.length).toBe(1);
    expect(editor.version).toBe(3);
  });

  it('onCursor is rAF-coalesced and reports typing', () => {
    vi.useFakeTimers();
    try {
      const { editor } = setup('line1\nline2');
      const cursor = vi.fn();
      editor.onCursor(cursor);
      editor.view.dispatch({ selection: { anchor: 7 } });
      editor.view.dispatch({ changes: { from: 7, insert: 'x' }, selection: { anchor: 8 } });
      expect(cursor).not.toHaveBeenCalled();
      vi.runOnlyPendingTimers(); // jsdom's rAF is timer-based under fake timers
      expect(cursor).toHaveBeenCalledTimes(1);
      expect(cursor).toHaveBeenCalledWith(2, 2, true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applySourceEdit toggles a task box nested in blockquotes and indentation', () => {
    const { editor } = setup('> - [ ] task in quote\n> > * [x] deep\n  > 1. [ ] num');
    editor.applySourceEdit({ kind: 'toggleTask', line: 1 });
    editor.applySourceEdit({ kind: 'toggleTask', line: 2 });
    editor.applySourceEdit({ kind: 'toggleTask', line: 3 });
    expect(editor.getText()).toBe('> - [x] task in quote\n> > * [ ] deep\n  > 1. [x] num');
  });

  it('applySourceEdit toggles the task box on that line only', () => {
    const { editor } = setup('- [ ] a\n- [x] b\nplain');
    editor.applySourceEdit({ kind: 'toggleTask', line: 2 });
    expect(editor.getText()).toBe('- [ ] a\n- [ ] b\nplain');
    editor.applySourceEdit({ kind: 'toggleTask', line: 1 });
    expect(editor.getText()).toBe('- [x] a\n- [ ] b\nplain');
    const before = editor.version;
    editor.applySourceEdit({ kind: 'toggleTask', line: 3 });
    editor.applySourceEdit({ kind: 'toggleTask', line: 99 });
    expect(editor.version).toBe(before);
  });

  it('gotoLine moves the cursor and clamps out-of-range input', () => {
    const { editor } = setup('a\nbb\nccc');
    editor.gotoLine(3, 2);
    expect(editor.view.state.selection.main.head).toBe(7);
    editor.gotoLine(100, 50);
    expect(editor.view.state.selection.main.head).toBe(8);
    editor.gotoLine(0);
    expect(editor.view.state.selection.main.head).toBe(0);
  });

  it('gotoLine / scrollToLine survive every non-finite argument (fix round 3)', () => {
    const { editor } = setup('a\nbb\nccc');
    editor.gotoLine(2, 1);
    const head = editor.view.state.selection.main.head;
    const bad = [NaN, undefined, null, Infinity, -Infinity] as unknown as number[];
    for (const v of bad) {
      expect(() => editor.gotoLine(v)).not.toThrow();
      expect(() => editor.scrollToLine(v, 0)).not.toThrow();
      expect(() => editor.gotoLine(2, v)).not.toThrow();
      expect(() => editor.scrollToLine(2, v)).not.toThrow();
      expect(Number.isFinite(editor.view.scrollDOM.scrollTop)).toBe(true);
    }
    // NaN/undefined are ignored (no jump to line 1); ±Infinity clamps like any out-of-range line.
    editor.gotoLine(2, 1);
    editor.gotoLine(NaN);
    expect(editor.view.state.selection.main.head).toBe(head);
    editor.gotoLine(Infinity);
    expect(editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number).toBe(3);
    // A fractional line/column still lands on a real position.
    editor.gotoLine(2.7, 1.5);
    expect(Number.isInteger(editor.view.state.selection.main.head)).toBe(true);
    expect(editor.getText()).toBe('a\nbb\nccc');
  });

  it('applySourceEdit ignores a non-finite line', () => {
    const { editor } = setup('- [ ] a');
    const before = editor.version;
    editor.applySourceEdit({ kind: 'toggleTask', line: NaN });
    editor.applySourceEdit({ kind: 'toggleTask', line: undefined as unknown as number });
    editor.applySourceEdit({ kind: 'toggleTask', line: 1.5 });
    expect(editor.version).toBe(before);
    expect(editor.getText()).toBe('- [ ] a');
  });

  it('theme, wrap and visibility reconfigure without touching the document', () => {
    const { editor } = setup('x');
    const v = editor.version;
    editor.setTheme('dark');
    expect(editor.view.state.facet(EditorView.darkTheme)).toBe(true);
    editor.setTheme('light');
    expect(editor.view.state.facet(EditorView.darkTheme)).toBe(false);
    editor.setLineWrap(false);
    expect(editor.view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
    editor.setLineWrap(true);
    expect(editor.view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
    editor.setVisible(false);
    editor.setVisible(true);
    expect(editor.version).toBe(v);
    expect(editor.getText()).toBe('x');
  });

  it('allows multiple selections: typing with three cursors inserts three copies', () => {
    const { editor } = setup('a\nb\nc');
    const d = editor.view.state.doc;
    editor.view.dispatch({ selection: EditorSelection.create([1, 2, 3].map((n) => EditorSelection.cursor(d.line(n).from))) });
    expect(editor.view.state.selection.ranges.length).toBe(3);
    editor.view.dispatch(editor.view.state.replaceSelection('M'));
    expect(editor.getText()).toBe('Ma\nMb\nMc');
  });

  describe('size-gated language', () => {
    it('languageTierFor maps sizes to tiers at the 128 KB / 256 KB boundaries', () => {
      expect(languageTierFor(0)).toBe('full');
      expect(languageTierFor(LANGUAGE_TIER_FULL_MAX)).toBe('full');
      expect(languageTierFor(LANGUAGE_TIER_FULL_MAX + 1)).toBe('markdown');
      expect(languageTierFor(LANGUAGE_TIER_MARKDOWN_MAX)).toBe('markdown');
      expect(languageTierFor(LANGUAGE_TIER_MARKDOWN_MAX + 1)).toBe('none');
      // The measured per-keystroke cost of the tree parser crosses the 5 ms P5 budget well below 1 MB
      // (codeLanguages) / 3 MB (markdown only), so the gate must be at most this tight.
      expect(LANGUAGE_TIER_FULL_MAX).toBeLessThanOrEqual(128 * 1024);
      expect(LANGUAGE_TIER_MARKDOWN_MAX).toBeLessThanOrEqual(256 * 1024);
    });

    it('a single over-long line drops the language regardless of the document size', () => {
      expect(languageTierFor(1000, LONG_LINE_MAX)).toBe('full');
      expect(languageTierFor(1000, LONG_LINE_MAX + 1)).toBe('none');
      expect(languageTierFor(LANGUAGE_TIER_FULL_MAX, LONG_LINE_MAX + 1)).toBe('none');
    });

    it('maxLineLength measures the longest line and stops early at the cap', () => {
      expect(maxLineLength('')).toBe(0);
      expect(maxLineLength('abc')).toBe(3);
      expect(maxLineLength('a\nbbbb\nccc')).toBe(4);
      expect(maxLineLength('a\nbbbb\nccc\n')).toBe(4);
      // With a cap the scan returns as soon as the cap is exceeded: the value is > cap, not the true max.
      expect(maxLineLength('x'.repeat(10) + '\n' + 'y'.repeat(50), 20)).toBe(50);
      expect(maxLineLength('x'.repeat(30) + '\n' + 'y'.repeat(50), 20)).toBe(30);
      expect(maxLineLength('short\nshort', 20)).toBe(5);
    });

    it('a 1 MB single line: no language, line wrapping off, one toast; explicit setLineWrap overrides', () => {
      const { editor, toasts } = setup();
      editor.setDoc('word '.repeat(20_000)); // 100 KB — "full" by size, one 99_999-char line
      expect(editor.hasLongLine()).toBe(true);
      expect(editor.languageTier()).toBe('none');
      expect(editor.view.state.facet(language)).toBeNull();
      expect(editor.view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
      expect(toasts.map((t) => t.text)).toEqual([LARGE_DOC_TOAST]);

      // The user may take the cost back on explicitly; the next document re-arms the guard.
      editor.setLineWrap(true);
      expect(editor.view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
      editor.setDoc('word '.repeat(20_000));
      expect(editor.view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false);
      expect(toasts.length).toBe(1); // already degraded → no second toast
      // A normal document gets wrapping (the user preference) and the language back.
      editor.setDoc('# ok\n\npara\n');
      expect(editor.hasLongLine()).toBe(false);
      expect(editor.languageTier()).toBe('full');
      expect(editor.view.contentDOM.classList.contains('cm-lineWrapping')).toBe(true);
    });

    it('a small document keeps the full markdown language and nested code languages', () => {
      const { editor, toasts } = setup('# t\n\n```js\nlet x = 1\n```\n');
      expect(editor.languageTier()).toBe('full');
      const lang = editor.view.state.facet(language);
      expect(lang?.name).toBe('markdown');
      expect(toasts).toEqual([]);
    });

    it('above 128 KB keeps markdown without code languages and toasts once; above 256 KB drops the language', () => {
      const { editor, toasts } = setup();
      editor.setDoc(lines(LANGUAGE_TIER_FULL_MAX + 10));
      expect(editor.languageTier()).toBe('markdown');
      expect(editor.view.state.facet(language)?.name).toBe('markdown');
      expect(toasts.map((t) => t.text)).toEqual([LARGE_DOC_TOAST]);

      // Staying degraded (markdown → none) does not toast again.
      editor.setDoc(lines(LANGUAGE_TIER_MARKDOWN_MAX + 10));
      expect(editor.languageTier()).toBe('none');
      expect(editor.view.state.facet(language)).toBeNull();
      expect(toasts.length).toBe(1);

      // Editing never re-evaluates the tier.
      editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length - 2, insert: '' } });
      expect(editor.languageTier()).toBe('none');
      expect(editor.view.state.facet(language)).toBeNull();

      // Loading a small document restores the full language; a later downgrade toasts again.
      editor.setDoc('small');
      expect(editor.languageTier()).toBe('full');
      expect(editor.view.state.facet(language)?.name).toBe('markdown');
      editor.setDoc(lines(LANGUAGE_TIER_MARKDOWN_MAX + 10));
      expect(toasts.length).toBe(2);
    });
  });

  it('dispose destroys the view and stops every notification', () => {
    vi.useFakeTimers();
    try {
      const { parent, editor, registry } = setup('abc');
      const cursor = vi.fn();
      const changes = vi.fn();
      editor.onCursor(cursor);
      editor.onChanges(changes);
      const before = editor.version;
      editor.dispose();
      expect(parent.querySelector('.cm-editor')).toBeNull();
      editor.view.dispatch({ changes: { from: 0, insert: 'z' } });
      registry.register({ id: 'edit.bold', title: 'b', shortcut: 'Mod-Shift-b', scope: 'editor', run() {} });
      vi.runOnlyPendingTimers();
      expect(cursor).not.toHaveBeenCalled();
      expect(changes).not.toHaveBeenCalled();
      expect(editor.version).toBe(before);
      editor.dispose(); // idempotent
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposeEditor(api) reaches the same teardown through the WeakMap', () => {
    const { parent, editor } = setup('x');
    disposeEditor(editor);
    expect(parent.querySelector('.cm-editor')).toBeNull();
  });

  it('a real Backspace keydown after a list marker removes the marker (our binding beats lang-markdown\'s)', () => {
    const { editor } = setup('- 甲\n- 乙\n- [ ] ');
    const key = () => editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    editor.view.dispatch({ selection: { anchor: 6 } }); // after "- " on line 2
    key();
    expect(editor.getText()).toBe('- 甲\n乙\n- [ ] ');
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    key();
    expect(editor.getText()).toBe('- 甲\n乙\n');
  });

  it('runs registered commands against the live view', () => {
    const { editor, registry } = setup('word');
    editor.view.dispatch({ selection: { anchor: 0, head: 4 } });
    expect(registry.run('edit.bold')).toBe(true);
    expect(editor.getText()).toBe('**word**');
    registry.run('edit.heading2');
    expect(editor.getText()).toBe('## **word**');
    registry.run('edit.find');
    expect(editor.view.dom.querySelector('.cm-panel.cm-search')).not.toBeNull();
  });
});
