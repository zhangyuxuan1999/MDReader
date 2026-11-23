// src/editor/peerLine.ts — the editor half of the focus-line contract (CONTRACT §9).
//
// The preview tells the editor which line the user is on over there; the editor tints exactly that line
// with the same token as its own caret line (--mdr-focus-line) WITHOUT moving the caret, scrolling or
// taking focus. While a peer line is set, `view.dom` carries `mdr-peer-active` so editor.css can hide the
// caret line's own background: exactly ONE line is tinted per pane at any time.
//
// The peer line is a plain line decoration in a StateField (no layout reads, no measuring), and it clears
// itself on any transaction that sets the selection (click, keyboard, typing) and when the content DOM
// takes focus — the caret line takes over from there.
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** Payload: the 1-based line to tint, or null to clear. Non-finite values clear (see below). */
export const setPeerLineEffect = StateEffect.define<number | null>();

const peerLineDecoration = Decoration.line({ class: 'cm-peerLine' });

/** At most one line decoration; empty when no peer line is set. */
export const peerLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? deco.map(tr.changes) : deco;
    // Any caret movement in this pane makes the editor's own active line the truth again.
    if (tr.selection) next = Decoration.none;
    for (const e of tr.effects) {
      if (!e.is(setPeerLineEffect)) continue;
      const raw = e.value;
      if (raw === null || !Number.isFinite(raw)) { next = Decoration.none; continue; }
      const line = Math.min(Math.max(1, Math.floor(raw as number)), tr.state.doc.lines);
      next = Decoration.set([peerLineDecoration.range(tr.state.doc.line(line).from)]);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** True when this state currently tints a peer line. */
export const hasPeerLine = (view: EditorView): boolean => (view.state.field(peerLineField, false)?.size ?? 0) > 0;

/** Mirrors the field into a class on the editor's outer DOM. This goes through `editorAttributes` rather
 *  than `classList`: CodeMirror rewrites `view.dom`'s whole `class` attribute whenever it updates its own
 *  attributes (gaining or losing `cm-focused`, a theme change), which would silently drop a class we had
 *  set ourselves — and losing editor focus is exactly what happens when the user clicks in the preview. */
const peerLineClass = EditorView.editorAttributes.of((view) => (hasPeerLine(view) ? { class: 'mdr-peer-active' } : null));

/** Focus in the content DOM means the user is working here: drop the mirror of the other pane. */
const clearOnFocus = EditorView.domEventHandlers({
  focusin(_e, view) {
    if (hasPeerLine(view)) view.dispatch({ effects: setPeerLineEffect.of(null) });
    return false;
  },
});

export const peerLineExtension: Extension = [peerLineField, peerLineClass, clearOnFocus];

/** Sets (or clears) the peer line; out-of-range lines clamp, NaN/undefined clear. Never scrolls or focuses. */
export function setPeerLine(view: EditorView, line: number | null): void {
  const wanted = line === null || !Number.isFinite(line) ? null : line;
  if (wanted === null && !hasPeerLine(view)) return;   // nothing to clear: no transaction at all
  view.dispatch({ effects: setPeerLineEffect.of(wanted) });
}
