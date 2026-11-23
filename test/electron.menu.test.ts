// The zh-CN application menu template (CONTRACT §10).
// The load-bearing property: a command the renderer already binds must NOT register its accelerator
// natively, or ⌘S would save twice.
import { describe, expect, it, vi } from 'vitest';
import { buildMenuTemplate, customMenuItems } from '../electron/menu.mjs';

const build = (isDev = false) => {
  const send = vi.fn();
  const template = buildMenuTemplate({ appName: 'MDReader', send, isDev, isMac: true });
  return { send, template, items: customMenuItems(template) };
};

const topLabels = (template: any[]) => template.map((m) => m.label);
const byId = (items: any[], id: string) => items.find((i) => i.id === id);
const submenuOf = (template: any[], label: string) => template.find((m) => m.label === label).submenu as any[];

/** Every command id a native menu item must expose: the CommandIds of src/shared/types.ts plus the
 *  two shell-only history ids (src/app/native.ts EDIT_UNDO / EDIT_REDO — 撤销 / 重做 are custom items
 *  because AppKit's redo role cannot drive CodeMirror's history). */
const EXPECTED_COMMANDS = [
  'file.new', 'file.open', 'file.save', 'file.saveAs', 'file.exportHtml',
  'edit.undo', 'edit.redo',
  'edit.find', 'edit.gotoLine',
  'edit.bold', 'edit.italic', 'edit.code', 'edit.link',
  'edit.heading1', 'edit.heading2', 'edit.heading3', 'edit.heading4', 'edit.heading5', 'edit.heading6',
  'edit.paragraph', 'edit.toggleTask',
  'view.mode.edit', 'view.mode.split', 'view.mode.preview', 'view.cycleMode',
  'view.toggleToc', 'view.toggleTheme', 'view.palette', 'view.mountAll',
  'view.togglePreviewEdit',
];

describe('buildMenuTemplate', () => {
  it('has the zh-CN top level menus in order', () => {
    const { template } = build();
    expect(topLabels(template)).toEqual(['MDReader', '文件', '编辑', '格式', '视图', '窗口']);
  });

  it('exposes every CommandId exactly once', () => {
    const { items } = build();
    const ids = items.map((i) => i.id);
    expect([...ids].sort()).toEqual([...EXPECTED_COMMANDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('clicking an item sends its CommandId through the bridge', () => {
    const { send, items } = build();
    byId(items, 'file.save').click();
    byId(items, 'edit.heading3').click();
    byId(items, 'edit.redo').click();
    expect(send.mock.calls.map((c) => c[0])).toEqual(['file.save', 'edit.heading3', 'edit.redo']);
  });

  it('never registers an accelerator the renderer already binds', () => {
    const { items } = build();
    // src/app/App.ts + src/editor/commands.ts register a shortcut for everything except file.new;
    // ⌘Z / ⇧⌘Z are CodeMirror's own historyKeymap, which is equally a renderer binding.
    const rendererBound = EXPECTED_COMMANDS.filter((id) => id !== 'file.new');
    for (const id of rendererBound) {
      expect(byId(items, id).registerAccelerator, `${id} must not register its accelerator`).toBe(false);
    }
    // file.new is registered by the renderer WITHOUT a shortcut, so the menu owns ⌘N.
    expect(byId(items, 'file.new').registerAccelerator).toBe(true);
    expect(byId(items, 'file.new').accelerator).toBe('CmdOrCtrl+N');
  });

  it('mirrors the renderer accelerators exactly', () => {
    const { items } = build();
    const expected: Record<string, string> = {
      'file.open': 'CmdOrCtrl+O',
      'file.save': 'CmdOrCtrl+S',
      'file.saveAs': 'Shift+CmdOrCtrl+S',
      'edit.undo': 'CmdOrCtrl+Z',
      'edit.redo': 'Shift+CmdOrCtrl+Z',
      'edit.find': 'CmdOrCtrl+F',
      'edit.gotoLine': 'Alt+CmdOrCtrl+G',
      'edit.bold': 'CmdOrCtrl+B',
      'edit.italic': 'CmdOrCtrl+I',
      'edit.code': 'CmdOrCtrl+E',
      'edit.link': 'CmdOrCtrl+K',
      'edit.paragraph': 'CmdOrCtrl+0',
      'edit.toggleTask': 'Shift+CmdOrCtrl+X',
      'view.cycleMode': 'CmdOrCtrl+/',
      'view.toggleToc': 'Shift+CmdOrCtrl+O',
      'view.toggleTheme': 'Shift+CmdOrCtrl+L',
      'view.palette': 'Shift+CmdOrCtrl+P',
      'view.togglePreviewEdit': 'Shift+CmdOrCtrl+E',
    };
    for (const [id, accel] of Object.entries(expected)) expect(byId(items, id).accelerator).toBe(accel);
    for (let n = 1; n <= 6; n++) expect(byId(items, `edit.heading${n}`).accelerator).toBe(`CmdOrCtrl+${n}`);
    // Commands with no renderer shortcut get no accelerator either.
    for (const id of ['file.exportHtml', 'view.mode.edit', 'view.mode.split', 'view.mode.preview', 'view.mountAll']) {
      expect(byId(items, id).accelerator).toBeUndefined();
    }
  });

  it('keeps the standard roles (they own their own accelerators)', () => {
    const { template } = build();
    const roles = (label: string) => submenuOf(template, label).map((i) => i.role).filter(Boolean);
    expect(roles('MDReader')).toEqual(expect.arrayContaining(['about', 'hide', 'hideOthers', 'unhide', 'quit']));
    expect(roles('文件')).toEqual(expect.arrayContaining(['recentDocuments', 'close']));
    // 撤销 / 重做 are deliberately NOT roles: Chromium's Redo editor command cannot reach
    // CodeMirror 6's history, so 编辑 → 重做 was a dead menu item. They are custom items that the
    // renderer answers with CodeMirror's undo/redo (electron/menu.mjs, src/app/native.ts).
    expect(roles('编辑')).toEqual(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']);
    expect(roles('窗口')).toEqual(['minimize', 'zoom', 'front']);
    for (const item of submenuOf(template, '编辑')) {
      if (item.role) expect(item.registerAccelerator).toBeUndefined();
    }
  });

  it('打开最近 uses the native recentDocuments role', () => {
    const { template } = build();
    const recent = submenuOf(template, '文件').find((i) => i.role === 'recentDocuments');
    expect(recent.label).toBe('打开最近');
    expect(recent.submenu[0].role).toBe('clearRecentDocuments');
  });

  it('adds reload / devtools only in dev', () => {
    expect(submenuOf(build(false).template, '视图').some((i) => i.role === 'toggleDevTools')).toBe(false);
    expect(submenuOf(build(true).template, '视图').some((i) => i.role === 'toggleDevTools')).toBe(true);
    expect(submenuOf(build(true).template, '视图').some((i) => i.role === 'reload')).toBe(true);
  });

  it('视图 → 预览可编辑 sends view.togglePreviewEdit, shows ⇧⌘E and leaves the key to the renderer', () => {
    const { send, template, items } = build();
    const view = submenuOf(template, '视图');
    const item = view.find((i) => i.id === 'view.togglePreviewEdit');
    expect(item.label).toBe('预览可编辑（实验性）'); // release decision for 0.2.0: marked experimental
    expect(item.accelerator).toBe('Shift+CmdOrCtrl+E');
    // The renderer binds Mod-Shift-e itself (src/app/App.ts): registering it natively would toggle twice.
    expect(item.registerAccelerator).toBe(false);
    // A plain command item: the renderer owns the on/off state (no checkbox that could drift).
    expect(item.type).toBeUndefined();
    // Sits with the mode items, right after 切换模式.
    const ids = view.map((i) => i.id);
    expect(ids.indexOf('view.togglePreviewEdit')).toBe(ids.indexOf('view.cycleMode') + 1);
    byId(items, 'view.togglePreviewEdit').click();
    expect(send).toHaveBeenCalledWith('view.togglePreviewEdit');
  });

  it('drops the app menu and mac-only items off macOS', () => {
    const template = buildMenuTemplate({ appName: 'MDReader', send: () => {}, isMac: false });
    expect(topLabels(template)).toEqual(['文件', '编辑', '格式', '视图', '窗口']);
    expect(submenuOf(template, '编辑').some((i) => i.role === 'pasteAndMatchStyle')).toBe(false);
    expect(submenuOf(template, '窗口').some((i) => i.role === 'front')).toBe(false);
    // The command set is unchanged.
    expect(customMenuItems(template).map((i) => i.id).sort()).toEqual([...EXPECTED_COMMANDS].sort());
  });

  it('never assigns the same accelerator twice', () => {
    const { template, items } = build(true);
    const all: string[] = items.map((i) => i.accelerator).filter(Boolean);
    const roleAccels = template
      .flatMap((m: any) => m.submenu || [])
      .filter((i: any) => i.role)
      .map((i: any) => i.accelerator)
      .filter(Boolean);
    const combined = [...all, ...roleAccels];
    expect(new Set(combined).size).toBe(combined.length);
  });
});
