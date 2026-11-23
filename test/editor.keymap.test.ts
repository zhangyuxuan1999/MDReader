// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { commandKeymap, dedentListItem, deleteListMarkerBackward, indentListItem, keymapSignature } from '../src/editor/keymap';
import { createFakeRegistry, installLayoutStubs } from './editor.helpers';

installLayoutStubs();

function mdView(doc: string, cursor: number, withLanguage = true): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: withLanguage ? [markdown({ base: markdownLanguage })] : [] }),
    parent,
  });
  return view;
}

describe('commandKeymap', () => {
  it('creates one binding per editor-scope command with a shortcut, running through the registry', () => {
    const registry = createFakeRegistry();
    registry.register({ id: 'edit.bold', title: '加粗', shortcut: 'Mod-b', scope: 'editor', run() {} });
    registry.register({ id: 'edit.find', title: '查找', scope: 'editor', run() {} });
    registry.register({ id: 'file.save', title: '保存', shortcut: 'Mod-s', scope: 'global', run() {} });
    const bindings = commandKeymap(registry);
    expect(bindings.map((b) => b.key)).toEqual(['Mod-b']);
    expect(bindings[0].preventDefault).toBe(true);
    const view = mdView('', 0);
    expect(bindings[0].run!(view)).toBe(true);
    expect(registry.ran).toEqual(['edit.bold']);
  });

  it('keymapSignature changes only when editor-scope shortcuts change', () => {
    const registry = createFakeRegistry();
    registry.register({ id: 'edit.bold', title: 'b', shortcut: 'Mod-b', scope: 'editor', run() {} });
    const a = keymapSignature(registry);
    registry.register({ id: 'file.save', title: 's', shortcut: 'Mod-s', scope: 'global', run() {} });
    expect(keymapSignature(registry)).toBe(a);
    registry.register({ id: 'edit.italic', title: 'i', shortcut: 'Mod-i', scope: 'editor', run() {} });
    expect(keymapSignature(registry)).not.toBe(a);
  });
});

describe('Tab inside lists', () => {
  it('indents a list item by its marker width and dedents it back', () => {
    const view = mdView('- a\n- b', 5);
    expect(indentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b');
    expect(dedentListItem(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n- b');
  });

  it('uses the ordered-list marker width', () => {
    const view = mdView('1. a\n2. b', 7);
    indentListItem(view);
    expect(view.state.doc.toString()).toBe('1. a\n   2. b');
  });

  it('falls back to indentMore / indentLess outside a list item', () => {
    const view = mdView('text', 2);
    indentListItem(view);
    expect(view.state.doc.toString()).toBe('  text');
    dedentListItem(view);
    expect(view.state.doc.toString()).toBe('text');
  });
});

describe('Tab inside quoted lists', () => {
  it('indents after the blockquote prefix, never before it', () => {
    const view = mdView('> - a\n> - b', 9);
    indentListItem(view);
    expect(view.state.doc.toString()).toBe('> - a\n>   - b');
    dedentListItem(view);
    expect(view.state.doc.toString()).toBe('> - a\n> - b');
  });
});

describe('Backspace after a list marker', () => {
  it('removes the marker and its indentation instead of leaving blank space', () => {
    const view = mdView('- 甲\n- 乙', 6); // after "- " on line 2
    expect(deleteListMarkerBackward(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- 甲\n乙');
  });

  it('turns an empty task item into an empty line', () => {
    const view = mdView('- [ ] ', 6);
    expect(deleteListMarkerBackward(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });

  it('drops nested indentation with the marker and keeps a blockquote prefix', () => {
    const nested = mdView('- a\n  - b', 8);
    deleteListMarkerBackward(nested);
    expect(nested.state.doc.toString()).toBe('- a\nb');
    const quoted = mdView('> - a', 4);
    deleteListMarkerBackward(quoted);
    expect(quoted.state.doc.toString()).toBe('> a');
  });

  it('works without the markdown language (size-gated large documents)', () => {
    const view = mdView('1. item', 3, false);
    expect(deleteListMarkerBackward(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('item');
  });

  it('falls through when the cursor is not right after a marker or the selection is not empty', () => {
    const mid = mdView('- ab', 4);
    expect(deleteListMarkerBackward(mid)).toBe(false); // upstream: nothing to do → default keymap
    expect(mid.state.doc.toString()).toBe('- ab');
    const sel = mdView('- ab', 2);
    sel.dispatch({ selection: { anchor: 0, head: 2 } });
    expect(deleteListMarkerBackward(sel)).toBe(false);
    expect(sel.state.doc.toString()).toBe('- ab');
  });
});
