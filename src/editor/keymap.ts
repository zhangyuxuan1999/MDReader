// src/editor/keymap.ts — CodeMirror key bindings. Shortcuts for our commands are derived from the
// registry (single source of truth: SPEC §8 table via commands.ts); structural bindings (Enter,
// Backspace, Tab) are fixed.
import type { ChangeSpec, EditorState, StateCommand } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import { indentLess, indentMore } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import type { CommandRegistry } from '../shared/types';
import { forEachSelectedLine, listMarkerWidth, markerDeleteStart, quotePrefixLength } from './commands';

/** One binding per scope:'editor' command that has a shortcut; running goes through the registry. */
export function commandKeymap(registry: CommandRegistry): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const c of registry.list()) {
    if (c.scope !== 'editor' || !c.shortcut) continue;
    const id = c.id;
    out.push({ key: c.shortcut, run: () => registry.run(id), preventDefault: true });
  }
  return out;
}

/** Stable fingerprint of the editor-scope shortcut set, used to skip needless reconfigures. */
export function keymapSignature(registry: CommandRegistry): string {
  return registry
    .list()
    .filter((c) => c.scope === 'editor' && c.shortcut)
    .map((c) => `${c.id}=${c.shortcut}`)
    .join(',');
}

function inListItem(state: EditorState): boolean {
  // (typed via the tree itself so no @lezer/common import is needed)
  let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(state.selection.main.head, -1);
  while (n) {
    if (n.name === 'ListItem') return true;
    n = n.parent;
  }
  return false;
}

/** Indents selected list items by their own marker width (nests under the previous sibling). */
export const indentListItem: StateCommand = (target) => {
  if (!inListItem(target.state)) return indentMore(target);
  const changes: ChangeSpec[] = [];
  forEachSelectedLine(target.state, (line) => {
    // Inside a blockquote the indentation goes after the "> " prefix, never before it.
    const q = quotePrefixLength(line.text);
    const w = (listMarkerWidth(line.text) ?? q + 2) - q;
    changes.push({ from: line.from + q, insert: ' '.repeat(w) });
  });
  target.dispatch(target.state.update({ changes, userEvent: 'input.indent' }));
  return true;
};

/** Removes up to one marker width of leading spaces from selected list items. */
export const dedentListItem: StateCommand = (target) => {
  if (!inListItem(target.state)) return indentLess(target);
  const changes: ChangeSpec[] = [];
  forEachSelectedLine(target.state, (line) => {
    const q = quotePrefixLength(line.text);
    const rest = line.text.slice(q);
    const lead = (/^ */.exec(rest) as RegExpExecArray)[0].length;
    const w = Math.min(lead, listMarkerWidth(rest.trimStart()) ?? 2);
    if (w > 0) changes.push({ from: line.from + q, to: line.from + q + w, insert: '' });
  });
  if (changes.length === 0) return false;
  target.dispatch(target.state.update({ changes, userEvent: 'delete.dedent' }));
  return true;
};

/**
 * Backspace directly after a list/task marker removes the marker together with its indentation
 * ("- 乙" → "乙", "- [ ] " → ""), instead of upstream deleteMarkupBackward's invisible blank
 * replacement. Anything else falls through to the upstream command (then the default keymap).
 * Regex-based, so it also works when the size gate has removed the markdown language.
 */
export const deleteListMarkerBackward: StateCommand = ({ state, dispatch }) => {
  const { main } = state.selection;
  if (!main.empty || state.selection.ranges.length !== 1) return deleteMarkupBackward({ state, dispatch });
  const line = state.doc.lineAt(main.head);
  const start = markerDeleteStart(line.text.slice(0, main.head - line.from));
  if (start === null) return deleteMarkupBackward({ state, dispatch });
  dispatch(state.update({ changes: { from: line.from + start, to: main.head, insert: '' }, userEvent: 'delete.backward', scrollIntoView: true }));
  return true;
};

export const structuralKeymap: readonly KeyBinding[] = [
  { key: 'Enter', run: insertNewlineContinueMarkup },
  { key: 'Backspace', run: deleteListMarkerBackward },
  { key: 'Tab', run: indentListItem, shift: dedentListItem, preventDefault: true },
];
