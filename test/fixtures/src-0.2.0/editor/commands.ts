// src/editor/commands.ts — markdown editing commands (toggle-wrap, headings, tasks, links, find,
// goto-line) and their registration as scope:'editor' commands. Pure state transforms live in small
// exported functions so they are unit-testable without a registry.
import { EditorSelection, type ChangeSpec, type EditorState, type Line as CmLine, type StateCommand } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import type { Command, CommandId, CommandRegistry, EditorApi } from '../shared/types';
import { T } from '../shared/i18n';

// ----------------------------------------------------------------------------- helpers

/** Calls `fn` once per distinct document line touched by any selection range (document order). */
export function forEachSelectedLine(state: EditorState, fn: (line: CmLine) => void): void {
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A non-empty range ending exactly at a line start does not include that line.
    if (last > first && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) seen.add(n);
  }
  for (const n of [...seen].sort((a, b) => a - b)) fn(state.doc.line(n));
}

// Every line-prefix pattern tolerates any number of blockquote markers ("> ", "> > ") and indentation
// before the list marker, so items inside quotes toggle/indent like top-level ones (lead decision 12).
const QUOTE_PREFIX = '(?:\\s*>)*\\s*';
const LIST_MARK_RE = new RegExp(`^(${QUOTE_PREFIX})((?:[-*+]|\\d{1,9}[.)])\\s+)`);
const TASK_RE = new RegExp(`^${QUOTE_PREFIX}(?:[-*+]|\\d{1,9}[.)])\\s+\\[( |x|X)\\]`);
/** Text before the cursor that is exactly a list marker (optionally with a task box): quote prefix, marker. */
const MARKER_ONLY_RE = new RegExp(`^((?:\\s*> ?)*)(\\s*(?:[-*+]|\\d{1,9}[.)])\\s+(?:\\[[ xX]\\]\\s*)?)$`);
const QUOTE_ONLY_RE = /^(?:\s*> ?)*/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
/** A task checkbox right after a list marker (`[ ] `, `[x]` at end of line). */
const TASK_BOX_RE = /^\[[ xX]\](?:[ \t]+|$)/;

/** Length of the leading blockquote markers on a line (`> > - a` → 4; no quote → 0). */
export function quotePrefixLength(text: string): number {
  return (QUOTE_ONLY_RE.exec(text) as RegExpExecArray)[0].length;
}

/** Width of the list marker (quote prefix + indent + marker + spacing) on a line, or null when it is not a list item. */
export function listMarkerWidth(text: string): number | null {
  const m = LIST_MARK_RE.exec(text);
  return m ? m[0].length : null;
}

/**
 * When `before` (the text of a line up to the cursor) consists only of a list/task marker, returns the
 * offset within the line from which the marker (and its indentation, but not the blockquote prefix)
 * should be deleted; otherwise null.
 */
export function markerDeleteStart(before: string): number | null {
  const m = MARKER_ONLY_RE.exec(before);
  return m ? m[1].length : null;
}

/** Change that flips the first `[ ]`/`[x]`/`[X]` after the list marker on `line`, or null if none. */
export function taskToggleChange(line: CmLine): ChangeSpec | null {
  const m = TASK_RE.exec(line.text);
  if (!m) return null;
  const box = line.from + m[0].length - 2; // index of the character inside the brackets
  return { from: box, to: box + 1, insert: m[1] === ' ' ? 'x' : ' ' };
}

/**
 * Transaction annotations for every editing command: each command is its own undo step, so an undo
 * after "Mod-b, type x" removes only the typed character instead of the wrapper as well.
 */
const OWN_STEP = { annotations: isolateHistory.of('full'), userEvent: 'input' } as const;

// ----------------------------------------------------------------------------- toggle-wrap

/** Wraps every selection in `mark`…`mark`, or unwraps it when already wrapped (inside or around). */
export function toggleWrap(mark: string): StateCommand {
  const m = mark.length;
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
      const { from, to } = range;
      const outerBefore = from >= m && state.sliceDoc(from - m, from) === mark;
      const outerAfter = state.sliceDoc(to, to + m) === mark;
      if (range.empty) {
        if (outerBefore && outerAfter) {
          return { changes: { from: from - m, to: to + m, insert: '' }, range: EditorSelection.cursor(from - m) };
        }
        return { changes: { from, insert: mark + mark }, range: EditorSelection.cursor(from + m) };
      }
      const sel = state.sliceDoc(from, to);
      if (sel.length >= 2 * m && sel.startsWith(mark) && sel.endsWith(mark)) {
        const inner = sel.slice(m, sel.length - m);
        return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) };
      }
      if (outerBefore && outerAfter) {
        return {
          changes: [{ from: from - m, to: from, insert: '' }, { from: to, to: to + m, insert: '' }],
          range: EditorSelection.range(from - m, to - m),
        };
      }
      return {
        changes: [{ from, insert: mark }, { from: to, insert: mark }],
        range: EditorSelection.range(from + m, to + m),
      };
    });
    dispatch(state.update(tr, { ...OWN_STEP, scrollIntoView: true }));
    return true;
  };
}

// ----------------------------------------------------------------------------- headings

/**
 * Offset within `text` at which the line's own content starts, i.e. after any blockquote markers
 * (`> `, nested) and, on a list item, after the list marker and its task checkbox (`- `, `1. `,
 * `- [ ] `). The ATX marker of a heading command belongs there — inserting it at column 0 would
 * stack it in front of the block marker (`# - a`), which markdown renders as a heading whose text
 * begins with the literal marker (fix round 3).
 */
export function headingContentOffset(text: string): number {
  const m = LIST_MARK_RE.exec(text);
  if (!m) return quotePrefixLength(text);
  const box = TASK_BOX_RE.exec(text.slice(m[0].length));
  return m[0].length + (box ? box[0].length : 0);
}

/**
 * Rewrites the ATX prefix of the content of every selected line to `level` (0 = paragraph); the
 * prefix is written after the line's blockquote/list markers, replacing an ATX marker already there.
 * Same level toggles off.
 */
export function setHeading(level: number): StateCommand {
  const prefix = level > 0 ? '#'.repeat(level) + ' ' : '';
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    forEachSelectedLine(state, (line) => {
      const at = headingContentOffset(line.text);
      const m = HEADING_RE.exec(line.text.slice(at));
      const oldLen = m ? m[0].length : 0;
      const insert = m && m[1].length === level ? '' : prefix;
      if (oldLen === 0 && insert === '') return;
      changes.push({ from: line.from + at, to: line.from + at + oldLen, insert });
    });
    if (changes.length === 0) return false;
    dispatch(state.update({ changes, ...OWN_STEP }));
    return true;
  };
}

// ----------------------------------------------------------------------------- tasks

/** Toggles the checkbox on every selected line; list items without one get `[ ] `, plain lines `- [ ] `. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = [];
  forEachSelectedLine(state, (line) => {
    const flip = taskToggleChange(line);
    if (flip) {
      changes.push(flip);
      return;
    }
    const w = listMarkerWidth(line.text);
    if (w !== null) changes.push({ from: line.from + w, insert: '[ ] ' });
    else changes.push({ from: line.from + (/^\s*/.exec(line.text) as RegExpExecArray)[0].length, insert: '- [ ] ' });
  });
  if (changes.length === 0) return false;
  dispatch(state.update({ changes, ...OWN_STEP }));
  return true;
};

// ----------------------------------------------------------------------------- links

/** Turns every selection into `[selection](url)` with `url` selected for immediate replacement. */
export function insertLink(view: EditorView, url = 'url'): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const urlFrom = range.from + text.length + 3; // after "[" + text + "]("
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](${url})` },
      range: EditorSelection.range(urlFrom, urlFrom + url.length),
    };
  });
  view.dispatch(state.update(tr, { ...OWN_STEP, scrollIntoView: true }));
  return true;
}

const HTTP_URL_RE = /^https?:\/\/\S+$/;

/** Resolves to an http(s) URL from the clipboard, or null (permission denied, unavailable, not a URL). */
async function readClipboardUrl(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return null;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    return HTTP_URL_RE.test(text) ? text : null;
  } catch {
    return null;
  }
}

async function insertLinkFromClipboard(view: EditorView): Promise<void> {
  const url = await readClipboardUrl();
  insertLink(view, url ?? undefined);
}

// ----------------------------------------------------------------------------- registration

interface Def { id: CommandId; title: string; shortcut: string; run(view: EditorView): unknown }

const bind = (cmd: StateCommand) => (view: EditorView) => cmd(view);

const DEFS: Def[] = [
  { id: 'edit.bold', title: T.bold, shortcut: 'Mod-b', run: bind(toggleWrap('**')) },
  { id: 'edit.italic', title: T.italic, shortcut: 'Mod-i', run: bind(toggleWrap('_')) },
  { id: 'edit.code', title: T.inlineCode, shortcut: 'Mod-e', run: bind(toggleWrap('`')) },
  { id: 'edit.link', title: T.link, shortcut: 'Mod-k', run: insertLinkFromClipboard },
  { id: 'edit.heading1', title: `${T.heading} 1`, shortcut: 'Mod-1', run: bind(setHeading(1)) },
  { id: 'edit.heading2', title: `${T.heading} 2`, shortcut: 'Mod-2', run: bind(setHeading(2)) },
  { id: 'edit.heading3', title: `${T.heading} 3`, shortcut: 'Mod-3', run: bind(setHeading(3)) },
  { id: 'edit.heading4', title: `${T.heading} 4`, shortcut: 'Mod-4', run: bind(setHeading(4)) },
  { id: 'edit.heading5', title: `${T.heading} 5`, shortcut: 'Mod-5', run: bind(setHeading(5)) },
  { id: 'edit.heading6', title: `${T.heading} 6`, shortcut: 'Mod-6', run: bind(setHeading(6)) },
  { id: 'edit.paragraph', title: T.paragraph, shortcut: 'Mod-0', run: bind(setHeading(0)) },
  { id: 'edit.toggleTask', title: T.toggleTask, shortcut: 'Mod-Shift-x', run: bind(toggleTask) },
  { id: 'edit.find', title: T.find, shortcut: 'Mod-f', run: openSearchPanel },
  { id: 'edit.gotoLine', title: T.gotoLine, shortcut: 'Mod-Alt-g', run: gotoLine },
];

/** Registers every scope:'editor' command. Called by createEditor at the end of construction. */
export function registerEditorCommands(editor: EditorApi, registry: CommandRegistry): void {
  for (const d of DEFS) {
    const c: Command = {
      id: d.id,
      title: d.title,
      shortcut: d.shortcut,
      scope: 'editor',
      run: () => {
        const r = d.run(editor.view);
        return r instanceof Promise ? r.then(() => undefined) : undefined;
      },
    };
    registry.register(c);
  }
}
