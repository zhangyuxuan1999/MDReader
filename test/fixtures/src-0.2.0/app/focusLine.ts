// src/app/focusLine.ts — the shell half of the focus-line contract (CONTRACT §9).
//
// One line is "focused" at a time, and whichever pane the user is working in owns it:
//   editor caret / typing → 'focus:line' {source:'editor'} → preview.setFocusLine(line)
//   preview click / selection → 'focus:line' {source:'preview'} → editor.setPeerLine(line)
// The editor drops its mirror by itself as soon as the caret moves there, so nothing here has to
// un-tint anything. Nothing scrolls, nothing takes focus.
import type { EditorApi, EventBus, PreviewApi } from '../shared/types';

export interface FocusLineWiring {
  /** A new document: clear both tints and swallow the cursor event `setDoc` is about to schedule. */
  reset(): void;
  /** Re-applies the last focus line to the pane that mirrors it. Used after a PROGRAMMATIC
   *  `editor.focus()` (mode switch), whose `focusin` makes the editor drop the preview's mirror even
   *  though the user never touched the editor. A genuine user focus still clears it. */
  reassert(): void;
  off(): void;
}

export interface FocusLineGates {
  /** True while the cursor event being delivered was caused by a write from an in-preview editing
   *  session (CONTRACT §11): the user is typing in the PREVIEW, whose own click / selection / resume owns
   *  the focus line. Such an event never claims it — whether or not the editor happens to have focus
   *  (a mode switch commits the session and then focuses the editor programmatically). */
  previewWrite?: () => boolean;
  /** True while a block is being edited in the preview. An UNFOCUSED typing event (a checkbox toggled
   *  in the preview writes through the editor) does not claim the focus line meanwhile either. */
  previewEditing?: () => boolean;
}

export function wireFocusLine(
  bus: EventBus,
  editor: Pick<EditorApi, 'hasFocus' | 'setPeerLine'>,
  preview: Pick<PreviewApi, 'setFocusLine'>,
  gates: FocusLineGates = {},
): FocusLineWiring {
  const previewWrite = gates.previewWrite ?? (() => false);
  const previewEditing = gates.previewEditing ?? (() => false);
  // `setDoc` schedules one cursor notification of its own. Acting on it would tint the preview's first
  // line before the user has touched anything, so the first cursor event after a load is dropped.
  let skipNextCursor = false;
  /** The last focus line and the pane that owns it, so a programmatic focus change can restore it. */
  let last: { line: number; source: 'editor' | 'preview' } | null = null;

  const apply = (line: number, source: 'editor' | 'preview'): void => {
    if (source === 'editor') preview.setFocusLine(line);
    else editor.setPeerLine(line);
  };

  const offCursor = bus.on('doc:cursor', (e) => {
    if (skipNextCursor) { skipNextCursor = false; return; }
    // A cursor event while the editor is not focused and nothing was typed is a programmatic move
    // (scroll sync, gotoLine from the TOC): it is not the user telling us where they are.
    if (previewWrite()) return;
    if (!editor.hasFocus() && (!e.typing || previewEditing())) return;
    bus.emit('focus:line', { line: e.line, source: 'editor' });
  });

  const offFocus = bus.on('focus:line', (e) => {
    last = { line: e.line, source: e.source };
    apply(e.line, e.source);
  });

  return {
    reset() {
      skipNextCursor = true;
      last = null;
      preview.setFocusLine(null);
      editor.setPeerLine(null);
    },
    reassert() {
      if (last) apply(last.line, last.source);
    },
    off() {
      offCursor();
      offFocus();
    },
  };
}
