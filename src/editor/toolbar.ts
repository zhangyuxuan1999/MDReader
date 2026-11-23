// src/editor/toolbar.ts — header buttons bound to registry commands (SPEC §7, CONTRACT §2).
// Buttons are created once; titles/enabled state follow the registry via onChange.
import type { CommandId, CreateToolbar, Mode, ResolvedTheme, ToolbarApi } from '../shared/types';
import { formatShortcut } from '../shared/keys';
import { T } from '../shared/i18n';

type Item = CommandId | 'sep';

interface ToolbarExtras {
  /** Reflects the resolved theme on the theme button (icon + aria-pressed + is-active). */
  setTheme(t: ResolvedTheme): void;
  /** Pressed state of the 「预览可编辑」 toggle (CONTRACT §11). */
  setPreviewEdit(on: boolean): void;
  /** App's hook for editor-scope buttons (see setToolbarEditorRouter). */
  router: ((id: CommandId) => boolean) | null;
  /** Releases the registry subscription and removes every element the toolbar created. */
  dispose(): void;
}
/** ToolbarApi (shared/types) is frozen, so these live in a side table keyed by the returned api. */
const extras = new WeakMap<ToolbarApi, ToolbarExtras>();

/** Shows `t` as the active theme on the toolbar's theme button (no-op for an unknown toolbar). */
export function setToolbarTheme(toolbar: ToolbarApi, t: ResolvedTheme): void {
  extras.get(toolbar)?.setTheme(t);
}

/** Shows whether in-preview editing is on (aria-pressed + is-active on the pencil-on-page button). */
export function setToolbarPreviewEdit(toolbar: ToolbarApi, on: boolean): void {
  extras.get(toolbar)?.setPreviewEdit(on);
}

/** App can claim a click on an editor-scope button before it reaches CodeMirror: while a block is being
 *  edited in the preview, 加粗 / 斜体 / 行内代码 / 链接 belong to that session, not to the hidden editor.
 *  `route(id)` returns true when it handled the click. */
export function setToolbarEditorRouter(toolbar: ToolbarApi, route: ((id: CommandId) => boolean) | null): void {
  const x = extras.get(toolbar);
  if (x) x.router = route;
}

/** Detaches a toolbar: registry subscription released, buttons removed (no-op if unknown). */
export function disposeToolbar(toolbar: ToolbarApi): void {
  extras.get(toolbar)?.dispose();
}

const LAYOUT: Item[] = [
  'file.new', 'file.open', 'file.save', 'sep',
  'edit.bold', 'edit.italic', 'edit.code', 'edit.link', 'edit.heading1', 'edit.heading2', 'edit.heading3', 'sep',
  'view.mode.edit', 'view.mode.split', 'view.mode.preview', 'view.togglePreviewEdit', 'sep',
  'view.toggleToc', 'view.toggleTheme', 'view.palette', 'file.exportHtml',
];

const MODE_BUTTON: Record<Mode, CommandId> = { edit: 'view.mode.edit', split: 'view.mode.split', preview: 'view.mode.preview' };

// The theme button shows which theme is active: sun in light, moon in dark (swapped by setTheme).
const SUN_PATH = 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4';
const MOON_PATH = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';

/** Fallback title (until the command is registered) and 16px icon body (24-unit viewBox, stroked). */
const ICONS: Partial<Record<CommandId, { title: string; svg: string }>> = {
  'file.new': { title: T.fileNew, svg: p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 18v-6 M9 15h6') },
  'file.open': { title: T.fileOpen, svg: p('M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z') },
  'file.save': { title: T.fileSave, svg: p('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8') },
  'edit.bold': { title: T.bold, svg: p('M7 4h7a4 4 0 0 1 0 8H7z M7 12h8a4 4 0 0 1 0 8H7z') },
  'edit.italic': { title: T.italic, svg: p('M19 4h-9 M14 20H5 M15 4L9 20') },
  'edit.code': { title: T.inlineCode, svg: p('M16 18l6-6-6-6 M8 6l-6 6 6 6') },
  'edit.link': { title: T.link, svg: p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71') },
  'edit.heading1': { title: `${T.heading} 1`, svg: txt('H1') },
  'edit.heading2': { title: `${T.heading} 2`, svg: txt('H2') },
  'edit.heading3': { title: `${T.heading} 3`, svg: txt('H3') },
  'view.mode.edit': { title: T.modeEdit, svg: p('M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z') },
  'view.mode.split': { title: T.modeSplit, svg: p('M3 4h18v16H3z M12 4v16') },
  'view.mode.preview': { title: T.modePreview, svg: p('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z') },
  // Pencil on a page: 「预览可编辑」 (the string lives here because src/shared/i18n.ts is frozen).
  'view.togglePreviewEdit': { title: '预览可编辑（实验性）', svg: p('M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5 M8 8h6 M8 12h4 M19.1 11.9a1.8 1.8 0 0 1 2.5 2.5L15.5 20.5l-3.3.8.8-3.3z') },
  'view.toggleToc': { title: T.toggleToc, svg: p('M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01') },
  'view.toggleTheme': { title: T.toggleTheme, svg: p(SUN_PATH) },
  'view.palette': { title: T.palette, svg: p('M4 17l6-6-6-6 M12 19h8') },
  'file.exportHtml': { title: T.fileExportHtml, svg: p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3') },
};

function p(d: string): string {
  return `<path d="${d}"/>`;
}
function txt(s: string): string {
  return `<text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" stroke="none">${s}</text>`;
}

export const createToolbar: CreateToolbar = (parent, registry) => {
  const doc = parent.ownerDocument;
  const buttons = new Map<CommandId, HTMLButtonElement>();
  const owned: HTMLElement[] = [];

  for (const item of LAYOUT) {
    if (item === 'sep') {
      const sep = doc.createElement('span');
      sep.className = 'mdr-toolbar__sep';
      parent.appendChild(sep);
      owned.push(sep);
      continue;
    }
    const icon = ICONS[item]!;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'mdr-toolbar__btn';
    btn.dataset.cmd = item;
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg>`;
    // Keep the editor's focus when clicking (so editor commands act on the live selection).
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      const cmd = registry.get(item);
      if (cmd?.scope === 'editor' && extras.get(api)?.router?.(item)) return;
      registry.run(item);
      if (cmd?.scope === 'editor') focusEditor(doc);
    });
    parent.appendChild(btn);
    owned.push(btn);
    buttons.set(item, btn);
  }

  const refresh = (): void => {
    for (const [id, btn] of buttons) {
      const cmd = registry.get(id);
      const title = cmd ? cmd.title + (cmd.shortcut ? ` (${formatShortcut(cmd.shortcut)})` : '') : ICONS[id]!.title;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.disabled = !cmd || cmd.enabled?.() === false;
    }
  };
  refresh();
  const offRegistry = registry.onChange(refresh);

  // Every accessor tolerates a disposed toolbar (buttons map emptied) so a late App callback is a no-op.
  const setActive = (id: CommandId, on: boolean): void => {
    const btn = buttons.get(id);
    if (!btn) return;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  };

  const api: ToolbarApi = {
    setMode(m) {
      for (const mode of Object.keys(MODE_BUTTON) as Mode[]) setActive(MODE_BUTTON[mode], mode === m);
    },
    setDirty(d) {
      buttons.get('file.save')?.classList.toggle('is-dirty', d);
    },
    setTocVisible(on) {
      setActive('view.toggleToc', on);
    },
  };

  extras.set(api, {
    router: null,
    setPreviewEdit(on) {
      setActive('view.togglePreviewEdit', on);
    },
    setTheme(t) {
      const btn = buttons.get('view.toggleTheme');
      if (!btn) return;
      const dark = t === 'dark';
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${p(dark ? MOON_PATH : SUN_PATH)}</svg>`;
      setActive('view.toggleTheme', dark);
    },
    dispose() {
      offRegistry();
      for (const el of owned) el.remove();
      owned.length = 0;
      buttons.clear();
    },
  });
  return api;
};

/** Focuses the CodeMirror content unless focus is already inside the editor. */
function focusEditor(doc: Document): void {
  if (doc.activeElement?.closest('.cm-editor')) return;
  (doc.querySelector('.cm-editor .cm-content') as HTMLElement | null)?.focus();
}
