// electron/menu.mjs — the zh-CN application menu (CONTRACT §10).
//
// Every custom item sends a CommandId from src/shared/types.ts through the bridge
// (mdrNative.onCommand) and is built with `registerAccelerator: false`: the renderer already binds
// those keys (src/app/App.ts `reg(...)` + src/editor/commands.ts), so registering them natively as
// well would run the command twice. The accelerator is still DISPLAYED next to the label.
// `file.new` is the single exception — the renderer registers 'file.new' without a shortcut, so the
// menu owns ⌘N and must register it. See RENDERER_UNBOUND below.
//
// Role items (cut/copy/paste/selectAll/close/minimize/zoom/quit/…) keep their accelerators: they are
// handled by Chromium/AppKit, not by our command registry.
//
// 撤销 / 重做 are NOT roles (fix round 2). AppKit's `redo:` reaches Chromium's Redo editor command,
// which CodeMirror 6 cannot act on — CM prevents the historyUndo beforeinput and keeps its own
// history, so Chromium's redo stack is empty and 编辑 → 重做 did nothing at all. Both are custom
// items now, sent to the renderer like every other command (src/app/native.ts runs CodeMirror's
// undo/redo), with registerAccelerator:false so ⌘Z / ⇧⌘Z keep taking the CodeMirror keymap path
// that was always the working one.
//
// This module deliberately does NOT import 'electron' so test/electron.menu.test.ts can inspect the
// template in plain Node; main.mjs feeds it to Menu.buildFromTemplate().

/** Commands the renderer registers WITHOUT a keyboard shortcut → the native menu must register theirs. */
const RENDERER_UNBOUND = new Set(['file.new']);

/** Shell-only command ids (not CommandIds — src/shared/types.ts is frozen): the renderer handles
 *  them in src/app/native.ts, next to 'app.closeRequested'. */
export const EDIT_UNDO = 'edit.undo';
export const EDIT_REDO = 'edit.redo';

/**
 * @param {object} o
 * @param {string} o.appName
 * @param {(id: string) => void} o.send  forwards a CommandId to the focused renderer
 * @param {boolean} [o.isDev]            adds 重新加载 / 开发者工具 to 视图
 * @param {boolean} [o.isMac]
 */
export function buildMenuTemplate({ appName = 'MDReader', send, isDev = false, isMac = process.platform === 'darwin' }) {
  const cmd = (id, label, accelerator) => {
    const item = { id, label, click: () => send(id) };
    if (accelerator) item.accelerator = accelerator;
    // Uniformly false except for the one command the renderer leaves unbound.
    item.registerAccelerator = RENDERER_UNBOUND.has(id);
    return item;
  };
  const sep = { type: 'separator' };

  /** @type {any[]} */
  const template = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        sep,
        { role: 'services', label: '服务' },
        sep,
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        sep,
        { role: 'quit', label: `退出 ${appName}` },
      ],
    });
  }

  template.push({
    label: '文件',
    submenu: [
      cmd('file.new', '新建', 'CmdOrCtrl+N'),
      cmd('file.open', '打开…', 'CmdOrCtrl+O'),
      { role: 'recentDocuments', label: '打开最近', submenu: [{ role: 'clearRecentDocuments', label: '清除菜单' }] },
      sep,
      cmd('file.save', '保存', 'CmdOrCtrl+S'),
      cmd('file.saveAs', '另存为…', 'Shift+CmdOrCtrl+S'),
      cmd('file.exportHtml', '导出 HTML…'),
      sep,
      { role: 'close', label: '关闭窗口' },
    ],
  });

  template.push({
    label: '编辑',
    submenu: [
      cmd(EDIT_UNDO, '撤销', 'CmdOrCtrl+Z'),
      cmd(EDIT_REDO, '重做', 'Shift+CmdOrCtrl+Z'),
      sep,
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' }] : []),
      { role: 'selectAll', label: '全选' },
      sep,
      cmd('edit.find', '查找…', 'CmdOrCtrl+F'),
      cmd('edit.gotoLine', '跳转到行…', 'Alt+CmdOrCtrl+G'),
    ],
  });

  template.push({
    label: '格式',
    submenu: [
      cmd('edit.bold', '加粗', 'CmdOrCtrl+B'),
      cmd('edit.italic', '斜体', 'CmdOrCtrl+I'),
      cmd('edit.code', '行内代码', 'CmdOrCtrl+E'),
      cmd('edit.link', '链接', 'CmdOrCtrl+K'),
      sep,
      cmd('edit.heading1', '标题 1', 'CmdOrCtrl+1'),
      cmd('edit.heading2', '标题 2', 'CmdOrCtrl+2'),
      cmd('edit.heading3', '标题 3', 'CmdOrCtrl+3'),
      cmd('edit.heading4', '标题 4', 'CmdOrCtrl+4'),
      cmd('edit.heading5', '标题 5', 'CmdOrCtrl+5'),
      cmd('edit.heading6', '标题 6', 'CmdOrCtrl+6'),
      cmd('edit.paragraph', '正文', 'CmdOrCtrl+0'),
      sep,
      cmd('edit.toggleTask', '切换任务项', 'Shift+CmdOrCtrl+X'),
    ],
  });

  template.push({
    label: '视图',
    submenu: [
      cmd('view.mode.edit', '编辑'),
      cmd('view.mode.split', '分栏'),
      cmd('view.mode.preview', '预览'),
      cmd('view.cycleMode', '切换模式', 'CmdOrCtrl+/'),
      // In-preview editing (CONTRACT §11). A plain command item, not a checkbox: the renderer owns the
      // on/off truth (localStorage + ⇧⌘E + the toolbar toggle), and the frozen bridge
      // (src/shared/native.ts) has no renderer → shell channel for anything but NativeDocumentState, so a
      // native checkmark could only be guessed by main and would drift the first time the user toggled it
      // from the keyboard or the toolbar. The toolbar button shows the state (pressed = on).
      cmd('view.togglePreviewEdit', '预览可编辑（实验性）', 'Shift+CmdOrCtrl+E'),
      sep,
      cmd('view.toggleToc', '显示/隐藏目录', 'Shift+CmdOrCtrl+O'),
      cmd('view.toggleTheme', '切换主题', 'Shift+CmdOrCtrl+L'),
      cmd('view.palette', '命令面板', 'Shift+CmdOrCtrl+P'),
      cmd('view.mountAll', '全部渲染'),
      ...(isDev
        ? [sep, { role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }]
        : []),
    ],
  });

  template.push({
    label: '窗口',
    role: 'window',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      ...(isMac ? [sep, { role: 'front', label: '前置全部窗口' }] : []),
    ],
  });

  return template;
}

/** Flat list of {id, label, accelerator, registerAccelerator} for the custom (non-role) items — used by tests. */
export function customMenuItems(template) {
  const out = [];
  const walk = (items) => {
    for (const item of items || []) {
      if (item && item.id && typeof item.click === 'function') out.push(item);
      if (item && Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(template);
  return out;
}
