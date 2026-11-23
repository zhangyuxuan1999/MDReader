// src/editor/createEditor.ts — EditorApi over CodeMirror 6 (SPEC §7). Minimal extension list, one
// updateListener that never touches the DOM, rAF-coalesced cursor/scroll notifications, and
// scroll-position queries that only use CodeMirror's cached height map.
import { Compartment, EditorState, MapMode, type ChangeSet, type Text } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import type { CreateEditor, EditorApi, Line, SourceEdit, TextChange } from '../shared/types';
import { flattenChanges } from './changes';
import { cmTheme, mdHighlightStyle } from './cmTheme';
import { registerEditorCommands, taskToggleChange } from './commands';
import { commandKeymap, keymapSignature, structuralKeymap } from './keymap';
import { peerLineExtension, setPeerLine as dispatchPeerLine } from './peerLine';
import { zhCN } from './phrases';
import '../styles/editor.css';

type ChangesHandler = (version: number, changes: TextChange[]) => void;
type CursorHandler = (line: Line, col: number, typing: boolean) => void;

// ---- size-gated language (lead decision 3, thresholds re-measured in fix round 2). CodeMirror's
// lezer markdown parser rebuilds the top-level Document node (one child per block) inside every
// transaction, and nested code languages (@lezer/lr) add to that; the cost is measured below against
// the 5 ms P5 keystroke budget (SPEC §11). The language lives in a Compartment whose content is chosen
// ONLY in setDoc from the document size (characters ≈ bytes for ASCII; CJK text costs the parser per
// character, not per byte, so characters are the relevant measure):
//   ≤ 128 KB  full markdown + nested code languages
//   ≤ 256 KB  markdown without code languages
//   > 256 KB  no language extension at all (plain text; everything else unchanged)
// The parse cost per keystroke grows with the number of top-level blocks, ~1 ms per 1500 blocks.
// Measured (Chromium, view.dispatch per keystroke mid-document, bench/verify/p5-*, p50/p95 ms):
// 128 KB / 6.5k lines full 1.7–4.5 / 4.0–6.0 · 192 KB / 9.8k lines markdown-only 2.1–3.4 / 5.9–7.0 ·
// 256 KB / 13k lines markdown-only 6.2–8.1 / 11.0 · 0.4 MB / 20k lines markdown-only 2.6–7.6 /
// 3.3–13.8 · 2 MB / 102k lines (large.md) none 0.5 / 1.1 (with the old 4 MB gate: 8.0–11.8 / 16.7–19.0).
// Independently of the size, a document containing a single very long line is gated to 'none' AND has
// line wrapping switched off: CodeMirror's DOM read-back of one wrapped multi-hundred-thousand-char
// line costs 80–200 ms per keystroke (measured on a 1 MB single-line paragraph), while the same line
// unwrapped stays inside the budget.
export type LanguageTier = 'full' | 'markdown' | 'none';
export const LANGUAGE_TIER_FULL_MAX = 128 * 1024;
export const LANGUAGE_TIER_MARKDOWN_MAX = 256 * 1024;
/** A line longer than this makes the document "long-line": no language, no line wrapping. */
export const LONG_LINE_MAX = 50_000;
export const LARGE_DOC_TOAST = '大文件：已关闭语法高亮以保持流畅';

/**
 * Longest line of `text` in characters, stopping early once `cap` is exceeded (so the hot
 * "is there a pathological line?" question costs at most one pass and usually much less).
 */
export function maxLineLength(text: string, cap = Infinity): number {
  let longest = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const len = (nl < 0 ? text.length : nl) - start;
    if (len > longest) longest = len;
    if (longest > cap || nl < 0) return longest;
    start = nl + 1;
  }
}

/** Language tier for a document of `chars` characters whose longest line is `longestLine`. */
export function languageTierFor(chars: number, longestLine = 0): LanguageTier {
  if (longestLine > LONG_LINE_MAX) return 'none';
  if (chars <= LANGUAGE_TIER_FULL_MAX) return 'full';
  if (chars <= LANGUAGE_TIER_MARKDOWN_MAX) return 'markdown';
  return 'none';
}

// addKeymap:false — the markdown package would otherwise install its own Prec.high Enter/Backspace
// bindings ahead of structuralKeymap, so our Backspace-after-marker handling could never run.
const fullLanguage = markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false });
const markdownOnly = markdown({ base: markdownLanguage, addKeymap: false });
const languageExtension = (tier: LanguageTier) => (tier === 'full' ? fullLanguage : tier === 'markdown' ? markdownOnly : []);

/** Editors created by createEditor also expose dispose(); EditorApi (shared/types) is frozen. */
export interface DisposableEditorApi extends EditorApi {
  dispose(): void;
  /** Current language tier (test/diagnostics only). */
  languageTier(): LanguageTier;
  /** Whether the current document tripped the long-line guard (test/diagnostics only). */
  hasLongLine(): boolean;
}
const disposers = new WeakMap<EditorApi, () => void>();

/** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions): the editor remembers its recent changes, ONE step
 *  per doc-changing view update (a ViewUpdate can carry several transactions; the version counter goes up once for it,
 *  and that is the version the worker's structures carry) and one per setDoc (`changes` null: the document was
 *  replaced). The ring holds this many steps (256 overflowed in ordinary use: 300 keystrokes typed while the preview
 *  was hidden). */
export const STEP_RING = 4096;
/** Checkpoint-E decisions (CHC-2): the ring is also bounded by what it holds, in characters (stepCost). Consecutive
 *  documents share every line a step did not touch, so a step costs the lines of its `before` that it touched plus what
 *  it inserted; a long line costs its whole length per keystroke. The oldest steps leave while the sum is above this;
 *  a single step above it empties the ring. 12 Mi: 4000 characters typed into one task line (about 8.2 M) still fit;
 *  keystrokes into one 50 KB to 1 MB line leave about 13 MB of heap after a forced GC where 0.1.1 leaves 1 to 2 MB
 *  (bench/verify/v5-chc-ringmem.mjs; it was up to 1.5 GB). */
export const STEP_RING_COST = 12 * 1024 * 1024;
/** One remembered step: the version it produced, the document before it and its changes; a replacement (setDoc) is
 *  remembered by its version only (Checkpoint-E decisions: it keeps no document). */
export type EditorStep = { version: number; before: Text; changes: ChangeSet } | { version: number; before: null; changes: null };

/** CHC-2: the cost of a step for STEP_RING_COST, from its changes and the document before it without walking that
 *  document: per changed range the lines of `before` it touches (each line counted once) and the text it inserts. */
export function stepCost(before: Text, changes: ChangeSet): number {
  let cost = 0;
  let last = -1;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const from = Math.max(before.lineAt(fromA).from, last);
    const to = before.lineAt(toA).to;
    if (to > from) cost += to - from;
    last = Math.max(last, to);
    cost += toB - fromB;
  });
  return cost;
}

/** U16 (Checkpoint-D decisions) — THE mapping of a line through the editor's recent changes: the line that was `line` in
 *  the document of `version`, in the document `end` of version `current`, walked through `steps` (oldest first, the last
 *  one producing `current`). Answers the line's number now; null when it is gone (its first character was deleted, it
 *  was joined into the line above, it was split by a line break put inside it, the document was replaced);
 *  undefined when it cannot be known (a version above the current one or older than the steps kept, any gap in their
 *  versions, a line that the document of `version` does not have). Per step: the line's start, mapped with assoc 1 and
 *  MapMode.TrackAfter (assoc -1 would name a task line pasted in front of it together with its line break), must be the
 *  start of a line of the step's end document; when it is not, it is still that line only if assoc -1 maps the start
 *  to the start of the SAME line (text inserted at column 0 without a line break: an indent, "> "). And (Checkpoint-E
 *  decisions, CHC-1) the line's end, the position before its own line break, mapped with assoc -1, must lie in that
 *  same line: otherwise a line break was put inside the line (Enter between a task's box and its text, a task typed at
 *  column 0 and then Enter), its start stayed on the upper part and the text that was on it went on below. A line
 *  break inserted exactly at the end stays outside (assoc -1), and a join with the NEXT line keeps the line. */
export function lineThrough(steps: readonly EditorStep[], end: Text, current: number, line: Line, version: number): Line | null | undefined {
  if (!Number.isInteger(line) || !Number.isInteger(version) || version < 0 || version > current) return undefined;
  if (version === current) return line >= 1 && line <= end.lines ? line : undefined;
  // The steps after `version`, found from the newest: a replacement among them answers gone whatever came before it (the
  // steps before a replacement are not kept, CHC-2).
  let k = steps.length;
  while (k > 0 && steps[k - 1].version > version) if (!steps[--k].changes) return null;
  if (k >= steps.length || steps[k].version !== version + 1 || steps[steps.length - 1].version !== current) return undefined;
  let n = line;
  for (; k < steps.length; k++) {
    const st = steps[k];
    if (k + 1 < steps.length && steps[k + 1].version !== st.version + 1) return undefined;   // a gap: not knowable
    const at = k + 1 < steps.length ? steps[k + 1].before : end;
    if (!st.changes || !at) return null;                                                   // a replacement (found above)
    if (n < 1 || n > st.before.lines) return undefined;
    const old = st.before.line(n);
    const p1 = st.changes.mapPos(old.from, 1, MapMode.TrackAfter);
    if (p1 === null) return null;                                                          // its first character is gone
    const l = at.lineAt(p1);
    if (l.from !== p1) {
      const p0 = st.changes.mapPos(old.from, -1);
      if (p0 !== l.from) return null;                                                      // joined into another line
    }
    if (at.lineAt(st.changes.mapPos(old.to, -1)).number !== l.number) return null;         // split: a line break inside it
    n = l.number;
  }
  return n;
}

/** Destroys the CodeMirror view and releases every listener/rAF an editor holds (no-op if unknown). */
export function disposeEditor(editor: EditorApi): void {
  disposers.get(editor)?.();
}

export const createEditor: CreateEditor = ({ parent, bus, registry, theme }) => {
  let version = 0;
  let wrap = true;            // user preference (setLineWrap)
  let longLine = false;       // current document has a line > LONG_LINE_MAX
  let wrapOverride = false;   // user asked for wrapping again after the long-line guard turned it off
  let dark = theme === 'dark';
  let tier: LanguageTier = 'full';
  let lastTop: { line: number; fraction: number } | null = null;
  let disposed = false;

  const changeHandlers = new Set<ChangesHandler>();
  const cursorHandlers = new Set<CursorHandler>();
  const scrollHandlers = new Set<() => void>();

  const wrapComp = new Compartment();
  const themeComp = new Compartment();
  const keysComp = new Compartment();
  const langComp = new Compartment();

  // ---- rAF coalescing (one frame → at most one cursor and one scroll notification)
  let cursorFrame = 0;
  let typingPending = false;
  const scheduleCursor = (typing: boolean): void => {
    typingPending ||= typing;
    if (cursorFrame) return;
    cursorFrame = requestAnimationFrame(() => {
      cursorFrame = 0;
      const typed = typingPending;
      typingPending = false;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      for (const h of cursorHandlers) h(line.number, head - line.from, typed);
    });
  };
  let scrollFrame = 0;
  const scheduleScroll = (): void => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      for (const h of scrollHandlers) h();
    });
  };

  /** U16 (Checkpoint-D decisions): the ring of recent steps (lineThrough), oldest first, at most STEP_RING steps and
   *  STEP_RING_COST characters (Checkpoint-E decisions, CHC-2: `costs` and `held` are the steps' stepCost and their sum).
   *  A step is pushed where the version goes up and before any change handler runs (one that throws leaves no version
   *  without its step); setDoc empties the ring and pushes a replacement step that keeps no document (every version
   *  before it answers "gone"). */
  const steps: EditorStep[] = [];
  const costs: number[] = [];
  let held = 0;
  const remember = (step: EditorStep, cost: number): void => {
    steps.push(step);
    costs.push(cost);
    held += cost;
    while (steps.length > STEP_RING || held > STEP_RING_COST) {
      steps.shift();
      held -= costs.shift()!;
    }
  };

  const onUpdate = (u: ViewUpdate): void => {
    if (disposed) return;
    if (u.docChanged) {
      const changes = flattenChanges(u.changes);
      version++;
      remember({ version, before: u.startState.doc, changes: u.changes }, stepCost(u.startState.doc, u.changes));
      for (const h of changeHandlers) h(version, changes);
    }
    if (u.docChanged || u.selectionSet) scheduleCursor(u.docChanged);
  };

  // Static extensions are created once and shared by every state (setDoc reuses them; history and
  // other state fields still start fresh because EditorState.create allocates new field values).
  const staticExtensions = [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    // The caret line's gutter entry carries the same tint (cmTheme styles `.cm-activeLineGutter`, and
    // editor.css turns it off while a peer line is shown) — CONTRACT §9.
    highlightActiveLineGutter(),
    peerLineExtension,
    bracketMatching(),
    closeBrackets(),
    EditorState.allowMultipleSelections.of(true),
    syntaxHighlighting(mdHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: true }),
    highlightSelectionMatches(),
    EditorState.tabSize.of(2),
    EditorState.phrases.of(zhCN),
    keymap.of([...structuralKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    EditorView.updateListener.of(onUpdate),
  ];
  /** Wrapping is the user's choice unless the long-line guard vetoed it (and was not overridden). */
  const wrapping = (): boolean => wrap && (!longLine || wrapOverride);

  // Compartment contents reflect the live wrap/theme/registry/tier state; our keymap precedes the others.
  const extensions = () => [
    keysComp.of(keymap.of(commandKeymap(registry))),
    wrapComp.of(wrapping() ? EditorView.lineWrapping : []),
    themeComp.of(cmTheme(dark)),
    langComp.of(languageExtension(tier)),
    staticExtensions,
  ];

  const view = new EditorView({ state: EditorState.create({ doc: '', extensions: extensions() }), parent });
  view.scrollDOM.addEventListener('scroll', scheduleScroll, { passive: true });

  /** Clamps a line number into [1, doc.lines]; returns 0 for anything that is not a finite number,
   *  so the public line-taking methods can no-op instead of throwing on NaN/undefined (fix round 3). */
  const clampLine = (line: Line): number => {
    const n = Number(line);
    if (Number.isNaN(n)) return 0;   // NaN / undefined / not a number → the caller no-ops
    return Math.min(Math.max(1, Math.floor(n)), view.state.doc.lines);   // ±Infinity clamps like 1e9
  };
  /** Finite number, or `fallback` (NaN/Infinity/undefined never reach CodeMirror or scrollTop). */
  const finite = (n: number | undefined, fallback: number): number => (Number.isFinite(Number(n)) ? Number(n) : fallback);

  const api: DisposableEditorApi = {
    view,
    get version() {
      return version;
    },
    setDoc(text: string): number {
      // The gate is re-evaluated here and nowhere else: a keystroke never reconfigures the language.
      const nextLongLine = maxLineLength(text, LONG_LINE_MAX) > LONG_LINE_MAX;
      const next = languageTierFor(text.length, nextLongLine ? LONG_LINE_MAX + 1 : 0);
      const downgraded = next !== 'full' && (tier === 'full' || (nextLongLine && !longLine));
      tier = next;
      longLine = nextLongLine;
      wrapOverride = false;
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      version++;
      steps.length = 0;
      costs.length = 0;
      held = 0;
      remember({ version, before: null, changes: null }, 0);
      scheduleCursor(false);
      if (downgraded) bus.emit('toast', { text: LARGE_DOC_TOAST, kind: 'info' });
      return version;
    },
    lineNow: (line: Line, v: number) => lineThrough(steps, view.state.doc, version, line, v),
    languageTier: () => tier,
    hasLongLine: () => longLine,
    getText: () => view.state.doc.toString(),
    lineCount: () => view.state.doc.lines,
    onChanges(fn: ChangesHandler) {
      changeHandlers.add(fn);
      return () => changeHandlers.delete(fn);
    },
    onCursor(fn: CursorHandler) {
      cursorHandlers.add(fn);
      return () => cursorHandlers.delete(fn);
    },
    onScroll(fn: () => void) {
      scrollHandlers.add(fn);
      return () => scrollHandlers.delete(fn);
    },
    topVisible() {
      // A display:none scroller reports scrollTop 0; answer with the last position measured while visible so a
      // caller that reads the hidden pane (mode switch, sync) does not see line 1.
      if (view.scrollDOM.clientHeight === 0 && lastTop) return { ...lastTop };
      const top = view.scrollDOM.scrollTop - view.documentPadding.top;
      const block = view.lineBlockAtHeight(top);
      const line = view.state.doc.lineAt(block.from).number;
      const fraction = block.height > 0 ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0;
      lastTop = { line, fraction };
      return { line, fraction };
    },
    scrollToLine(line: Line, fraction = 0) {
      const n = clampLine(line);
      if (n === 0) return;   // non-finite argument: ignore rather than jump to line 1
      const block = view.lineBlockAt(view.state.doc.line(n).from);
      const f = Math.min(1, Math.max(0, finite(fraction, 0)));
      view.scrollDOM.scrollTop = block.top + f * block.height + view.documentPadding.top;
    },
    gotoLine(line: Line, col = 0) {
      const n = clampLine(line);
      if (n === 0) return;
      const l = view.state.doc.line(n);
      const pos = l.from + Math.floor(Math.min(Math.max(0, finite(col, 0)), l.length));
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    },
    applySourceEdit(e: SourceEdit) {
      if (e.kind !== 'toggleTask' || !Number.isInteger(e.line) || e.line < 1 || e.line > view.state.doc.lines) return;
      const change = taskToggleChange(view.state.doc.line(e.line));
      if (change) view.dispatch({ changes: change, userEvent: 'input' });
    },
    setPeerLine(line: Line | null) {
      // Mirror of the other pane's focus line: a line decoration only — no caret move, no scroll, no focus.
      dispatchPeerLine(view, line);
    },
    setTheme(t: 'light' | 'dark') {
      dark = t === 'dark';
      view.dispatch({ effects: themeComp.reconfigure(cmTheme(dark)) });
    },
    setLineWrap(on: boolean) {
      wrap = on;
      // An explicit request to wrap overrides the long-line guard (the user accepts the cost; the
      // guard comes back with the next document).
      if (on && longLine) wrapOverride = true;
      view.dispatch({ effects: wrapComp.reconfigure(wrapping() ? EditorView.lineWrapping : []) });
    },
    setVisible(on: boolean) {
      // Nothing to remember: a hidden pane needs no work, a shown one needs a re-measure.
      if (on) view.requestMeasure();
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    dispose() {
      if (disposed) return;
      disposed = true;
      offRegistry();
      view.scrollDOM.removeEventListener('scroll', scheduleScroll);
      if (cursorFrame) cancelAnimationFrame(cursorFrame);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      cursorFrame = scrollFrame = 0;
      changeHandlers.clear();
      cursorHandlers.clear();
      scrollHandlers.clear();
      view.destroy();
    },
  };

  // Commands are registered last; the keymap compartment then follows the registry.
  registerEditorCommands(api, registry);
  let signature = '';
  const syncKeymap = (): void => {
    const next = keymapSignature(registry);
    if (next === signature) return;
    signature = next;
    view.dispatch({ effects: keysComp.reconfigure(keymap.of(commandKeymap(registry))) });
  };
  syncKeymap();
  const offRegistry = registry.onChange(syncKeymap);
  disposers.set(api, api.dispose);

  return api;
};
