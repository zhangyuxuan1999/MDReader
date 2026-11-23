// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createPalette, disposePalette, filterCommands, fuzzyScore } from '../src/editor/palette';
import { createToolbar, disposeToolbar, setToolbarTheme } from '../src/editor/toolbar';
import { createFakeRegistry } from './editor.helpers';
import type { Command } from '../src/shared/types';

const cmds: Command[] = [
  { id: 'file.save', title: '保存', shortcut: 'Mod-s', scope: 'global', run() {} },
  { id: 'file.saveAs', title: '另存为', shortcut: 'Mod-Shift-s', scope: 'global', run() {} },
  { id: 'edit.bold', title: '加粗', shortcut: 'Mod-b', scope: 'editor', run() {} },
  { id: 'view.toggleTheme', title: '切换主题', scope: 'global', run() {}, enabled: () => false },
];

beforeEach(() => {
  document.body.replaceChildren();
});

describe('fuzzy matching', () => {
  it('matches subsequences and prefers tighter matches', () => {
    expect(fuzzyScore('sv', 'file.save')).toBeGreaterThanOrEqual(0);
    expect(fuzzyScore('xyz', 'file.save')).toBe(-1);
    expect(fuzzyScore('save', 'file.save')).toBeLessThan(fuzzyScore('sae', 'file.save'));
  });

  it('filters over title and id, case-insensitively, keeping everything for an empty query', () => {
    expect(filterCommands(cmds, '')).toEqual(cmds);
    expect(filterCommands(cmds, '保存').map((c) => c.id)).toEqual(['file.save']);
    expect(filterCommands(cmds, 'SAVE').map((c) => c.id)).toEqual(['file.save', 'file.saveAs']);
    expect(filterCommands(cmds, 'theme').map((c) => c.id)).toEqual(['view.toggleTheme']);
  });
});

describe('createPalette', () => {
  function setup() {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const registry = createFakeRegistry();
    for (const c of cmds) registry.register(c);
    const editorFocus = document.createElement('div');
    editorFocus.tabIndex = 0;
    document.body.appendChild(editorFocus);
    editorFocus.focus();
    const palette = createPalette(overlay, registry);
    const root = overlay.querySelector<HTMLElement>('.mdr-palette')!;
    const input = root.querySelector<HTMLInputElement>('.mdr-palette__input')!;
    const items = () => [...root.querySelectorAll<HTMLElement>('.mdr-palette__item')];
    return { registry, palette, root, input, items, editorFocus };
  }

  it('is hidden by default and lists every command on open', () => {
    const { palette, root, input, items } = setup();
    expect(root.hidden).toBe(true);
    expect(palette.isOpen()).toBe(false);
    palette.open();
    expect(root.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(items().map((li) => li.dataset.cmd)).toEqual(cmds.map((c) => c.id));
    expect(items()[0].classList.contains('is-active')).toBe(true);
    expect(items()[0].querySelector('kbd')?.textContent).toMatch(/S$/);
    expect(items()[3].classList.contains('is-disabled')).toBe(true);
  });

  it('filters while typing, navigates with arrows and runs with Enter, then refocuses', () => {
    const { palette, registry, input, items, editorFocus } = setup();
    palette.open();
    input.value = 'save';
    input.dispatchEvent(new Event('input'));
    expect(items().map((li) => li.dataset.cmd)).toEqual(['file.save', 'file.saveAs']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(items()[1].classList.contains('is-active')).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(items()[0].classList.contains('is-active')).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(registry.ran).toEqual(['file.saveAs']);
    expect(palette.isOpen()).toBe(false);
    expect(document.activeElement).toBe(editorFocus);
  });

  it('hovering an item makes it the Enter target', () => {
    const { palette, registry, input, items } = setup();
    palette.open();
    expect(items()[0].classList.contains('is-active')).toBe(true);
    items()[2].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(items().map((li) => li.classList.contains('is-active'))).toEqual([false, false, true, false]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(registry.ran).toEqual(['edit.bold']);
  });

  it('falls back to the editor when the previous focus was the body (e.g. the preview was clicked)', () => {
    const { palette, root, editorFocus } = setup();
    // A CodeMirror-shaped focus target, and focus on <body> as after a click in the preview.
    const cm = document.createElement('div');
    cm.className = 'cm-editor';
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.tabIndex = 0;
    cm.appendChild(content);
    document.body.appendChild(cm);
    editorFocus.blur();
    expect(document.activeElement).toBe(document.body);

    palette.open();
    root.querySelector<HTMLInputElement>('.mdr-palette__input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(palette.isOpen()).toBe(false);
    expect(document.activeElement).toBe(content);
  });

  it('dispose removes the palette element and its listeners', () => {
    const { palette, root, registry } = setup();
    palette.open();
    disposePalette(palette);
    expect(root.isConnected).toBe(false);
    expect(document.querySelector('.mdr-palette')).toBeNull();
    root.querySelector<HTMLElement>('.mdr-palette__item')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(registry.ran).toEqual([]);
  });

  it('Escape closes, click runs, disabled items do not run', () => {
    const { palette, registry, input, items } = setup();
    palette.open();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(palette.isOpen()).toBe(false);
    palette.open();
    items()[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(registry.ran).toEqual([]);
    expect(palette.isOpen()).toBe(true);
    items()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(registry.ran).toEqual(['edit.bold']);
    expect(palette.isOpen()).toBe(false);
  });
});

describe('createToolbar', () => {
  it('creates buttons with data-cmd, titles with shortcuts, enabled state and mode highlighting', () => {
    const header = document.createElement('header');
    document.body.appendChild(header);
    const registry = createFakeRegistry();
    for (const c of cmds) registry.register(c);
    const toolbar = createToolbar(header, registry);
    const btn = (id: string) => header.querySelector<HTMLButtonElement>(`.mdr-toolbar__btn[data-cmd="${id}"]`)!;
    expect(btn('file.save').title).toMatch(/^保存 \(.*S\)$/);
    expect(btn('file.save').querySelector('svg')).not.toBeNull();
    expect(btn('view.toggleTheme').disabled).toBe(true);
    expect(btn('view.mode.edit').disabled).toBe(true); // not registered yet
    registry.register({ id: 'view.mode.edit', title: '编辑', scope: 'global', run() {} });
    expect(btn('view.mode.edit').disabled).toBe(false);
    expect(header.querySelectorAll('.mdr-toolbar__sep').length).toBe(3);

    toolbar.setMode('split');
    expect(btn('view.mode.split').classList.contains('is-active')).toBe(true);
    expect(btn('view.mode.edit').classList.contains('is-active')).toBe(false);
    toolbar.setDirty(true);
    expect(btn('file.save').classList.contains('is-dirty')).toBe(true);
    toolbar.setTocVisible(true);
    expect(btn('view.toggleToc').getAttribute('aria-pressed')).toBe('true');

    btn('file.save').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(registry.ran).toEqual(['file.save']);
  });

  it('setToolbarTheme swaps the theme icon and reflects it in aria-pressed', () => {
    const header = document.createElement('header');
    document.body.appendChild(header);
    const registry = createFakeRegistry();
    const toolbar = createToolbar(header, registry);
    const btn = header.querySelector<HTMLButtonElement>('.mdr-toolbar__btn[data-cmd="view.toggleTheme"]')!;
    setToolbarTheme(toolbar, 'light');
    const light = btn.innerHTML;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.classList.contains('is-active')).toBe(false);
    setToolbarTheme(toolbar, 'dark');
    expect(btn.innerHTML).not.toBe(light);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('is-active')).toBe(true);
    setToolbarTheme(toolbar, 'light');
    expect(btn.innerHTML).toBe(light);
    // A refresh (registry change) must not undo the icon swap.
    setToolbarTheme(toolbar, 'dark');
    const dark = btn.innerHTML;
    registry.register({ id: 'view.toggleTheme', title: '切换主题', scope: 'global', run() {} });
    expect(btn.innerHTML).toBe(dark);
  });

  it('disposeToolbar releases the registry subscription and removes the buttons', () => {
    const header = document.createElement('header');
    document.body.appendChild(header);
    const registry = createFakeRegistry();
    const toolbar = createToolbar(header, registry);
    const save = header.querySelector<HTMLButtonElement>('.mdr-toolbar__btn[data-cmd="file.save"]')!;
    const before = save.title;
    disposeToolbar(toolbar);
    expect(header.querySelectorAll('.mdr-toolbar__btn').length).toBe(0);
    expect(header.querySelectorAll('.mdr-toolbar__sep').length).toBe(0);
    registry.register({ id: 'file.save', title: '保存X', scope: 'global', run() {} });
    expect(save.title).toBe(before);           // the detached toolbar is no longer driven by the registry
    expect(() => { toolbar.setMode('split'); toolbar.setDirty(true); toolbar.setTocVisible(false); }).not.toThrow();
  });
});
