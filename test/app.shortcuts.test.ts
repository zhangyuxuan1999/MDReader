// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../src/app/registry';
import { historyKey, installShortcuts } from '../src/app/shortcuts';
import { IS_MAC } from '../src/shared/keys';

/** KeyboardEvent with Mod mapped to the platform modifier (same rule as keys.ts). */
function key(k: string, mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {}, target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: k,
    metaKey: !!mods.mod && IS_MAC,
    ctrlKey: !!mods.mod && !IS_MAC,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

describe('installShortcuts', () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
    document.body.innerHTML = '';
  });

  const setup = () => {
    const registry = createCommandRegistry();
    const save = vi.fn();
    const cycle = vi.fn();
    const bold = vi.fn();
    registry.register({ id: 'file.save', title: '保存', shortcut: 'Mod-s', scope: 'global', run: save });
    registry.register({ id: 'view.cycleMode', title: '切换模式', shortcut: 'Mod-/', scope: 'global', run: cycle });
    registry.register({ id: 'edit.bold', title: '加粗', shortcut: 'Mod-b', scope: 'editor', run: bold });
    offs.push(installShortcuts(registry));
    return { registry, save, cycle, bold };
  };

  it('runs matching global commands and prevents the default', () => {
    const { save, cycle } = setup();
    const e = key('s', { mod: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    key('/', { mod: true });
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('ignores editor-scope commands, plain keys and wrong modifiers', () => {
    const { save, bold } = setup();
    key('b', { mod: true });
    expect(bold).not.toHaveBeenCalled();
    key('s');
    key('s', { mod: true, shift: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('intercepts Mod-s from inside the editor (event bubbling up from a child)', () => {
    const { save } = setup();
    const editor = document.createElement('div');
    editor.className = 'cm-content';
    document.body.appendChild(editor);
    const e = key('s', { mod: true }, editor);
    expect(save).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('skips commands while the palette or a dialog owns the target, but still swallows Mod-s', () => {
    const { save, cycle } = setup();
    const palette = document.createElement('div');
    palette.className = 'mdr-palette';
    const input = document.createElement('input');
    palette.appendChild(input);
    document.body.appendChild(palette);
    key('/', { mod: true }, input);
    expect(cycle).not.toHaveBeenCalled();
    const e = key('s', { mod: true }, input);
    expect(save).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('routes an editor-scope shortcut to hooks.editorCommand outside the editor / inputs / overlay', () => {
    const registry = createCommandRegistry();
    const editorCommand = vi.fn();
    const find = vi.fn();
    const bold = vi.fn();
    registry.register({ id: 'edit.find', title: '查找', shortcut: 'Mod-f', scope: 'editor', run: find });
    registry.register({ id: 'edit.bold', title: '加粗', shortcut: 'Mod-b', scope: 'editor', run: bold });
    offs.push(installShortcuts(registry, window, { editorCommand }));
    const preview = document.createElement('div');
    preview.className = 'mdr-preview';
    const cm = document.createElement('div');
    cm.className = 'cm-editor';
    const cmContent = document.createElement('div');
    cm.appendChild(cmContent);
    const input = document.createElement('input');
    const palette = document.createElement('div');
    palette.className = 'mdr-palette';
    const paletteInput = document.createElement('input');
    palette.appendChild(paletteInput);
    document.body.append(preview, cm, input, palette);

    // ⌘F from the preview: the preview evicts far-away blocks, so the editor's search panel wins.
    let e = key('f', { mod: true }, preview);
    expect(editorCommand.mock.calls).toEqual([['edit.find']]);
    expect(e.defaultPrevented).toBe(true);
    // ⌘B in 预览 used to do nothing at all while the 格式 menu still showed it as available.
    e = key('b', { mod: true }, preview);
    expect(editorCommand.mock.calls).toEqual([['edit.find'], ['edit.bold']]);
    expect(e.defaultPrevented).toBe(true);
    e = key('b', { mod: true }, document.body);
    expect(editorCommand).toHaveBeenCalledTimes(3);

    // The command itself is never run here — App decides how to bring the editor back first.
    expect(find).not.toHaveBeenCalled();
    expect(bold).not.toHaveBeenCalled();

    key('f', { mod: true }, cmContent);      // CodeMirror's own keymap owns it
    key('b', { mod: true }, cmContent);
    key('f', { mod: true }, input);          // native find-in-field behaviour
    key('b', { mod: true }, paletteInput);   // overlay owns the target
    key('b', { mod: true, shift: true }, preview);
    key('b', {}, preview);
    expect(editorCommand).toHaveBeenCalledTimes(3);
  });

  it('decision U2: ⌘Z / ⇧⌘Z outside the editor, inputs, contenteditables and overlays go to hooks.history', () => {
    const registry = createCommandRegistry();
    const history = vi.fn();
    offs.push(installShortcuts(registry, window, { history }));
    const preview = document.createElement('div');
    preview.className = 'mdr-preview';
    const btn = document.createElement('button');
    const cm = document.createElement('div');
    cm.className = 'cm-editor';
    const cmContent = document.createElement('div');
    cmContent.setAttribute('contenteditable', 'true');
    cm.appendChild(cmContent);
    const session = document.createElement('section');
    session.setAttribute('contenteditable', 'true');
    preview.appendChild(session);
    const input = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.className = 'mdr-dialog';
    document.body.append(preview, btn, cm, input, dialog);

    let e = key('z', { mod: true }, preview);
    expect(history.mock.calls).toEqual([[false]]);
    expect(e.defaultPrevented).toBe(true);
    e = key('Z', { mod: true, shift: true }, btn);
    expect(history.mock.calls).toEqual([[false], [true]]);
    expect(e.defaultPrevented).toBe(true);
    key('z', { mod: true }, document.body);
    expect(history).toHaveBeenCalledTimes(3);

    // Everything that has its own undo keeps it.
    for (const t of [cmContent, session, input, dialog]) {
      e = key('z', { mod: true }, t);
      expect(e.defaultPrevented).toBe(false);
    }
    key('z', {}, preview);                          // plain z
    key('z', { mod: true, alt: true }, preview);
    expect(history).toHaveBeenCalledTimes(3);
  });

  it('historyKey: the keys of CodeMirror\'s historyKeymap', () => {
    const k = (key: string, mods: { mod?: boolean; shift?: boolean }) =>
      new KeyboardEvent('keydown', { key, metaKey: !!mods.mod && IS_MAC, ctrlKey: !!mods.mod && !IS_MAC, shiftKey: !!mods.shift });
    expect(historyKey(k('z', { mod: true }))).toBe('undo');
    expect(historyKey(k('Z', { mod: true, shift: true }))).toBe('redo');
    expect(historyKey(k('y', { mod: true }))).toBe(IS_MAC ? null : 'redo');
    expect(historyKey(k('z', {}))).toBeNull();
  });

  it('an editor-scope shortcut inside a contenteditable goes to hooks.editableCommand (true = handled)', () => {
    const registry = createCommandRegistry();
    const editorCommand = vi.fn();
    const handled = new Set(['edit.heading1']);
    const editableCommand = vi.fn((id: string) => handled.has(id));
    registry.register({ id: 'edit.heading1', title: '标题 1', shortcut: 'Mod-1', scope: 'editor', run: vi.fn() });
    registry.register({ id: 'edit.bold', title: '加粗', shortcut: 'Mod-b', scope: 'editor', run: vi.fn() });
    offs.push(installShortcuts(registry, window, { editorCommand, editableCommand }));
    const session = document.createElement('section');
    session.setAttribute('contenteditable', 'true');
    const inner = document.createElement('strong');
    session.appendChild(inner);
    const cm = document.createElement('div');
    cm.className = 'cm-editor';
    const cmContent = document.createElement('div');
    cmContent.setAttribute('contenteditable', 'true');
    cm.appendChild(cmContent);
    const input = document.createElement('input');
    document.body.append(session, cm, input);

    let e = key('1', { mod: true }, inner);
    expect(editableCommand.mock.calls).toEqual([['edit.heading1', session]]);
    expect(e.defaultPrevented).toBe(true);
    e = key('b', { mod: true }, inner);           // not handled by App → left to the session
    expect(editableCommand).toHaveBeenCalledTimes(2);
    expect(e.defaultPrevented).toBe(false);
    // CodeMirror's own contenteditable and plain inputs are not "a contenteditable" here.
    key('1', { mod: true }, cmContent);
    key('1', { mod: true }, input);
    expect(editableCommand).toHaveBeenCalledTimes(2);
    expect(editorCommand).not.toHaveBeenCalled();
  });

  it('runs no editor-scope command when no hook is installed', () => {
    const { bold } = setup();
    key('b', { mod: true }, document.body);
    expect(bold).not.toHaveBeenCalled();
  });

  it('picks up commands registered after installation and stops after dispose', () => {
    const registry = createCommandRegistry();
    const off = installShortcuts(registry);
    const open = vi.fn();
    registry.register({ id: 'file.open', title: '打开', shortcut: 'Mod-o', scope: 'global', run: open });
    key('o', { mod: true });
    expect(open).toHaveBeenCalledTimes(1);
    off();
    key('o', { mod: true });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
