// src/app/shortcuts.ts — one capturing keydown listener on window for scope:'global' commands.
// Runs before CodeMirror's keymap (which skips already-prevented events), so Mod-s / Mod-/ etc.
// win even while the editor has focus. Skipped while the palette or a dialog owns the target.
//
// scope:'editor' commands live in CodeMirror's keymap, so they only fire while CM has focus. With
// focus anywhere else in the app (the preview pane, the TOC, the toolbar, the body) their keys used
// to do nothing at all while the native menu kept showing them as available — press ⌘B in 预览 and
// the app just sat there. Such a key is routed to `hooks.editorCommand(id)` instead, which App
// answers by bringing the editor back on screen, focusing it and running the command (SPEC §13 asks
// for exactly that for Mod-f: the preview evicts far-away blocks, so the browser's own find would be
// useless there — it is now the same path for every editor command). Inside the editor and inside
// text inputs the native / CodeMirror handling is left alone.
//
// Two more hooks for in-preview editing (CONTRACT §11, decisions U2 and the low finding "editor-only
// shortcuts do nothing inside a preview session"):
//   - `history(redo)`: ⌘Z / ⇧⌘Z (and Ctrl-Y off the Mac) pressed outside the editor, outside text inputs
//     and outside a contenteditable (the preview session handles its own ⌘Z) — the preview after Esc, the
//     toolbar, the TOC, nothing focused. App undoes / redoes the document through CodeMirror's history.
//   - `editableCommand(id, el)`: an editor-scope shortcut pressed INSIDE a contenteditable. Returns true when
//     App handled it (the default is then prevented); false leaves the key to the element (the preview
//     session implements ⌘B / ⌘I / ⌘E / ⌘K itself).
import type { Command, CommandId, CommandRegistry } from '../shared/types';
import { IS_MAC, matchShortcut } from '../shared/keys';

const OWNED_BY_OVERLAY = '.mdr-palette, .mdr-dialog';
const CONTENT_EDITABLE = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const HANDLES_OWN_KEYS = `.cm-editor, input, textarea, select, ${CONTENT_EDITABLE}`;

export interface ShortcutHooks {
  /** Runs for an editor-scope shortcut pressed outside the editor / text inputs / overlay. */
  editorCommand?(id: CommandId): void;
  /** ⌘Z (false) / ⇧⌘Z, Ctrl-Y (true) pressed where nothing handles its own undo. */
  history?(redo: boolean): void;
  /** An editor-scope shortcut pressed inside a contenteditable (not CodeMirror's); true = handled. */
  editableCommand?(id: CommandId, el: Element): boolean;
}

/** The undo / redo keys CodeMirror's historyKeymap binds: Mod-z, Mod-Shift-z, and Mod-y off the Mac. */
export function historyKey(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (matchShortcut(e, 'Mod-z')) return 'undo';
  if (matchShortcut(e, 'Mod-Shift-z') || (!IS_MAC && matchShortcut(e, 'Mod-y'))) return 'redo';
  return null;
}

export function installShortcuts(registry: CommandRegistry, target: Window = window, hooks: ShortcutHooks = {}): () => void {
  let globals: Command[] = [];
  let editors: Command[] = [];
  const refresh = (): void => {
    const all = registry.list().filter((c) => !!c.shortcut);
    globals = all.filter((c) => c.scope === 'global');
    editors = all.filter((c) => c.scope === 'editor');
  };
  refresh();
  const offChange = registry.onChange(refresh);

  const onKeyDown = (e: KeyboardEvent): void => {
    // Every global shortcut carries Mod; bail out early on plain typing (hot path while editing).
    if (!e.metaKey && !e.ctrlKey) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest(OWNED_BY_OVERLAY)) {
      // Never let the browser's own "save page" dialog appear on top of ours.
      if (matchShortcut(e, 'Mod-s')) e.preventDefault();
      return;
    }
    for (const c of globals) {
      if (!matchShortcut(e, c.shortcut!)) continue;
      e.preventDefault();
      registry.run(c.id);
      return;
    }
    if (el?.closest(HANDLES_OWN_KEYS)) {
      // CodeMirror, text inputs: their own handling. A contenteditable (the preview session) may hand an
      // editor-scope command it does not implement to App.
      const host = el.closest('.cm-editor, input, textarea, select') ? null : el.closest(CONTENT_EDITABLE);
      if (!host || !hooks.editableCommand) return;
      for (const c of editors) {
        if (!matchShortcut(e, c.shortcut!)) continue;
        if (hooks.editableCommand(c.id, host)) e.preventDefault();
        return;
      }
      return;
    }
    const h = hooks.history ? historyKey(e) : null;
    if (h) {
      e.preventDefault();
      hooks.history!(h === 'redo');
      return;
    }
    if (!hooks.editorCommand) return;
    for (const c of editors) {
      if (!matchShortcut(e, c.shortcut!)) continue;
      e.preventDefault();
      hooks.editorCommand(c.id);
      return;
    }
  };

  target.addEventListener('keydown', onKeyDown, true);
  return () => {
    target.removeEventListener('keydown', onKeyDown, true);
    offChange();
  };
}
