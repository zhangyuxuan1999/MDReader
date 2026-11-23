// src/preview/inlineEdit.ts — in-preview editing sessions (CONTRACT §11).
//
// ONE block at a time. While editing is on, a primary click (press AND release) inside one editable
// `section.md-block` makes that wrapper `contenteditable` (+ `.is-editing`) when the button is released
// (decision U7): the press is the browser's own, so a drag across blocks selects text as in a read-only
// preview, and the session keeps the caret / selection the browser made; nothing is written until the
// DOM changes. Every DOM
// change (never during IME composition) is serialized to Markdown at most once per animation frame
// (src/preview/serialize.ts) and, when it differs from the session's baseline, written back with
// `source.replace(startLine, lineCount, text + the block's original trailing blank lines)`.
//
// The host (createPreview) holds back worker HTML for the session block while it lasts and never evicts
// it; this module follows the block through structure updates (its id stays, its startLine / lineCount
// move) and ends the session when the block goes away. A write that turns the block into several blocks
// (Enter creates a paragraph, leaving a list) ends the session, and once the block that holds the caret
// has been re-rendered a new session starts on it with the caret at the same text offset. The same
// "resume" carries the user across a Backspace that merges two paragraphs (decision U3) and across an
// undo / redo step of the source's history (decision U1: ⌘Z / ⇧⌘Z inside a session call
// `source.history`). While a resume waits, an invisible capture element holds the focus: keys,
// Backspace / Delete / Enter / arrows, ⌘Z and text committed by an IME without a keydown are queued and
// replayed in order on the resumed session (decision U4). The session ends on Esc, blur / a click
// elsewhere, and `end()`; the block then re-renders from the worker.
import { matchShortcut, IS_MAC } from '../shared/keys';
import { BlockKind, type BlockInfo, type EventBus, type Line, type PreviewSourceAccess } from '../shared/types';
import { segmentAll } from '../worker/segmenter';
import * as serializer from './serialize';
import {
  CARET_MARK, NoMarkersError, serializeBlock, serializeBlockWithCaret, unsupportedReason, type SerializeHints,
  STAMP_ATTRS, STAMP_SELECTOR, clearStamps, formulaTex, stampAtoms, holdsInvisible, plainlyVisible,
} from './serialize';
import { baselineFaithful, blockRendering, sanitizerKept, urlsKept } from './fidelity';
import { ownTaskBox, TASK_NOT_TICKED_TEXT, type TaskAnswer } from './interactions';

export const NOT_EDITABLE_TEXT = '此块请在源码中编辑';
/** U8: a paste that would make the block's source longer than MAX_EDIT_CHARS is refused with this toast. */
export const PASTE_TOO_LONG_TEXT = '粘贴的内容太长，请在源码编辑器中粘贴';
export const EDIT_HINT_TEXT = `预览编辑中 · Esc 结束 · Shift+Enter 换行 · ${IS_MAC ? '⌘E' : 'Ctrl+E'} 行内代码`;
/** P-G: keys or IME text queued for a waiting click or resume were discarded (the wait expired, was abandoned, or
 *  another click replaced it). */
export const INPUT_DROPPED_TEXT = '预览尚未更新完，刚才的输入没有写入';
/** U16 amended: a waiting task-checkbox click whose task cannot be identified with certainty changes nothing (the same
 *  text as a tick whose line is gone or cannot be known: defined in interactions.ts). */
export { TASK_NOT_TICKED_TEXT };
const LINK_PLACEHOLDER = '输入链接地址，回车确认';

const EDITABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  BlockKind.Prose, BlockKind.Heading, BlockKind.List, BlockKind.Quote, BlockKind.Code, BlockKind.Table, BlockKind.Math,
]);
/** A block whose source is longer than this is left to the source editor (a serialization per frame of a
 *  giant list would make typing lag). */
export const MAX_EDIT_CHARS = 60000;
/** How long a split waits for the block holding the caret to re-render before giving up. */
const RESUME_MS = 2500;
/** G12: how often a history resume that only waits for its (scrolled-to) block to mount is extended. */
const MOUNT_WAIT_EXTENSIONS = 3;
/** P-C: how many lines above an emptied element's place are compared to tell a change above it from one below. */
const PLACE_LINES = 3;
const REFUSE_TOAST_MS = 4000;
const ZWSP = '\u200b';
const NBSP = String.fromCharCode(0xa0);

// ---------------------------------------------------------------- THE GUARD (CONTRACT section 11, Round-5 verification decisions)
/** The characters the guard counts: every one that is not plainly visible (serialize.ts plainlyVisible), U+00A0 included;
 *  U+0020, line feed and tab never. */
const guarded = (c: string): boolean => c !== ' ' && c !== '\n' && c !== '\t' && !plainlyVisible(c);
const NO_INPUT: ReadonlyMap<string, number> = new Map();
/** THE GUARD's count: for every character it counts (one code point), how many more raw occurrences `text`, written over
 *  `old`, holds than `old` does (only those it holds more of); null when there is none. */
function writeAdds(old: string, text: string): Map<string, number> | null {
  if (!holdsInvisible(text)) return null;
  const more = new Map<string, number>();
  for (const c of text) if (guarded(c)) more.set(c, (more.get(c) ?? 0) + 1);
  if (more.size === 0) return null;
  for (const c of old) { const k = more.get(c); if (k !== undefined) more.set(c, k - 1); }
  for (const [c, k] of more) if (k <= 0) more.delete(c);
  return more.size > 0 ? more : null;
}
/** THE GUARD's test: the first character of which `text`, written over `old`, holds more raw occurrences than `old` plus
 *  `allowed` (what the user put in during the session): null when there is none. */
export function writeReveals(old: string, text: string, allowed: ReadonlyMap<string, number> = NO_INPUT): string | null {
  const add = writeAdds(old, text);
  if (add) for (const [c, k] of add) if (k > (allowed.get(c) ?? 0)) return c;
  return null;
}
/** B2 of round 6 (CONTRACT §11, Checkpoint H: a dropped raw copy cannot pay for a revealed one) — THE GUARD's test of the
 *  serializer's Markdown `text` for a session's block, taken before it is combined with source text of other blocks:
 *  the first character of the block's HIDDEN set (`hints.hidden`) that `text` holds raw more often than the block's
 *  source holds it raw inside code (`hints.hiddenCode`: code spans, code blocks, formula TeX) plus `allowed` (what the
 *  user put in during the session); null when there is none. */
export function blockReveals(text: string, hints: SerializeHints, allowed: ReadonlyMap<string, number> = NO_INPUT): string | null {
  const hid = hints.hidden;
  if (!hid || hid.size === 0 || !holdsInvisible(text)) return null;
  const n = new Map<string, number>();
  for (const c of text) if (hid.has(c)) n.set(c, (n.get(c) ?? 0) + 1);
  for (const [c, k] of n) if (k > (hints.hiddenCode?.get(c) ?? 0) + (allowed.get(c) ?? 0)) return c;
  return null;
}
/** Thrown by the session's replaceSource when THE GUARD refuses a write. A NoMarkersError: every caller takes the
 *  refusal that exists (nothing is written, the session ends, the block re-renders from its unchanged source, the toast
 *  NOT_EDITABLE_TEXT). */
class WriteRefused extends NoMarkersError {
  constructor() {
    super();
    this.name = 'WriteRefused';
    this.message = 'previewEdit: the write would put a character the user did not put in into the source (the guard)';
  }
}
/** THE GUARD's firings since load, for tests and diagnostics (bench/verify reads it through the dev server; every
 *  firing also logs one console line): `fired` refused writes, `starts` session starts refused because the untouched
 *  block's serialization already reveals such a character, `last` the last character and where. */
export const writeGuardStats = { fired: 0, starts: 0, last: '' };
function guardFired(c: string, where: 'write' | 'start'): void {
  if (where === 'write') writeGuardStats.fired++; else writeGuardStats.starts++;
  writeGuardStats.last = `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} ${where}`;
  console.warn(`[mdr] previewEdit: the write guard refused a ${where === 'write' ? 'write' : 'session start'} (${writeGuardStats.last})`);
}

/** The serializer's per-block source style hints (no blank line forced under a tight ATX heading, the
 *  block's own table delimiter row), when this build of serialize.ts provides them. Looked up through the
 *  module namespace so this file keeps compiling while the serializer's optional extras evolve. */
const styleHintsOf = (serializer as unknown as {
  sourceStyleHints?: (content: string) => Partial<SerializeHints>;
}).sourceStyleHints;

export interface InlineEditHost {
  /** `.mdr-preview`: events are delegated here and the link input lives inside it. */
  root: HTMLElement;
  /** Where the floating hint bar goes: the pane around the scroller (it must not scroll with the
   *  content). Defaults to `root`. */
  hintParent?: HTMLElement;
  bus: EventBus;
  source?: PreviewSourceAccess;
  blockOfElement(el: Element): BlockInfo | null;
  elementOfBlock(id: number): HTMLElement | null;
  blockInfo(id: number): BlockInfo | null;
  blockAtLine(line: Line): BlockInfo | null;
  /** Mounted with HTML of the current structure (not pending, not stale, not lost). */
  isFresh(id: number): boolean;
  /** P-B (amended): THE definition of "the wrapper of block `id` shows the block's current source" (createPreview:
   *  the structure's version is at least the source's, and the block is mounted, not stale, not lost, connected, not
   *  pending); null otherwise. Used whenever the source has a version(). */
  currentWrapper?(id: number): HTMLElement | null;
  /** P-B (amended): the preview's structure describes the current source (its version is at least the source's). */
  describesSource?(): boolean;
  /** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions): THE answer for a click on a task checkbox
   *  (createPreview taskLine); a click outside a session waits only for 'wait'. Optional: without it (unit-test hosts)
   *  a click waits whenever its block is not current, as Fix B built it. */
  taskLine?(input: HTMLInputElement): TaskAnswer;
  /** P-F: block `id` is not fresh and HTML for it is on its way (requested from the worker, queued for mounting,
   *  or a giant payload waiting to settle). */
  renderPending?(id: number): boolean;
  /** A session started on `id`: hold back its worker HTML, never evict it. */
  hold(id: number): void;
  /** The session on `id` ended: mount the held HTML, or ask the worker for a fresh render. */
  release(id: number): void;
  /** Tint `line` in the preview (CONTRACT §9) — used when a session resumes on a split-off block. */
  setFocusLine?(line: Line): void;
  /** Version of the last structure the preview applied (the source's document version it describes).
   *  Lets a resume after an undo / a merge know when the preview shows the source the step produced. */
  structureVersion?(): number;
  /** Scrolls `line` into view when it is not on screen (which materializes and requests its block) — G12. */
  revealLine?(line: Line): void;
}

export interface InlineEditApi {
  setEditable(on: boolean): void;
  isEditable(): boolean;
  /** The block being edited, or null. */
  activeId(): number | null;
  /** Writes what is pending and ends the session (no-op without one). */
  end(): void;
  /** Writes what is pending, keeps the session. */
  flush(): void;
  /** Host: a structure / delta was applied. (A new document — bus 'doc:loaded' — ends a resume, a waiting
   *  click and whatever else of the old one is left: G16.) */
  afterStructure(): void;
  /** Host, while removing block `id` from the structure: the session on it has just written the deletion of
   *  its emptied block (U9) — keep its wrapper in place as the emptied element until `release(id)`. With
   *  `version` (the structure's, H20): only when that structure shows the deletion (an older one, arriving after
   *  the deletion was written, still has the block). */
  keepsRemoved(id: number, version?: number): boolean;
  /** Host: block `id` just mounted fresh HTML. */
  afterMount(id: number): void;
  /** Is `el` inside the block being edited? (interactions: links place the caret instead of navigating) */
  isEditingTarget(el: Element | null): boolean;
  /** A resume (after a split, a merge or an undo step) is waiting for the preview to catch up. */
  isResuming(): boolean;
  dispose(): void;
}

interface Session {
  id: number;
  el: HTMLElement;
  kind: BlockKind;
  startLine: Line;
  lineCount: number;
  /** The block's own trailing blank lines, written back verbatim after the content. */
  trailing: string[];
  /** U14: the blank lines of the block's range before its first content line (the first block of a document
   *  that starts with one), written back verbatim before the content. For an emptied block (`gone`): the
   *  ones it left at the start of the document, where a block typed into it goes after. */
  leading: string[];
  /** Serialization of what the source holds for this block now (session start, then each write). */
  baseline: string;
  /** The exact text of the last write (content + trailing), to recognise our own lines in the source. */
  lastWritten: string | null;
  hints: SerializeHints;
  composing: boolean;
  /** U9: the block was emptied and its deletion written; the session lives on in its wrapper (kept in place by
   *  the host although no block owns it). `startLine` is then where a block typed into it is inserted: right
   *  after the block `prevId` (-1: none, line 1). */
  gone: boolean;
  prevId: number;
  /** H20: the structure version that shows the deletion written for `gone` (-1: none written). */
  goneVersion: number;
  /** P-C: `startLine` of an emptied element is a LINE of the source, kept current through later changes of the
   *  source (trackPlace) with the document's line count and the lines right above it when it was last set
   *  (placeLines < 0: not taken yet). */
  placeLines: number;
  placeAbove: string;
  /** J30: lines between that place and the line the deleted block began at (U18 (b): one kept blank line). */
  goneKeep: number;
  /** Caret as a visible-text offset inside the block (kept current; used when the wrapper is replaced). */
  caretOffset: number;
  /** The inline code ⌘E opened at a collapsed caret: ⌘E again leaves it instead of unwrapping it. */
  openCode: HTMLElement | null;
  /** P-A — THE registry of the helper characters this session put into its DOM (every U+200B it inserts): the spacer
   *  before a formula that starts a line (U21, spacerBefore), the placeholder inside an empty inline code and the
   *  caret place after one (⌘E, toggleInlineCode) — the text nodes that carry them. None is serialized (the serializer
   *  drops U+200B / U+FEFF), none is copied or cut (onClipboard), all go when the session ends (scrubHelpers). */
  spacers: Text[];
  /** P-A: zero-width characters the block's own content showed at the session start (a document can hold U+200B, or
   *  KaTeX output). 0 — nearly always —: every zero-width character in the wrapper is a helper of the session. */
  ownZw: number;
}

/** Where a session continues after a split, a merge or a history step. `expected` is the Markdown that
 *  block must serialize to — until the worker's update for the write has been applied, an OLD block can
 *  sit at the same line with the same length, and a session on it would write stale text. */
interface Resume {
  /** The line the new block STARTS at (`contains` false), or a line it must CONTAIN (`contains` true). */
  startLine: Line;
  contains: boolean;
  lineCount: number | null;
  /** Caret: a visible-text offset inside the new block … */
  offset: number;
  /** … or a source position, mapped once the block is known (history steps). */
  pos: { line: Line; col: number } | null;
  until: number;
  expected: string | null;
  /** Also accepted once the preview's structure has reached this version (null: `expected` only). */
  minVersion: number | null;
  /** Also accepted when the block's DOM serializes to exactly what the source holds in its range. */
  matchSource: boolean;
  /** U7: a click waiting for the structure: the block it starts on (by id; accepted at `minVersion` once the
   *  block is fresh) and the caret / selection the browser made, restored on the session. */
  click?: { id: number; sel: ClickSel } | null;
  /** P-F: how often a click resume was extended while its block's re-render was on its way (at most
   *  MOUNT_WAIT_EXTENSIONS, as G12's history resume). */
  waits?: number;
  /** G12: a history step: its line is scrolled into view (once more after the structure caught up), and the
   *  wait is extended while the block only has to mount. */
  reveal?: { line: Line; again: boolean; extended: number } | null;
  /** U21: the caret stood directly before an image, a formula or a checkbox (no text between): the text offset
   *  alone would put it after that element. */
  beforeAtom?: boolean;
}

/** The browser's caret / selection at the release of a click (U7), as text offsets inside the block plus the
 *  live range (preferred while its nodes are still in the block), and the formula the press was on.
 *  `end` (U18): no click — the caret goes to the end of the block's content and a refusal shows no toast. */
interface ClickSel { range: Range | null; backward: boolean; anchor: number; focus: number; math: HTMLElement | null; end?: boolean }

/** Input that arrived while a resume was waiting, replayed in order on the resumed session (U4). */
type Op =
  | { t: 'text'; data: string }
  | { t: 'key'; key: string; shift: boolean; alt: boolean; mod: boolean }
  | { t: 'history'; redo: boolean }
  | { t: 'format'; cmd: 'bold' | 'italic' | 'code' | 'link' }
  | { t: 'paste'; text: string }
  | { t: 'edit'; cmd: EditCmd; shift: boolean }
  /** G11: the empty paragraph the caret sat in when the split was written (it has no source of its own):
   *  recreated after (`before`: before) the caret's top-level element, the caret in it. */
  | { t: 'para'; before: boolean };

/** P-G: queued input that would have changed the text (moves, Esc and ⌘A would not; the empty paragraph a split
 *  recreates has no source). */
function changesText(op: Op): boolean {
  switch (op.t) {
    case 'text': return op.data !== '';
    case 'paste': case 'history': case 'format': return true;
    case 'key': return op.key === 'Backspace' || op.key === 'Delete' || op.key === 'Enter' || op.key === 'Tab';
    case 'edit': return op.cmd.startsWith('del');
    case 'para': return false;
  }
}

/** G10: a caret / editing key with ⌘ or Ctrl that the browser applies inside a session, replayed after a
 *  resume with the same effect (macOS key bindings; off the Mac, the Ctrl variants of Chrome's editing keys). */
export type EditCmd = 'lineStart' | 'lineEnd' | 'paraStart' | 'paraEnd' | 'docStart' | 'docEnd' | 'charBack' | 'charFwd'
  | 'lineUp' | 'lineDown' | 'wordBack' | 'wordFwd' | 'delLineBack' | 'delLineFwd' | 'delParaFwd' | 'delBack' | 'delFwd'
  | 'delWordBack' | 'delWordFwd' | 'selectAll';

export function editCmdOf(e: KeyboardEvent, mac: boolean = IS_MAC): EditCmd | null {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const letter = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : k;
  if (mac && e.metaKey && !e.ctrlKey && !e.altKey) {
    switch (k) {
      case 'ArrowLeft': return 'lineStart';
      case 'ArrowRight': return 'lineEnd';
      case 'ArrowUp': case 'Home': return 'docStart';
      case 'ArrowDown': case 'End': return 'docEnd';
      case 'Backspace': return 'delLineBack';
      case 'Delete': return 'delLineFwd';
    }
    return letter === 'a' && !e.shiftKey ? 'selectAll' : null;
  }
  if (mac && e.ctrlKey && !e.metaKey) {
    if (e.altKey) return letter === 'b' ? 'wordBack' : letter === 'f' ? 'wordFwd' : k === 'Backspace' ? 'delWordBack' : null;
    switch (k) {
      case 'ArrowLeft': return 'lineStart';
      case 'ArrowRight': return 'lineEnd';
      case 'Backspace': return 'delBack';
    }
    switch (letter) {
      case 'a': return 'paraStart';
      case 'e': return 'paraEnd';
      case 'b': return 'charBack';
      case 'f': return 'charFwd';
      case 'p': return 'lineUp';
      case 'n': return 'lineDown';
      case 'd': return 'delFwd';
      case 'h': return 'delBack';
      case 'k': return 'delParaFwd';
    }
    return null;
  }
  if (!mac && e.ctrlKey && !e.metaKey && !e.altKey) {
    switch (k) {
      case 'ArrowLeft': return 'wordBack';
      case 'ArrowRight': return 'wordFwd';
      case 'ArrowUp': return 'paraStart';
      case 'ArrowDown': return 'paraEnd';
      case 'Home': return 'docStart';
      case 'End': return 'docEnd';
      case 'Backspace': return 'delWordBack';
      case 'Delete': return 'delWordFwd';
    }
    return letter === 'a' && !e.shiftKey ? 'selectAll' : null;
  }
  return null;
}

// ---------------------------------------------------------------- caret ↔ text offset
/** Containers whose whitespace-only text children are markup formatting, never a caret position. */
const LAYOUT_PARENTS = new Set(['SECTION', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'BLOCKQUOTE', 'DIV']);

/** Text nodes that make up what the user reads (KaTeX's hidden MathML copy and the whitespace between
 *  block elements excluded). */
function visibleTexts(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest('.katex-mathml, [data-mdr-ui]')) return 2;
      if (LAYOUT_PARENTS.has(p.tagName) && /^[ \t\r\n]*$/.test((n as Text).data)) return 2;
      return 1;
    },
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) out.push(n as Text);
  return out;
}

const visibleLength = (root: Element): number => visibleTexts(root).reduce((n, t) => n + t.data.length, 0);

/** Content that shows without text of its own. */
const REPLACED = 'img, input, hr, svg, video, audio, iframe, canvas, object, embed, .md-math, .md-math-src';
const INK = /[^ \t\r\n\u200b\ufeff]/;
/** U13: the whitespace an Enter does not carry into the new paragraph (collapsible: shown as one space). */
const PLAIN_WS = ' \t\n';
/** U13: inline formatting whose text continues a run of whitespace (anything else ends it). */
const WS_INLINE = new Set(['A', 'EM', 'STRONG', 'B', 'I', 'S', 'DEL', 'STRIKE', 'U', 'MARK', 'SPAN', 'FONT', 'INS', 'SMALL', 'SUB', 'SUP', 'ABBR', 'CITE', 'DFN', 'VAR', 'BIG', 'TIME', 'BDI']);

/** U21: an element shown without editable text of its own — a caret stands before or after it, never in it. */
const ATOM_SEL = 'img, input, .md-math, [contenteditable="false"]';
/** U21: an atom the browser cannot put a caret before when it starts a line (a non-editable formula). */
const NEEDS_SPACER = '.md-math, [contenteditable="false"]';
const LINE_BOX = 'p, li, td, th, h1, h2, h3, h4, h5, h6';
/** U21: a character other than the zero-width ones the session puts in (built from code points: no literal
 *  invisible character in this file). */
const NOT_ZW = new RegExp(`[^${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`);

/** U21: nothing is shown before `atom` on its line inside `root` (its line container's start or a <br> comes first). */
function lineLeading(atom: Element, root: Element): boolean {
  for (let n: Node = atom; n !== root && n.parentNode; n = n.parentNode) {
    for (let p = n.previousSibling; p; p = p.previousSibling) {
      if (p.nodeType === 3) { if (INK.test((p as Text).data)) return false; continue; }
      if (p.nodeType !== 1) continue;
      const e = p as Element;
      if (e.tagName === 'BR') return true;
      if (!e.hasAttribute('data-mdr-ui') && hasContent(e)) return false;
    }
    const par = n.parentNode as Element;
    if (par === root || par.matches(LINE_BOX)) return true;
  }
  return true;
}

/** G11: a paragraph with nothing in it (the browser's `<p><br></p>`): it has no source of its own. */
function emptyParagraph(n: Node): boolean {
  if (n.nodeType !== 1) return false;
  const e = n as Element;
  return (e.tagName === 'P' || e.tagName === 'DIV') && !e.hasAttribute('data-mdr-ui')
    && !INK.test(e.textContent ?? '') && !e.querySelector(REPLACED);
}

function hasContent(n: Node): boolean {
  if (n.nodeType === 3) return INK.test((n as Text).data);
  if (n.nodeType !== 1) return false;
  const e = n as Element;
  if (e.hasAttribute('data-mdr-ui')) return false;
  return e.matches(REPLACED) || INK.test(e.textContent ?? '') || e.querySelector(REPLACED) !== null;
}

/** Visible-text offset of (node, offset) inside `root`. */
export function textOffsetOf(root: Element, node: Node, offset: number): number {
  let total = 0;
  const texts = visibleTexts(root);
  if (node.nodeType === 3) {
    for (const t of texts) {
      if (t === node) return total + Math.min(offset, t.data.length);
      total += t.data.length;
    }
    return total;
  }
  // an element position: count the text before its `offset`-th child
  const stop = node.childNodes[offset] ?? null;
  for (const t of texts) {
    if (stop && (stop === t || stop.contains(t) || (stop.compareDocumentPosition(t) & 4 /* FOLLOWING */))) break;
    if (!stop && !node.contains(t) && (node.compareDocumentPosition(t) & 4)) break;
    total += t.data.length;
  }
  return total;
}

/** Puts a collapsed caret at visible-text offset `offset` of `root` (clamped). */
export function setCaretAtOffset(root: Element, offset: number): void {
  const sel = root.ownerDocument.getSelection();
  if (!sel) return;
  const range = root.ownerDocument.createRange();
  let left = Math.max(0, offset);
  const texts = visibleTexts(root);
  let placed = false;
  for (const t of texts) {
    if (left <= t.data.length) {
      // never between the two halves of a surrogate pair (an emoji): before it
      if (left > 0 && left < t.data.length && /[\ud800-\udbff]/.test(t.data[left - 1]) && /[\udc00-\udfff]/.test(t.data[left])) left--;
      range.setStart(t, left);
      placed = true;
      break;
    }
    left -= t.data.length;
  }
  if (!placed) {
    const last = texts[texts.length - 1];
    if (last) range.setStart(last, last.data.length);
    else range.setStart(root, root.childNodes.length);
  }
  // P-D: never inside a non-editable element (a formula's rendered text): directly after it, or before it when the
  // offset is its very start
  let ne: Element | null = null;
  for (let e = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement; e && e !== root && root.contains(e); e = e.parentElement) {
    if (e.matches(NEEDS_SPACER)) ne = e;
  }
  if (ne) {
    if (textOffsetOf(ne, range.startContainer, range.startOffset) === 0) range.setStartBefore(ne);
    else range.setStartAfter(ne);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** U20: the DOM position of visible-text offset `offset` of `root` (clamped; inside a text node when there is one). */
function pointAtOffset(root: Element, offset: number): [Node, number] {
  let left = Math.max(0, offset);
  const texts = visibleTexts(root);
  for (const t of texts) {
    if (left <= t.data.length) return [t, left];
    left -= t.data.length;
  }
  const last = texts[texts.length - 1];
  return last ? [last, last.data.length] : [root, root.childNodes.length];
}

// ---------------------------------------------------------------- selection end points across a re-render (P-E)
/** P-E: the line boxes a selection end point is described in (a paragraph, an item, a cell, a heading, a code block),
 *  in document order inside a block's wrapper — the app's UI, KaTeX's markup and an opened formula source left out. */
const KEEP_BOX = 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre, dt, dd';
function keepBoxes(w: Element): Element[] {
  return Array.from(w.querySelectorAll(KEEP_BOX)).filter((e) => !e.classList.contains('md-math-src') && !e.closest('[data-mdr-ui], .katex, .md-math'));
}
/** P-E: what a selection end point is across a re-render: the index of its innermost line box among keepBoxes (-1: the
 *  wrapper itself), how many boxes the wrapper had, and the units of text before it inside that box (eachUnit); for a
 *  point inside an atom (a drag that ended on a formula's rendered text), the units before the atom and the
 *  visible-text offset inside it. */
interface KeptPoint { box: number; boxes: number; units: number; inner: number | null }
/** P-E: visits the content of `root` in units as the rendering shows it — each character one, zero-width characters
 *  none; outside <pre> a run of collapsible whitespace (space, tab, line feed, a non-breaking space the browser put in
 *  for a typed space) one and none at the start of the box or of a line; a formula (rendered, or opened as its TeX
 *  source), an image, a checkbox and a <br> one, never entered — and calls `unit` with the DOM point right after each
 *  unit and the one right before it; true stops the walk. The session DOM and the block's re-render read the same
 *  in these units: an opened formula is one unit in both, two typed spaces the write collapsed are one. */
function eachUnit(root: Node, pre: boolean, unit: (after: [Node, number], before: [Node, number], atom?: Element) => boolean): boolean {
  let emitted = false;
  let inRun = false;
  const indexIn = (p: Node, c: Node): number => Array.prototype.indexOf.call(p.childNodes, c) as number;
  const walk = (el: Node): boolean => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const d = (c as Text).data;
        for (let i = 0; i < d.length; i++) {
          const code = d.charCodeAt(i);
          if (code === 0x200b || code === 0xfeff) continue;
          if (!pre && (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xa0)) {
            if (!emitted || inRun) continue;
            inRun = true;
          } else { inRun = false; emitted = true; }
          if (unit([c, i + 1], [c, i])) return true;
        }
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      if (e.hasAttribute('data-mdr-ui') || e.classList.contains('katex-mathml')) continue;
      if (e.matches(UNIT_ATOM) || e.classList.contains('md-math-src') || e.tagName === 'BR') {
        const br = e.tagName === 'BR';
        emitted = !br || emitted;
        inRun = br;                                // (the whitespace starting the next line shows none)
        const i = indexIn(el, e);
        if (unit([el, i + 1], [el, i], br ? undefined : e)) return true;
        continue;
      }
      if (walk(e)) return true;
    }
    return false;
  };
  return walk(root);
}
const inPre = (box: Element): boolean => box.tagName === 'PRE' || box.closest('pre') !== null;
/** P-E: the end point (node, offset) inside wrapper `w` as a KeptPoint. */
function keepPoint(w: Element, node: Node, offset: number): KeptPoint {
  const boxes = keepBoxes(w);
  let box: Element | null = null;
  for (let e: Element | null = node.nodeType === 1 ? node as Element : node.parentElement; e && e !== w; e = e.parentElement) {
    if (boxes.includes(e)) { box = e; break; }
  }
  const root: Element = box ?? w;
  // inside an atom: counted up to the atom, the offset inside it kept apart
  let atom: Element | null = null;
  for (let e: Element | null = node.nodeType === 1 ? node as Element : node.parentElement; e && e !== root && root.contains(e); e = e.parentElement) {
    if (e.matches(UNIT_ATOM) || e.classList.contains('md-math-src')) atom = e;
  }
  const r = root.ownerDocument.createRange();
  r.setStart(root, 0);
  try { if (atom) r.setEndBefore(atom); else r.setEnd(node, offset); } catch { r.setEnd(root, 0); }
  let units = 0;
  eachUnit(r.cloneContents(), inPre(root), () => { units++; return false; });
  return { box: box ? boxes.indexOf(box) : -1, boxes: boxes.length, units, inner: atom ? textOffsetOf(atom, node, offset) : null };
}
/** P-E: the DOM point a KeptPoint names in wrapper `w` (re-rendered), or null when its line boxes do not correspond
 *  (another number of them): right after its `units`-th unit, at its box's first unit for none, clamped to its end. */
function pointOfKept(w: Element, k: KeptPoint): [Node, number] | null {
  const boxes = keepBoxes(w);
  if (boxes.length !== k.boxes || k.box >= boxes.length) return null;
  const root = k.box < 0 ? w : boxes[k.box];
  let n = 0;
  let at: [Node, number] | null = null;
  let first: [Node, number] | null = null;
  let last: [Node, number] | null = null;
  let inside: [Node, number] | null = null;
  eachUnit(root, inPre(root), (after, before, atom) => {
    first ??= before;
    last = after;
    if (k.inner !== null) {
      // the atom right after `units` units: the same offset inside it
      if (n++ === k.units) { if (atom && atom.matches('.md-math')) inside = pointAtOffset(atom, k.inner); else at = before; return true; }
      return false;
    }
    if (++n >= k.units) { at = after; return true; }
    return false;
  });
  if (inside) return inside;
  if (k.units === 0 && k.inner === null) return first ?? [root, 0];
  return at ?? last ?? [root, root.childNodes.length];
}

function codeHints(kind: BlockKind, lines: string[]): SerializeHints['fence'] | undefined {
  if (kind !== BlockKind.Code || lines.length === 0) return undefined;
  const m = /^( {0,3})(`{3,}|~{3,})/.exec(lines[0]);
  if (m) {
    const ch = m[2][0] === '`' ? '`' : '~';
    const closeRe = new RegExp(`^ {0,3}\\${ch}{${m[2].length},}[ \\t]*$`);
    for (let i = 1; i < lines.length; i++) {
      if (closeRe.test(lines[i])) return i === lines.length - 1 ? { open: lines[0], close: lines[i] } : undefined;
    }
    return { open: lines[0], close: null };
  }
  if (/^( {4}|\t)/.test(lines[0])) return { indent: '    ' };
  return undefined;
}

/** A block's source without its trailing blank lines and (U14) without the blank lines before its first
 *  content line — only the first block of a document that starts with a blank line has those. A block of
 *  blank lines only is all `trailing`. */
function contentOf(text: string): { content: string; lines: string[]; leading: string[]; trailing: string[] } {
  const lines = text.split('\n');
  let n = lines.length;
  while (n > 0 && lines[n - 1].trim() === '') n--;
  let k = 0;
  while (k < n && lines[k].trim() === '') k++;
  return { content: lines.slice(k, n).join('\n'), lines: lines.slice(k, n), leading: lines.slice(0, k), trailing: lines.slice(n) };
}

/** U14: what a session writes for its block — the leading blank lines, the content, the trailing blank lines. */
function framed(leading: string[], text: string, trailing: string[]): string {
  return (leading.length > 0 ? leading.join('\n') + '\n' : '') + text + (trailing.length > 0 ? '\n' + trailing.join('\n') : '');
}

// ---------------------------------------------------------------- source position → caret (P-D)
/** P-D: elements shown as ONE caret position with no text of their own to enter (a formula's rendered text is not
 *  the user's to type into). */
const UNIT_ATOM = 'img, input, svg, video, audio, iframe, canvas, object, embed, .md-math, [contenteditable="false"]';
/** Raw HTML written in the source that shows as one such atom. */
const RAW_ATOM = /^<(?:img|input|svg|video|audio|iframe|canvas|object|embed)(?=[\s/>])/i;
const RAW_TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const ENTITY = /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/iy;
const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const isBlank = (c: string | undefined): boolean => c === undefined || c === ' ' || c === '\t' || c === '\n';
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** P-D: what one scan of a source line knows about its closers, so that the scan stays linear in the line's length
 *  (a run of unmatched brackets, dollars or backticks would otherwise make every opener look to the end again). */
interface LineScan {
  /** The index of the bracket that closes the `[` / `(` at an index (escapes respected), or -1. */
  close: Int32Array;
  /** The start indices of the backtick runs of each length, in order. */
  ticks: Map<number, number[]>;
  /** Per end of the scanned text: no inline formula opens at or after these indices (math.ts's memo: a scan that
   *  found no closer proves it for every later opener), with an opener that is not a digit / that is a digit; no
   *  `$$…$$` at or after `double`. */
  noMath: Map<number, { plain: number; digit: number; double: number }>;
}

function scanLine(s: string): LineScan {
  const close = new Int32Array(s.length).fill(-1);
  const sq: number[] = [], par: number[] = [];
  const ticks = new Map<number, number[]>();
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '[') sq.push(k);
    else if (c === ']') { const o = sq.pop(); if (o !== undefined) close[o] = k; }
    else if (c === '(') par.push(k);
    else if (c === ')') { const o = par.pop(); if (o !== undefined) close[o] = k; }
    else if (c === '`') {
      let q = k;
      while (q < s.length && s[q] === '`') q++;
      const run = ticks.get(q - k);
      if (run) run.push(k); else ticks.set(q - k, [k]);
      k = q - 1;
    }
  }
  return { close, ticks, noMath: new Map() };
}

/** The index of the bracket that closes the one at `i`, when it lies before `b`; else -1. */
const closeOf = (cx: LineScan, i: number, b: number): number => (i < cx.close.length && cx.close[i] >= 0 && cx.close[i] < b ? cx.close[i] : -1);

/** The end (after the closer) of the inline formula that opens at `i`, by the worker's rule (src/worker/math.ts
 *  mathInline: `$$…$$`; `$…$` whose opener is not followed by whitespace, whose closer is not preceded by
 *  whitespace or a backslash nor followed by a digit, and not a pair of prices), or -1. */
function formulaEnd(s: string, i: number, b: number, cx: LineScan): number {
  let memo = cx.noMath.get(b);
  if (!memo) { memo = { plain: Infinity, digit: Infinity, double: Infinity }; cx.noMath.set(b, memo); }
  if (s[i + 1] === '$') {
    if (i >= memo.double) return -1;
    const e = s.indexOf('$$', i + 2);
    if (e < 0 || e + 2 > b) { memo.double = Math.min(memo.double, i); return -1; }
    return e + 2;
  }
  const opener = s[i + 1];
  if (i + 1 >= b || isBlank(opener)) return -1;
  const digitOpener = isDigit(opener);
  if (i >= (digitOpener ? memo.digit : memo.plain)) return -1;
  for (let e = s.indexOf('$', i + 1); e >= 0 && e < b; e = s.indexOf('$', e + 1)) {
    const prev = s[e - 1], after = e + 1 < b ? s[e + 1] : undefined;
    const currency = digitOpener && isDigit(prev) && isBlank(after);
    if (prev === '\\' || isBlank(prev) || isDigit(after) || currency) continue;
    return e === i + 1 ? -1 : e + 1;
  }
  if (!digitOpener) memo.plain = Math.min(memo.plain, i);
  memo.digit = Math.min(memo.digit, i);
  return -1;
}

/** The start of the first backtick run of exactly `run` backticks at or after `from` and before `b`, or -1. */
function tickRunAt(cx: LineScan, run: number, from: number, b: number): number {
  const starts = cx.ticks.get(run);
  if (!starts) return -1;
  let lo = 0, hi = starts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < from) lo = mid + 1; else hi = mid; }
  return lo < starts.length && starts[lo] < b ? starts[lo] : -1;
}

/** P-D: the caret positions that s[a, col) shows (a ≤ col ≤ b, b the end of the text): one for each character shown,
 *  ONE for each atom (an inline formula, an image, a raw <img> …) whatever its source and its rendered text, none
 *  for markup (emphasis delimiters, a link's destination or reference label, raw HTML tags, a code span's
 *  backticks, a hard break's backslash); an escape and an entity are one. A column inside an atom's source counts
 *  the atom (the caret goes after it). `isLink(t)`: `[t]` without a destination is a (shortcut reference) link.
 *  `cx`: the line's scan (scanLine): linear in the line's length. */
function inlineUnits(s: string, a: number, b: number, col: number, isLink: (t: string) => boolean, cx: LineScan): number {
  let n = 0;
  let i = a;
  const end = Math.min(b, col);
  while (i < end) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < b && PUNCT.test(s[i + 1])) { n++; i += 2; continue; }
      if (i + 1 >= b) { i++; continue; }         // a hard break's backslash shows nothing
      n++; i++; continue;
    }
    if (c === '`') {
      let k = i;
      while (k < b && s[k] === '`') k++;
      const run = k - i;
      const close = tickRunAt(cx, run, k, b);
      if (close < 0) { n += Math.min(k, end) - i; i = k; continue; }   // literal backticks
      let cs = k, ce = close;
      if (ce - cs >= 2 && s[cs] === ' ' && s[ce - 1] === ' ' && s.slice(cs, ce).trim() !== '') { cs++; ce--; }
      if (col < close + run) return n + Math.max(0, Math.min(col, ce) - cs);
      n += ce - cs;
      i = close + run;
      continue;
    }
    if (c === '$') {
      const e = formulaEnd(s, i, b, cx);
      n++;
      i = e > 0 ? e : i + 1;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const j = closeOf(cx, i + 1, b);
      const k = j < 0 ? -1 : s[j + 1] === '(' || s[j + 1] === '[' ? closeOf(cx, j + 1, b) : -1;
      if (k > 0) { n++; i = k + 1; continue; }
      n++; i++; continue;
    }
    if (c === '[') {
      const j = closeOf(cx, i, b);
      const k = j < 0 ? -1 : s[j + 1] === '(' || s[j + 1] === '[' ? closeOf(cx, j + 1, b) : isLink(s.slice(i + 1, j)) ? j : -1;
      if (k > 0) {
        if (col <= j) return n + inlineUnits(s, i + 1, j, Math.max(col, i + 1), isLink, cx);
        n += inlineUnits(s, i + 1, j, j, isLink, cx);
        i = k + 1;
        continue;
      }
      n++; i++; continue;
    }
    if (c === '<') {
      AUTOLINK.lastIndex = i;
      const al = AUTOLINK.exec(s);
      if (al && i + al[0].length <= b) {
        if (col < i + al[0].length) return n + Math.max(0, Math.min(col - i - 1, al[1].length));
        n += al[1].length;
        i += al[0].length;
        continue;
      }
      RAW_TAG.lastIndex = i;
      const tag = RAW_TAG.exec(s);
      if (tag && i + tag[0].length <= b) {
        if (RAW_ATOM.test(tag[0])) n++;
        i += tag[0].length;
        continue;
      }
      n++; i++; continue;
    }
    if (c === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      n++;
      i += m && i + m[0].length <= b ? m[0].length : 1;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let k = i;
      while (k < b && s[k] === c) k++;
      const before = i > a ? s[i - 1] : i > 0 ? s[i - 1] : undefined, after = k < b ? s[k] : undefined;
      // a run between two blanks, a single ~ and an intraword _ show as they are; other runs are delimiters
      const literal = (isBlank(before) && isBlank(after)) || (c === '~' && k - i < 2)
        || (c === '_' && before !== undefined && after !== undefined && WORD.test(before) && WORD.test(after));
      if (literal) n += Math.min(k, end) - i;
      i = k;
      continue;
    }
    n++;
    i++;
  }
  return n;
}

/** P-D: the caret positions that line `line` of a block of kind `kind` shows up to column `col`: its block markers
 *  (quote markers, a heading's #, a list marker; a table row's pipes) and the whitespace around its text show
 *  nothing, a task's checkbox is one atom (the text after it keeps its space, as the worker renders it).
 *  `first`: the line is the first of its element (a marker can start it). */
function lineUnits(line: string, col: number, first: boolean, kind: BlockKind, isLink: (t: string) => boolean): number {
  let a = /^[ \t]*(?:>[ \t]?)*/.exec(line)![0].length;
  const b = line.replace(/[ \t]+$/, '').length;    // trailing whitespace is not shown (a soft or a hard break)
  const c = Math.max(0, Math.min(col, b));
  const cx = scanLine(line);
  if (kind === BlockKind.Table) {
    let n = 0;
    let k = a + (/^[ \t]*\|/.exec(line.slice(a))?.[0].length ?? 0);
    while (k <= b) {
      let e = k;
      while (e < b && !(line[e] === '|' && line[e - 1] !== '\\')) e++;
      let ts = k, te = e;
      while (ts < te && (line[ts] === ' ' || line[ts] === '\t')) ts++;
      while (te > ts && (line[te - 1] === ' ' || line[te - 1] === '\t')) te--;
      if (c <= ts) return n;
      n += inlineUnits(line, ts, te, Math.min(c, te), isLink, cx);
      if (c <= e || e >= b) return n;
      k = e + 1;
    }
    return n;
  }
  let atom = 0;
  if (first || kind === BlockKind.List) {
    const m = /^(?:#{1,6}(?:[ \t]+|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/.exec(line.slice(a));
    if (m) {
      const marker = m[0];
      a += marker.length;
      if (kind === BlockKind.List && marker[0] !== '#' && /^\[[ xX]\](?=[ \t]|$)/.test(line.slice(a))) {
        if (c > a) atom = 1;
        a += 3;
        return atom + (c > a ? inlineUnits(line, a, b, c, isLink, cx) : 0);
      }
    }
  }
  a += /^[ \t]*/.exec(line.slice(a))![0].length;
  return c > a ? inlineUnits(line, a, b, c, isLink, cx) : 0;
}

/** P-D: the DOM point `n` caret positions into `host`, counted as lineUnits counts them: each shown character one
 *  (zero-width spacers none), each atom one and never entered, a <br> none (the line break after it is text);
 *  the element of a later line (`later`: a nested [data-l] of a following line) ends the walk. At the end of a
 *  text node rather than at the start of the next one, directly after an atom rather than inside what follows it;
 *  clamped to the end of the host's own content (an empty list item: inside it). */
function pointAtUnits(host: Element, n: number, later: (e: Element) => boolean = () => false): [Node, number] {
  let left = Math.max(0, n);
  let last: [Node, number] = [host, 0];
  const indexIn = (p: Node, c: Node): number => Array.prototype.indexOf.call(p.childNodes, c) as number;
  const walk = (el: Element): [Node, number] | null | false => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = c as Text;
        if (LAYOUT_PARENTS.has(el.tagName) && /^[ \t\r\n]*$/.test(t.data)) continue;
        let k = 0;
        while (k < t.data.length && left > 0) {
          const ch = t.data.charCodeAt(k);
          if (ch !== 0x200b && ch !== 0xfeff) left--;
          k++;
        }
        if (left === 0) {
          // never between the two halves of a surrogate pair
          if (k > 0 && k < t.data.length && /[\ud800-\udbff]/.test(t.data[k - 1]) && /[\udc00-\udfff]/.test(t.data[k])) k--;
          return [t, k];
        }
        last = [t, t.data.length];
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      if (e.hasAttribute('data-mdr-ui') || e.classList.contains('katex-mathml')) continue;
      if (later(e)) return false;                 // a later line's element: the host's own content ends here
      if (e.matches(UNIT_ATOM)) {
        const i = indexIn(el, e);
        if (left === 0) return [el, i];
        left--;
        if (left === 0) return [el, i + 1];
        last = [el, i + 1];
        continue;
      }
      if (e.tagName === 'BR') { last = [el, indexIn(el, e) + 1]; continue; }
      const r = walk(e);
      if (r !== null) return r;
    }
    return null;
  };
  const r = walk(host);
  return r ? r : last;
}

/** P-D — THE mapping from a source position (line, col) of block `info` (content lines `lines`) to a DOM caret point
 *  in its wrapper `w`, for every resume that carries a source position (⌘Z / ⇧⌘Z, a merge): counted in caret
 *  positions on both sides (lineUnits / pointAtUnits: an inline formula, an image, a checkbox one, markup none,
 *  reference links and escapes longer in the source than on screen) inside the element that carries the line
 *  (data-l), so an empty list item, a table cell, the end of a line that ends with a formula are reached exactly,
 *  and never a point inside an atom (the caller's placeSafe holds that for any point). `math`: the block is a
 *  display formula, whose TeX source is the only place to type. U22: a position before the content lines (a
 *  leading blank line, U14) is the start of the content, one after them (the block's trailing blank lines) the
 *  END of the content — not a column of the last line. `lead`: the block's lines before `lines` (U14's leading
 *  blank lines; the worker's data-l counts from the block's first line). */
function caretForSource(w: HTMLElement, info: BlockInfo, lines: string[], line: Line, col: number, lead = 0): { point: [Node, number] } | { math: HTMLElement } {
  if (lines.length === 0) return { point: pointAtUnits(w, 0) };
  const before = line < info.startLine, after = line > info.startLine + lines.length - 1;
  const rel = before ? 0 : after ? lines.length - 1 : line - info.startLine;
  const c = before ? 0 : after ? lines[rel].length : Math.max(0, Math.min(col, lines[rel].length));
  const pre = info.kind === BlockKind.Code || info.kind === BlockKind.Math ? w.querySelector('pre') : null;
  if (pre) {
    const fenced = /^ {0,3}(`{3,}|~{3,}|\$\$)/.test(lines[0]);
    const strip = fenced ? 0 : 4;
    const code = visibleTexts(pre).map((t) => t.data).join('');
    // after the content: the end of the code's last line (before the line break that ends the code text)
    if (after) return { point: pointAtOffset(pre, code.length - (code.endsWith('\n') ? 1 : 0)) };
    let off = 0;
    if (!fenced || rel > 0) {
      for (let i = fenced ? 1 : 0; i < rel; i++) off += Math.max(0, lines[i].length - strip) + 1;
      off += Math.max(0, c - strip);
    }
    return { point: pointAtOffset(pre, Math.min(off, code.length)) };
  }
  if (info.kind === BlockKind.Math) {
    const m = w.querySelector<HTMLElement>('.md-math');
    if (m) return { math: m };
  }
  // the innermost element whose own first line is the closest one at or above `rel`
  let host: Element = w;
  let hostL = 0;
  for (const e of Array.from(w.querySelectorAll('[data-l]'))) {
    const l = Number(e.getAttribute('data-l')) - lead;
    if (Number.isFinite(l) && l <= rel && l >= hostL) { host = e; hostL = l; }
  }
  const later = (e: Element): boolean => { const l = Number(e.getAttribute('data-l')) - lead; return Number.isFinite(l) && l > hostL; };
  // `[t]` alone is a link when the element shows a link with that text (a shortcut reference)
  const shown = new Set(Array.from(host.querySelectorAll('a')).map((a) => a.textContent ?? ''));
  const isLink = (t: string): boolean => shown.has(t) || shown.has(t.replace(/[*_`~\\]/g, ''));
  let n = 0;
  for (let i = hostL; i < rel; i++) n += lineUnits(lines[i], lines[i].length, i === hostL, info.kind, isLink) + 1;
  n += lineUnits(lines[rel], c, rel === hostL, info.kind, isLink);
  return { point: pointAtUnits(host, n, later) };
}

// ---------------------------------------------------------------- task checkbox clicks that wait (U16 amended)
/** A task checkbox click that waits for its block to show its current source: WHICH task it was, in terms that
 *  survive a re-render — the block (its id; its place at the click), the box's ordinal among the block's checkboxes
 *  and the item texts of all of them as the user saw them. `input`: the element hit (it holds the focus meanwhile). */
interface TaskClick { input: HTMLInputElement; id: number; startLine: Line; ordinal: number; texts: string[]; waits: number }

const ZW_ALL = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`, 'g');
const ZW_ONE = new RegExp(`[${String.fromCharCode(0x200b)}${String.fromCharCode(0xfeff)}]`);
/** P-G: a stamp attribute in serialized HTML (a drag's text/html), with its leading space. */
const STAMP_ATTR_RE = new RegExp(` (?:${STAMP_ATTRS.join('|')})="[^"]*"`, 'g');
/** P-A: the text nodes under `root` (the app's UI left out) that hold a zero-width character. */
function zwTexts(root: Node): Text[] {
  const out: Text[] = [];
  const d = root.ownerDocument ?? (root as Document);
  const tw = d.createTreeWalker(root, 4, { acceptNode: (n) => (n.parentElement?.closest('[data-mdr-ui]') || !ZW_ONE.test((n as Text).data) ? 2 : 1) });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) out.push(n as Text);
  return out;
}
/** P-A: how many zero-width characters the text under `root` holds. */
const zwCount = (root: Node): number => zwTexts(root).reduce((k, t) => k + (t.data.match(ZW_ALL)?.length ?? 0), 0);
/** The task boxes of a block, in document order: only each task item's own checkbox (U24, RVT-3: ownTaskBox; the app's
 *  UI excluded). */
function taskBoxes(w: Element): HTMLInputElement[] {
  return Array.from(w.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).filter((b) => !b.closest('[data-mdr-ui]') && ownTaskBox(b));
}
/** The text of a checkbox's own item (its nested lists left out), whitespace collapsed, zero-width characters out. */
function taskText(box: HTMLInputElement): string {
  const li = box.closest('li');
  const own = li
    ? Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test((c as Element).tagName))).map((c) => c.textContent ?? '').join('')
    : box.parentElement?.textContent ?? '';
  return own.replace(ZW_ALL, '').replace(/\s+/g, ' ').trim();
}
/** U16 amended: the checkbox of the task `tg` names in the current wrapper `w`, only when it is certain: the block's
 *  tasks read as they did (the same ordinal), else the only task with the clicked text, else the task at the same
 *  ordinal with the same text between the same neighbours; null otherwise (nothing is ticked). */
function taskOf(w: Element, tg: TaskClick): HTMLInputElement | null {
  const boxes = taskBoxes(w);
  const texts = boxes.map(taskText);
  const k = tg.ordinal;
  const want = tg.texts[k];
  if (k < 0 || want === undefined) return null;
  if (texts.length === tg.texts.length && texts.every((t, i) => t === tg.texts[i])) return boxes[k];
  const same = texts.flatMap((t, i) => (t === want ? [i] : []));
  if (same.length === 1) return boxes[same[0]];
  if (texts[k] === want && texts[k - 1] === tg.texts[k - 1] && texts[k + 1] === tg.texts[k + 1]) return boxes[k];
  return null;
}

export function createInlineEdit(host: InlineEditHost): InlineEditApi {
  const { root, bus } = host;
  const src = host.source;
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  let editable = false;
  let s: Session | null = null;
  let raf = 0, caretRaf = 0;
  let resume: Resume | null = null;
  let resumeTimer = 0;
  /** Input queued while a resume waits (U4); replayed on the next session. */
  let ops: Op[] = [];
  /** Inside end(): a lost block must not start a resume (see end()). */
  let ending = false;
  let linkUi: { box: HTMLElement; range: Range } | null = null;
  const refusedAt = new Map<number, number>();
  let disposed = false;
  /** Document-changing transactions this module caused since `baseVersion` was taken: the structure that
   *  shows their result has version baseVersion + changes (the preview applies structures in order). */
  let baseVersion = -1;
  let changes = 0;
  /** U7: the primary button went down in the preview and is not released yet. A session end it causes
   *  writes at once, but the DOM change that follows (the block's re-render, the removal of an emptied
   *  wrapper) waits until after the click: `deferred` holds that block's `host.release`. `forResume`: an
   *  emptied wrapper stays until the resume that continues the user's text has started. */
  let pointerDown = false;
  let deferred: { id: number; forResume: boolean } | null = null;
  let deferTimer = 0;
  /** U7: a press that starts a session when it is released in the same block. */
  let press: { w: HTMLElement; target: Element } | null = null;
  /** U7: a press inside the session's block; a drag that leaves the block ends the session. */
  let dragFrom: Session | null = null;
  /** U16 amended: a task checkbox clicked outside a session while its block did not show its current source: toggled
   *  (by a replayed click) on the task the user clicked once it does (replayToggle). */
  let pendingToggle: TaskClick | null = null;
  let toggleTimer = 0;
  let replayingClick = false;
  /** G6: a paste made new paragraphs: the resume that follows its write scrolls the caret's block into view
   *  (it can be far from the old block's top) and waits for it to mount. */
  let pasteSplit = false;
  /** P-G (e): the task checkboxes this module put into items an Enter made (enterKey). */
  const freshBoxes = new WeakSet<Element>();

  // ---------------------------------------------------------------- hint bar
  const hint = doc.createElement('div');
  hint.className = 'mdr-preview__edit-hint';
  hint.setAttribute('data-mdr-ui', '');
  hint.setAttribute('aria-live', 'polite');
  const pill = doc.createElement('span');
  pill.className = 'mdr-preview__edit-hint-pill';
  pill.textContent = EDIT_HINT_TEXT;
  hint.appendChild(pill);
  hint.hidden = true;
  (host.hintParent ?? root).appendChild(hint);

  // ---------------------------------------------------------------- resume capture element
  /** Holds the focus while a resume waits, so keys and IME text have somewhere to go (they are queued,
   *  never shown). Invisible; placed at the old caret so an IME candidate window appears there. */
  const cap = doc.createElement('textarea');
  cap.className = 'mdr-preview__edit-capture';
  cap.setAttribute('data-mdr-ui', '');
  cap.setAttribute('aria-hidden', 'true');
  cap.setAttribute('tabindex', '-1');
  cap.setAttribute('autocomplete', 'off');
  cap.setAttribute('spellcheck', 'false');
  cap.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1em;padding:0;border:0;margin:0;opacity:0;'
    + 'resize:none;overflow:hidden;pointer-events:none;outline:none;background:transparent;color:transparent;z-index:-1;';
  let capComposing = false;
  let capInDom = false;

  const version = (): number => host.structureVersion?.() ?? -1;
  /** At a session start: the structure shows at least the version our last change produced (writes of a
   *  previous session may still be on their way when the next block is clicked). */
  function rebase(): void {
    baseVersion = Math.max(version(), baseVersion + changes);
    changes = 0;
  }
  /** P-B (amended): the source has a document version, and the host compares its structure with it (createPreview). */
  const versioned = (): boolean => !!src?.version && !!host.describesSource && !!host.currentWrapper;
  /** The source document's version now: the source's own; without one (unit-test fakes), the version our last
   *  change produced, counted (baseVersion + changes). */
  const sourceVersion = (): number => (versioned() ? src!.version!() : baseVersion + changes);
  /** P-B: the preview's structure describes the current source — decided by document versions, never by elapsed
   *  time (host.describesSource: the structure's version is at least the source's, so a change typed in the editor
   *  pane counts too, and a write the source refused changes no version, so nothing waits for it). A host without a
   *  versioned source: every write of ours has reached the structure. */
  const caughtUp = (): boolean => (versioned() ? host.describesSource!() : version() >= baseVersion + changes);
  /** P-B — the freshness test of every session start and resume (a click, a waiting click, the history resume, the
   *  resume after a split, a merge, a paste or text typed into an emptied element, the start on the block before an
   *  emptied element, a task checkbox replayed later): the wrapper of block `info` shows the block's CURRENT source.
   *  THE definition is the host's (createPreview: host.currentWrapper — the structure describes the current source,
   *  so `info`, a block of that structure, has the line range the block has in the source now, and the HTML mounted
   *  in the wrapper was rendered from those lines: mounted, not stale, not lost, connected, not pending). Whatever
   *  the identity rule did with ids. A host without a versioned source (unit-test fakes): the same test with the
   *  counted writes. null: not (yet): the caller waits, keys queued. */
  function currentWrapper(info: BlockInfo | null): HTMLElement | null {
    if (!info) return null;
    if (versioned()) return host.currentWrapper!(info.id);
    if (!caughtUp() || !host.isFresh(info.id)) return null;
    const w = host.elementOfBlock(info.id);
    return w && w.isConnected && !w.classList.contains('is-pending') ? w : null;
  }
  /** G16: a modal question of the app is up — never take the focus from it. (The preview's own content
   *  does not count: a document may carry the attribute.) */
  const modalOpen = (): boolean => Array.from(doc.querySelectorAll('[aria-modal="true"]')).some((e) => !root.contains(e));

  /** P-F amended: the user turned elsewhere since the gesture a wait continues — set by a pointer press outside the
   *  block it waits for and by the focus arriving in any other element (onAwayPress / onAwayFocus); reset when a new
   *  wait starts. */
  let turnedAway = false;
  /** P-F amended — THE test of whether a wait is still wanted, asked by every wait before it starts a session or
   *  applies anything: the click resume, the history / split / merge / paste / reinsert / lost resumes and
   *  leaveGone's pending start (tryResume, which tryClick runs under), and the waiting task-checkbox click
   *  (replayToggle). A wait is abandoned the moment the user turns elsewhere: a pointer press outside the block it
   *  waits for, the focus arriving in the editor pane or any other control, a modal question, a document
   *  replacement (doc:loaded abandons at once), editing switched off. A focus that arrived in any element but the one
   *  holding it for the wait (the capture element; the clicked checkbox) has set `turnedAway`; and the focus is never
   *  outside the preview — a session start never moves the focus away from an element the user focused after the
   *  gesture that asked for it. */
  function waitWanted(): boolean {
    if (disposed || turnedAway || modalOpen()) return false;
    const a = doc.activeElement;
    return !a || a === doc.body || a === doc.documentElement || root.contains(a);
  }
  /** P-G — the one place where input queued for a waiting click or resume is discarded: one toast when it held
   *  anything that would have changed the text (or an IME composition still open in the capture element). */
  function dropQueued(): void {
    const lost = ops.some(changesText) || (capComposing && cap.value !== '');
    ops = [];
    if (lost) bus.emit('toast', { text: INPUT_DROPPED_TEXT, timeoutMs: 4000 });
  }

  /** The host's release of block `id`, now — or, while the button is down (U7) or a resume continues the
   *  text of an emptied wrapper (U9), once that is over. */
  function release(id: number, forResume = false): void {
    if (!forResume && !pointerDown) {
      if (deferred && deferred.id === id) deferred = null;
      hostRelease(id);
      return;
    }
    if (deferred && deferred.id !== id) releaseDeferred(true);
    deferred = { id, forResume: forResume || (deferred?.forResume ?? false) };
  }
  /** Performs a deferred release (`force`: a new session needs the host's hold, or the module goes away). */
  function releaseDeferred(force = false): void {
    const d = deferred;
    if (!d || (!force && (pointerDown || (d.forResume && resume !== null)))) return;
    deferred = null;
    hostRelease(d.id);
  }

  /** U20: the selection's end points inside a block whose session ended, as visible-text offsets: the block's
   *  re-render (which follows host.release) collapses them onto the wrapper's start; afterMount puts them back. */
  /** P-E: each end point inside the block both as a KeptPoint (its line box and the units before it there: exact at a
   *  line, item, quote line or cell boundary, and across text the write changed) and as a visible-text offset (used
   *  only when the re-render has other line boxes). */
  let keptSel: { id: number; anchor: number | null; focus: number | null; ka: KeptPoint | null; kf: KeptPoint | null; probe: [Range, Range] } | null = null;
  function hostRelease(id: number): void {
    keptSel = null;
    const w = host.elementOfBlock(id);
    const sel = doc.getSelection();
    if (w && sel && sel.rangeCount > 0 && sel.anchorNode && sel.focusNode) {
      const inA = w.contains(sel.anchorNode), inF = w.contains(sel.focusNode);
      const anchor = inA ? textOffsetOf(w, sel.anchorNode, sel.anchorOffset) : null;
      const focus = inF ? textOffsetOf(w, sel.focusNode, sel.focusOffset) : null;
      const ka = inA ? keepPoint(w, sel.anchorNode, sel.anchorOffset) : null;
      const kf = inF ? keepPoint(w, sel.focusNode, sel.focusOffset) : null;
      // live ranges at the two end points: DOM changes move them exactly as they move the selection's, so the
      // selection equals them later only when nothing else (the user, ⌘A again) has set it since
      const at = (n: Node, o: number): Range => { const r = doc.createRange(); r.setStart(n, o); r.collapse(true); return r; };
      if (anchor !== null || focus !== null) keptSel = { id, anchor, focus, ka, kf, probe: [at(sel.anchorNode, sel.anchorOffset), at(sel.focusNode, sel.focusOffset)] };
    }
    host.release(id);
  }
  /** U20 / P-E — THE restore of a released block's selection end points: block `id` mounted its re-render, and the end
   *  points kept for it go back to the same line box and the same units in it (pointOfKept; the text offset only when
   *  the line boxes differ), so that what is copied afterwards is what 0.1.1 copies for the same gesture — unless the
   *  selection was set meanwhile (a new press, ⌘A again, a session, a resume). */
  function restoreKept(id: number): void {
    const k = keptSel;
    if (!k || k.id !== id) return;
    keptSel = null;
    const w = host.elementOfBlock(id);
    const sel = doc.getSelection();
    if (!w || !sel || s || resume || pointerDown || sel.rangeCount === 0) return;
    const [pa, pf] = k.probe;
    if (sel.anchorNode !== pa.startContainer || sel.anchorOffset !== pa.startOffset
      || sel.focusNode !== pf.startContainer || sel.focusOffset !== pf.startOffset) return;
    const back = (kp: KeptPoint | null, off: number | null, probe: Range): [Node, number] =>
      (kp ? pointOfKept(w, kp) : null) ?? (off !== null ? pointAtOffset(w, off) : [probe.startContainer, probe.startOffset]);
    const a = back(k.ka, k.anchor, pa);
    const f = back(k.kf, k.focus, pf);
    try { sel.setBaseAndExtent(a[0], a[1], f[0], f[1]); } catch { /* a node left meanwhile */ }
  }

  function exec(cmd: string, value?: string): boolean {
    try { return doc.execCommand(cmd, false, value); } catch { return false; }
  }

  function refuse(id: number): void {
    const now = performance.now();
    const last = refusedAt.get(id);
    if (last !== undefined && now - last < REFUSE_TOAST_MS) return;
    refusedAt.set(id, now);
    bus.emit('toast', { text: NOT_EDITABLE_TEXT, timeoutMs: 2000 });
  }

  /** `source.replace`, counting the document versions it creates (an identical text writes nothing) — THE place every
   *  write of a session into the source passes (the commit, a deletion, a reinsertion, a split, a merge, a paste: history
   *  steps go through `source.history`, which only restores texts the document had). THE GUARD: a write that would hold a
   *  character that is not plainly visible more often than the replaced text plus what the user put in (userPut) is not
   *  made: WriteRefused (the callers' refusal). */
  function replaceSource(start: Line, count: number, text: string): void {
    const old = src!.read(start, count);
    const add = writeAdds(old, text);
    if (add) {
      for (const [c, k] of add) if (k > (userPut.get(c) ?? 0)) { guardFired(c, 'write'); throw new WriteRefused(); }
      for (const [c, k] of add) userPut.set(c, userPut.get(c)! - k);   // (spent: from now on the replaced text holds it)
    }
    if (old !== text) changes++;
    src!.replace(start, count, text);
  }

  /** THE GUARD's "what the user put in during this session": every character it counts of the text the session received
   *  from the user — typed (beforeinput), composed (compositionend), pasted (pasteText), replayed after a resume (applyOp),
   *  the URL given to ⌘K (closeLinkUi). A typed space counts as a U+00A0 as well (the browser shows typed spaces as
   *  such where they would collapse). A write that adds such characters spends as many (the source holds them then, so
   *  every later write replaces text that holds them). It lasts as long as the user's session, across its resumes (a
   *  split, a merge, a paste, a history step); end() forgets it. */
  const userPut = new Map<string, number>();
  /** B2: the same input, never spent (the Markdown of the session's block is checked whole at every write). */
  const userAll = new Map<string, number>();
  function noteUser(t: string | null | undefined): void {
    if (!t) return;
    for (const c of t) {
      const k = c === ' ' ? NBSP : c;
      if (k === NBSP || guarded(c)) {
        userPut.set(k, (userPut.get(k) ?? 0) + 1);
        userAll.set(k, (userAll.get(k) ?? 0) + 1);
      }
    }
  }
  /** The serializer's Markdown of the session's block for a write (commit, a merge), past B2 (blockReveals: a HIDDEN
   *  character raw beyond the source's raw ones inside code and the user's input throws WriteRefused, the callers'
   *  refusal: nothing is written). */
  function blockText(cur: Session): string {
    const text = serializeBlock(cur.el, cur.kind, { ...cur.hints, editing: true });
    const c = blockReveals(text, cur.hints, userAll);
    if (c !== null) { guardFired(c, 'write'); throw new WriteRefused(); }
    return text;
  }

  // ---------------------------------------------------------------- session start / end
  /** `quiet` (U18): a refusal shows no toast (the session was not asked for by a click). */
  function begin(w: HTMLElement, info: BlockInfo, quiet = false): boolean {
    if (!src || !editable || disposed) return false;
    // Only a block showing the current source: a stale DOM (its new HTML is still on the way) would write
    // old text back over the newer source. (P-B: the callers wait for this test before they call begin.)
    if (currentWrapper(info) !== w) return false;
    if (!EDITABLE_KINDS.has(info.kind)) { if (!quiet) refuse(info.id); return false; }
    const text = src.read(info.startLine, info.lineCount);
    const { content, lines, leading, trailing } = contentOf(text);
    const t = startTest(w, info.kind, content, lines);
    if (!t) { if (!quiet) refuse(info.id); return false; }
    const { hints, baseline } = t;
    s = {
      id: info.id, el: w, kind: info.kind, startLine: info.startLine, lineCount: info.lineCount,
      trailing, leading, baseline, lastWritten: null, hints, composing: false, gone: false, prevId: -1, goneVersion: -1,
      placeLines: -1, placeAbove: '', goneKeep: 0, caretOffset: 0, openCode: null, spacers: [], ownZw: zwCount(w),
    };
    // U21: a formula that starts a line gets a zero-width space before it — the browser has no caret position
    // there otherwise (⌘←, Home and a click at the line start would land after it); the serializer drops it
    ensureSpacers(s);
    rebase();
    releaseDeferred(true);                       // the host holds one block: the previous one is released first
    keptSel = null;                              // (U20) the selection is the new session's
    host.hold(info.id);
    w.setAttribute('contenteditable', 'true');
    w.setAttribute('spellcheck', 'false');
    w.classList.add('is-editing');
    hint.hidden = false;
    exec('defaultParagraphSeparator', 'p');
    bus.emit('previewEdit:session', { id: info.id });
    return true;
  }

  /** THE test of a session start (begin) on the wrapper `w` that shows block content `content`; P1 of round 7 (CONTRACT
   *  §11, Round-7 decisions): also the test of the block a merge would continue in (mergeContinues). The size limit and
   *  unsupportedReason; then `w` is prepared as a session needs it (the document's own styled elements marked, formulas
   *  frozen, the atoms stamped) and the baseline is serialized (H15: a NoMarkersError is a refusal); the fidelity gate (U12)
   *  and startAllowed. Null = refused (the preparation undone); else the session's hints and baseline (`w` stays prepared). */
  function startTest(w: HTMLElement, kind: BlockKind, content: string, lines: string[]): { hints: SerializeHints; baseline: string } | null {
    if (content.length > MAX_EDIT_CHARS || unsupportedReason(w, content) !== null) return null;
    // Elements present now are the document's own (`<span class>` from the source, KaTeX, an inline
    // `style` written in the source); the ones the browser invents while typing are unwrapped by the
    // serializer, and a `style` it bakes onto an element it creates is dropped.
    const marked: Element[] = [];
    for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) {
      if (!e.hasAttribute('data-mdr-o')) marked.push(e);
      e.setAttribute('data-mdr-o', '');
    }
    const frozen: Array<[HTMLElement, string | null]> = [];
    for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) {
      frozen.push([m, m.getAttribute('contenteditable')]);
      m.setAttribute('contenteditable', 'false');
    }
    // P-G (a): every atom carries what the serializer needs as an attribute of its own element, taken from this intact
    // rendering (Chromium's own merges re-create the nodes they move; attributes survive that, KaTeX's annotation and
    // live properties do not). The serializer reads the stamps first (`stamped`).
    stampAtoms(w);
    const hints: SerializeHints = { ...(styleHintsOf ? styleHintsOf(content) : {}), fence: codeHints(kind, lines), stamped: true };
    let baseline: string | null = null;
    try { baseline = serializeBlock(w, kind, { ...hints, editing: true }); } catch (err) { if (!(err instanceof NoMarkersError)) throw err; }
    // U12: what the serializer writes for the untouched block must render as the block shows; otherwise the
    // block is refused before anything can be written (a serializer defect becomes a refusal, never a change).
    // H15: so is a block that leaves no free marker set (unsupportedReason says 'markers' first; this is the net).
    if (baseline === null || !baselineFaithful(w, kind, baseline) || !startAllowed(w, kind, hints, content, baseline)) {
      for (const e of marked) e.removeAttribute('data-mdr-o');
      for (const [m, was] of frozen) { if (was === null) m.removeAttribute('contenteditable'); else m.setAttribute('contenteditable', was); }
      clearStamps(w);
      return null;
    }
    return { hints, baseline };
  }

  /** P1 (round 7, CONTRACT §11 Round-7 decisions): would a session start on the block a Backspace merge continues in —
   *  the merged source `merged` (content, no blank lines around it)? The block as the gate renders that source
   *  (fidelity.ts blockRendering: sanitized as a mounted block is; formulas with their TeX, as a fresh KaTeX rendering has
   *  it), tested by THE start test (startTest). Rendered there without the document's reference definitions, so the
   *  previous block's mounted wrapper `pw` (when current) adds rule T's test of links and images without a URL
   *  (urlsKept: a definition elsewhere whose URL the sanitizer took shows only in the mounted rendering). */
  function mergeContinues(merged: string, prevContent: string, pw: HTMLElement | null): boolean {
    const lines = merged.split('\n');
    const segs = segmentAll(lines);
    if (segs.length !== 1 || !EDITABLE_KINDS.has(segs[0].kind)) return false;
    if (pw && !urlsKept(prevContent, pw)) return false;
    const w = blockRendering(merged);
    return w !== null && startTest(w, segs[0].kind, merged, lines) !== null;
  }

  /** Round 6, at a session start (begin), after the gate passed the baseline: S4 — a block whose baseline written as
   *  before rule S (its HIDDEN characters raw) the gate refuses stays refused, so rule S makes no block editable that was
   *  not; THE GUARD — a block whose untouched serialization already holds a character it counts more often than the
   *  source does is refused now (every write of it would be refused, the user's typing lost). */
  function startAllowed(w: HTMLElement, kind: BlockKind, hints: SerializeHints, content: string, baseline: string): boolean {
    // RULE T (Checkpoint H): a block whose raw HTML the sanitizer changed is not edited (the session would write the
    // sanitized DOM back: what the sanitizer took would leave the source). A block with raw HTML, and a Markdown-only
    // block whose rendering has attribute values taken from its text (links, images, a fence's language): the sanitizer
    // also trims or removes a title, an alt or a URL there. A mounted link or image without its URL that the source's
    // rendering does not have is the sanitizer's work too (it took a destination with a scheme it does not allow from a
    // reference definition elsewhere: markdown-it writes a URL on every link and image).
    if ((content.includes('<') || w.querySelector('a, img, code[class]') !== null) && !sanitizerKept(content, w)) return false;
    if (hints.hidden) {
      let before: string | null = null;
      try { before = serializeBlock(w, kind, { ...hints, hidden: undefined, editing: true }); } catch (err) { if (!(err instanceof NoMarkersError)) throw err; }
      if (before === null || !baselineFaithful(w, kind, before)) return false;
    }
    const c = writeReveals(content, baseline) ?? blockReveals(baseline, hints);   // (B2 at the start as well)
    if (c !== null) { guardFired(c, 'start'); return false; }
    return true;
  }

  /** Writes the DOM's serialization if it changed. Returns the resume target when the write split the block. */
  function commit(): Resume | null {
    if (!s || !src) return null;
    settleClipboard();                           // (P-G: the stamps a copy or cut took off are back before a serialization)
    if (!retrack()) return null;
    const cur = s;
    dropForeignBoxes(cur);
    try {
      const text = blockText(cur);                // (B2: refused as a NoMarkersError below)
      if (cur.gone) return text.trim() === '' ? null : reinsert(cur, text);
      if (text === cur.baseline) return null;
      if (text.trim() === '') { deleteBlock(cur); return null; }
      return write(text);
    } catch (err) {
      // (H15: thrown before anything is written — the caret line of a split is serialized before the write too)
      if (!(err instanceof NoMarkersError)) throw err;
      refuseMarkers(cur);
      return null;
    }
  }

  /** P-G (d): a checkbox in a list item that is not the item's own (ownTaskBox: the browser's join of two items moved
   *  the second one's box in) is dropped by the serializer and never sets the item's marker; it leaves the session's
   *  DOM as well, so the screen shows what is written (the text after it keeps its space). */
  function dropForeignBoxes(cur: Session): void {
    for (const b of Array.from(cur.el.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]'))) if (!ownTaskBox(b)) b.remove();
  }

  /** H15: the block's DOM leaves no free marker set (the serializer's NoMarkersError: a pasted private-use glyph
   *  table): nothing is written, the session ends — the block re-renders from its unchanged source — and the user
   *  is told to edit it in the source. */
  function refuseMarkers(cur: Session): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    ops = [];
    if (s === cur) teardown(cur);
    refuse(cur.id);
  }

  /** U9: the emptied block leaves the source now — its lines and its own trailing blank lines, so no extra
   *  blank line stays behind (the line before it is rewritten as it is, or the line after it when it is the
   *  first block). The session stays on the emptied wrapper, which the host keeps in place. U14: blank lines
   *  before the block's content stay; the last of them is the line rewritten as it is.
   *  U18 (b): the neighbours never join — when the line before the deleted range and the line after it are both
   *  non-blank (a block directly under a paragraph line), one blank line stays between them — and the document
   *  keeps its final newline (a deleted last block took it with its trailing blank line). */
  function deleteBlock(cur: Session): void {
    const lead = cur.leading.length;
    const start = cur.startLine + lead, count = cur.lineCount - lead;
    const prev = cur.startLine > 1 ? host.blockAtLine(cur.startLine - 1) : null;
    const nextLine = src!.read(start + count, 1);
    // Session state first: the structure may follow synchronously inside replace.
    cur.gone = true;
    cur.prevId = prev ? prev.id : -1;
    cur.baseline = '';
    cur.lastWritten = null;
    // (H20) the version the deletion produces: a structure older than it still has the block
    cur.goneVersion = sourceVersion() + 1;
    // P-C: the place (where a block typed into the emptied element goes) is a line of the source from now on; its
    // context is taken once the deletion is in the source (a structure may follow inside replace)
    cur.placeLines = -1;
    cur.goneKeep = 0;
    if (start > 1) {
      const above = src!.read(start - 1, 1);
      const keep = lead === 0 && (lineExists(start + count)
        ? above.trim() !== '' && nextLine.trim() !== ''
        : above !== '' && src!.read(start + count - 1, 1) === '');
      cur.startLine = start + (keep ? 1 : 0);
      cur.goneKeep = keep ? 1 : 0;
      replaceSource(start - 1, count + 1, keep ? above + '\n' : above);
    } else if (nextLine !== '') replaceSource(1, count + 1, nextLine);
    else replaceSource(1, count, '');
    if (s === cur && cur.gone) snapshotPlace(cur);
  }

  /** P-C: how many lines the source has. */
  function sourceLines(): number {
    let lo = 1;
    while (lineExists(lo * 2)) lo *= 2;
    let hi = lo * 2;                             // lineExists(lo), !lineExists(hi)
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lineExists(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }
  /** P-C: the lines right above line `place` (at most PLACE_LINES of them). */
  function placeContext(place: Line): string {
    if (place <= 1) return '';
    const from = Math.max(1, place - PLACE_LINES);
    return src!.read(from, place - from);
  }
  function snapshotPlace(cur: Session): void {
    cur.placeLines = sourceLines();
    cur.placeAbove = placeContext(cur.startLine);
  }
  /** P-C — THE place of an emptied element, kept current through every later change of the source (the editor
   *  pane's included), by the source itself, never by a neighbouring block (which can absorb the block below once
   *  the emptied one is gone, or be split by the editor): when the lines right above the place are no longer the
   *  ones it had there, the source changed above it and the place moves by the change of the document's line
   *  count; otherwise the change (if any) was at or below it and the place stays. */
  function trackPlace(cur: Session): void {
    if (cur.placeLines < 0) { snapshotPlace(cur); return; }
    const n = sourceLines();
    const above = placeContext(cur.startLine);
    if (n === cur.placeLines && above === cur.placeAbove) return;
    if (above !== cur.placeAbove) cur.startLine = Math.max(1, Math.min(n + 1, cur.startLine + n - cur.placeLines));
    snapshotPlace(cur);
  }

  /** Line `n` exists in the source (`read` clamps to the document: a blank last line and a line past the end
   *  both read as ''). */
  function lineExists(n: Line): boolean {
    return n <= 1 || src!.read(n - 1, 2).length > src!.read(n - 1, 1).length;
  }

  /** U9: text typed into an emptied wrapper is written as a new block where the deleted one stood (right
   *  after the block before it, or at line 1), and the session continues on it through the ordinary resume. */
  function reinsert(cur: Session, text: string): Resume | null {
    const L = cur.startLine;
    // U14: the blank lines the emptied first block left at the start of the document (retrack put L after
    // them) stay before the new block; segmented with them, as the worker will.
    const lead = cur.prevId < 0 ? Math.min(cur.leading.length, L - 1) : 0;
    const leading = cur.leading.slice(0, lead);
    // A block starts with a non-blank line: an empty line L is past the end of the document.
    const atL = src!.read(L, 1);
    const append = atL === '';
    // Keep the new block apart from its neighbours: a blank line below it when it had none of its own, and one
    // above it when the line above is not blank (a paragraph would continue the one above).
    if (!append && cur.trailing.length === 0) cur.trailing = [''];
    const above = L > 1 ? src!.read(L - 1, 1) : '';
    const sep = L > 1 && above.trim() !== '';
    const body = text + (cur.trailing.length > 0 ? '\n' + cur.trailing.join('\n') : '');
    const startLine = L + (sep ? 1 : 0);
    const segs = segmentAll(leading.concat(text.split('\n')));
    // `gone` stays set: the wrapper is still no block's (the caller ends the session and resumes on the new one).
    cur.startLine = startLine - lead;
    cur.leading = leading;
    cur.baseline = text;
    let target: Resume;
    if (segs.length > 1) target = splitTarget(cur, text, segs);
    else {
      const sel = doc.getSelection();
      const node = sel && sel.rangeCount > 0 ? sel.focusNode : null;
      const offset = node && cur.el.contains(node) ? textOffsetOf(cur.el, node, sel!.focusOffset) : visibleLength(cur.el);
      target = resumeAt(cur.startLine, null, offset, text);
    }
    cur.lineCount = lead + body.split('\n').length;
    if (append) {
      if (L > 1) replaceSource(L - 1, 1, above + '\n' + (sep ? '\n' : '') + body);
      else replaceSource(1, 1, body);
    } else {
      replaceSource(L, 1, (sep ? '\n' : '') + body + '\n' + atL);
    }
    return target;
  }

  function write(text: string): Resume | null {
    const cur = s!;
    const full = framed(cur.leading, text, cur.trailing);
    const segs = text === '' ? [] : segmentAll(cur.leading.concat(text.split('\n')));
    const start = cur.startLine, count = cur.lineCount;
    // U18: a block directly under a non-blank line (a heading, a list) whose first line now would continue the
    // block above (its heading went, its first item became a paragraph) is kept apart by one blank line, which
    // goes before the block (the block above gets it as its trailing blank line).
    const sep = text !== '' && joinsAbove(cur, text.split('\n'));
    if (sep) cur.startLine = start + 1;
    let target: Resume | null = null;
    if (segs.length > 1) target = splitTarget(cur, text, segs);
    // Session state first: the source may apply (and the structure follow) synchronously inside replace.
    cur.lineCount = full.split('\n').length;
    cur.lastWritten = full;
    cur.baseline = text;
    replaceSource(start, count, (sep ? '\n' : '') + full);
    return target;
  }

  /** U18: would `lines`, written at the session block's place, continue the block right above it? Only a block
   *  directly under a non-blank line can (the segmenter starts a block there for a heading or a list). */
  function joinsAbove(cur: Session, lines: string[]): boolean {
    if (cur.leading.length > 0 || cur.startLine <= 1) return false;
    const above = src!.read(cur.startLine - 1, 1);
    if (above.trim() === '') return false;
    // judged with the whole block above (a line out of its context can look like the start of a fence)
    const prev = host.blockAtLine(cur.startLine - 1);
    const ctx = prev && prev.startLine + prev.lineCount === cur.startLine ? src!.read(prev.startLine, prev.lineCount).split('\n') : [above];
    return !segmentAll(ctx.concat(lines)).some((sg) => sg.start === ctx.length);
  }

  function resumeAt(startLine: Line, lineCount: number | null, offset: number, expected: string | null): Resume {
    return { startLine, contains: false, lineCount, offset, pos: null, until: performance.now() + RESUME_MS, expected, minVersion: null, matchSource: false };
  }

  /** Where the caret lands after a write that split the block: the new block that contains its line. */
  function splitTarget(cur: Session, text: string, segs: Array<{ start: number; count: number }>): Resume {
    const sel = doc.getSelection();
    let relLine = 0;
    let offset = 0;
    let prefix = '';
    let node: Node | null = sel && sel.rangeCount > 0 ? sel.focusNode : null;
    let focusOffset = sel ? sel.focusOffset : 0;
    let para: Op | null = null;
    let beforeAtom = false;
    if (node && cur.el.contains(node)) {
      let top: Node = node;
      while (top.parentNode && top.parentNode !== cur.el) top = top.parentNode;
      // G11: the caret sits in an empty paragraph, which has no source of its own: the session resumes next to
      // the neighbouring element that has some (the one before it, else the one after it) and recreates the
      // empty paragraph there first, so what is typed next goes where the caret was.
      if (emptyParagraph(top)) {
        let near: Node | null = null;
        for (let n = top.previousSibling; n && !near; n = n.previousSibling) if (hasContent(n)) near = n;
        const before = near === null;
        for (let n = top.nextSibling; n && !near; n = n.nextSibling) if (hasContent(n)) near = n;
        if (near) {
          const texts = near.nodeType === 1 ? visibleTexts(near as Element) : [];
          const edge = before ? texts[0] : texts[texts.length - 1];
          if (near.nodeType === 3) { node = near; focusOffset = before ? 0 : (near as Text).data.length; }
          else if (edge) { node = edge; focusOffset = before ? 0 : edge.data.length; }
          else { node = near; focusOffset = 0; }
          top = near;
          para = { t: 'para', before };
        }
      }
      const marked = serializeBlockWithCaret(cur.el, cur.kind, node, focusOffset, { ...cur.hints, editing: true });
      const at = marked ? marked.indexOf(CARET_MARK) : -1;
      if (at >= 0) relLine = marked!.slice(0, at).split('\n').length - 1;
      // the offset inside the caret's top-level element (the new block starts with that element)
      offset = top.nodeType === 1 ? textOffsetOf(top as Element, node, focusOffset) : focusOffset;
      const all = para ? '' : top.textContent ?? '';
      if (/[ \u00a0]$/.test(all.slice(0, offset)) && all.slice(offset).trim() === '') prefix = ' ';
      // U19: plain whitespace a paragraph starts with (a pasted last paragraph of spaces before the rest of the
      // caret's paragraph) is neither shown nor written: in the new block the caret's text starts after it
      const ws = top.nodeType === 1 && /^(P|H[1-6])$/.test((top as Element).tagName) ? /^[ \t\n]*/.exec(all)![0].length : 0;
      if (ws > 0 && all.slice(ws).trim() !== '') offset = Math.max(0, offset - ws);
      // U21: directly before an image / formula / checkbox: the offset alone would resume after it
      if (!para) {
        const r = doc.createRange();
        r.setStart(node, focusOffset);
        beforeAtom = atomAfter(r, cur.el) !== null;
      }
    }
    const lastLine = text.split('\n').length - 1;
    // U14: `segs` are segments of the leading blank lines + `text` (the lines the write puts at cur.startLine).
    relLine = Math.min(relLine, lastLine) + cur.leading.length;
    let seg = segs[segs.length - 1];
    for (const sg of segs) if (relLine >= sg.start && relLine < sg.start + sg.count) { seg = sg; break; }
    const isLast = seg === segs[segs.length - 1];
    const segLines = cur.leading.concat(text.split('\n')).slice(seg.start, seg.start + seg.count);
    while (segLines.length > 0 && segLines[segLines.length - 1].trim() === '') segLines.pop();
    while (segLines.length > 0 && segLines[0].trim() === '') segLines.shift();   // (blank lines show nothing)
    // Typed before the split but not in the source (a trailing space is dropped at a line end): replayed first.
    if (prefix) ops.unshift({ t: 'text', data: prefix });
    if (para) ops.unshift(para);
    const target = resumeAt(cur.startLine + seg.start, seg.count + (isLast ? cur.trailing.length : 0), offset, segLines.join('\n'));
    if (beforeAtom) target.beforeAtom = true;
    return target;
  }

  /** Re-reads the session block's position; false (and the session ended) when it is gone. */
  function retrack(): boolean {
    const cur = s;
    if (!cur) return false;
    if (cur.gone) {
      // U9: no block owns the emptied wrapper; it lives while it is in the document.
      if (!cur.el.isConnected) { teardown(cur); return false; }
      // P-C: the place is a line of the source, kept current by the source's own changes — not derived from the
      // block before it (once the emptied block is gone, that block can include the block below: two lists of
      // the same type, two indented code blocks)
      if (cur.prevId >= 0) trackPlace(cur);
      else {
        // U14: after the blank lines it left at the start of the document, while they are still there
        if (cur.leading.length > 0 && src!.read(1, cur.leading.length) !== cur.leading.join('\n')) cur.leading = [];
        cur.startLine = 1 + cur.leading.length;
      }
      return true;
    }
    const info = host.blockInfo(cur.id);
    if (!info || host.elementOfBlock(cur.id) !== cur.el || !cur.el.isConnected) {
      lost(cur);
      return false;
    }
    // Our own write may not have reached the structure yet: the lines we wrote are still ours — where we wrote
    // them (U18: a write that put a blank line before the block moved its start).
    const ours = cur.lastWritten !== null && !caughtUp() && src!.read(cur.startLine, cur.lineCount) === cur.lastWritten;
    if (!ours) cur.startLine = info.startLine;
    if (cur.lastWritten === null || src!.read(cur.startLine, cur.lineCount) !== cur.lastWritten) {
      cur.lineCount = info.lineCount;
      cur.lastWritten = null;
      // U14: the leading blank lines as the source has them now (only a block starting with a blank line has any)
      cur.leading = src!.read(info.startLine, 1).trim() === '' ? contentOf(src!.read(info.startLine, info.lineCount)).leading : [];
    }
    return true;
  }

  /** The session's wrapper was replaced (the identity rule can hand the block a new id) or its block
   *  vanished: resume on the block at its line — but only one that shows exactly the text last written. */
  function lost(cur: Session): void {
    teardown(cur);
    if (!ending && host.blockAtLine(cur.startLine) !== null) {
      startResume(resumeAt(cur.startLine, null, cur.caretOffset, cur.baseline), cur.el);
    }
  }

  /** P-A (c) — THE removal of the session's helper characters, at the end of a session by any path (teardown: Esc, a
   *  press elsewhere, a drag out, a split / merge / history step, a lost block, a refused block, a document replaced,
   *  an exception in end()): every registered one, and — in a block whose own content had none (ownZw 0) — every
   *  zero-width character left in the wrapper (a helper the browser moved into another text node). Character by
   *  character (deleteData), so a selection's end points around them stay where they are. */
  function scrubHelpers(cur: Session): void {
    const nodes = new Set<Text>(cur.spacers.filter((t) => t.isConnected));
    if (cur.ownZw === 0 && cur.el.isConnected) for (const t of zwTexts(cur.el)) nodes.add(t);
    for (const t of nodes) {
      for (let i = t.data.length - 1; i >= 0; i--) { const c = t.data.charCodeAt(i); if (c === 0x200b || c === 0xfeff) t.deleteData(i, 1); }
      if (t.data === '') t.remove();
    }
    cur.spacers = [];
  }
  /** P-A (d): `range` holds a helper character of session `cur` (in a block whose own content had zero-width characters:
   *  one of a registered helper node). */
  function helperIn(cur: Session, range: Range): boolean {
    const nodes = cur.ownZw === 0 ? zwTexts(cur.el) : cur.spacers.filter((t) => t.isConnected && ZW_ONE.test(t.data));
    for (const t of nodes) {
      if (!range.intersectsNode(t)) continue;
      const a = t === range.startContainer ? range.startOffset : 0;
      const b = t === range.endContainer ? range.endOffset : t.data.length;
      if (ZW_ONE.test(t.data.slice(a, b))) return true;
    }
    return false;
  }
  /** P-A (d): the helper characters a copy or cut took out of the selection for the browser's own serialization (so the
   *  clipboard holds exactly what the browser writes for the same text without them), put back right after it — by a
   *  timer, or before any other input reaches the page, whichever comes first (settleClipboard). */
  let helpersOut: {
    cur: Session; removed: Array<[Text, number, string]>; sel: [Node, number, Node, number] | null; cut: boolean;
    /** P-G: the stamps taken off for the browser's copy (element, attribute, value); `helpers`: helper characters were. */
    stamps: Array<[Element, string, string]>; helpers: boolean;
  } | null = null;
  let helpersTimer = 0;
  /** P-A (d) — a copy or cut (the keyboard, the context menu, the edit menu's 拷贝 / 剪切) whose selection holds a helper
   *  character of the live session: those characters leave the DOM while the browser copies (and, for a cut, deletes)
   *  the selection with its own serialization, and come back right after (a cut deleted them with the selection; the
   *  U21 spacers a formula that now starts a line needs are made again). A drag of selected text: the browser's drag
   *  data without them. Any other copy, cut or drag is left to the browser untouched: the clipboard is what 0.1.1 puts
   *  there. */
  function onClipboard(e: ClipboardEvent | DragEvent): void {
    settleClipboard();
    const cur = s;
    const sel = doc.getSelection();
    if (!cur || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(cur.el)) return;
    // P-G: the session's stamps stay off the clipboard as its helper characters do: taken off the elements the
    // selection touches while the browser copies (and, for a cut, deletes) it, put back right after. For a cut only
    // from the elements it deletes whole: one it cuts into can be re-created by the join that follows and would come
    // back without its stamp.
    const stamps: Array<[Element, string, string]> = [];
    const whole = (el: Element): boolean => {
      const r = doc.createRange();
      r.selectNode(el);
      return range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, r) >= 0;
    };
    for (const el of Array.from(cur.el.querySelectorAll(STAMP_SELECTOR))) {
      if (!range.intersectsNode(el) || (e.type === 'cut' && !whole(el))) continue;
      for (const a of STAMP_ATTRS) { const v = el.getAttribute(a); if (v !== null) stamps.push([el, a, v]); }
    }
    const helpers = helperIn(cur, range);
    if (!helpers && stamps.length === 0) return;
    if (e.type === 'dragstart') {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt) return;
      for (const ty of ['text/plain', 'text/html']) {
        let v = dt.getData(ty);
        if (!v) continue;
        if (helpers) v = v.replace(ZW_ALL, '');
        if (ty === 'text/html' && stamps.length > 0) v = v.replace(STAMP_ATTR_RE, '');
        dt.setData(ty, v);
      }
      return;
    }
    for (const [el, a] of stamps) el.removeAttribute(a);
    const nodes = !helpers ? [] : cur.ownZw === 0 ? zwTexts(cur.el) : cur.spacers.filter((t) => t.isConnected && ZW_ONE.test(t.data));
    const saved: [Node, number, Node, number] | null = sel.anchorNode && sel.focusNode ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : null;
    const removed: Array<[Text, number, string]> = [];
    for (const t of nodes) {
      if (!range.intersectsNode(t)) continue;
      const a = t === range.startContainer ? range.startOffset : 0;
      const b = t === range.endContainer ? range.endOffset : t.data.length;
      for (let i = b - 1; i >= a; i--) {
        const c = t.data[i];
        if (c !== undefined && ZW_ONE.test(c)) { removed.push([t, i, c]); t.deleteData(i, 1); }
      }
    }
    helpersOut = { cur, removed, sel: saved, cut: e.type === 'cut', stamps, helpers };
    helpersTimer = win.setTimeout(settleClipboard, 0);
  }
  /** P-A (d): after the browser's copy / cut — the helpers back where they were and the selection as it was (copy), or
   *  the U21 spacers made again where a formula now starts a line (cut). */
  function settleClipboard(): void {
    const h = helpersOut;
    if (!h) return;
    helpersOut = null;
    if (helpersTimer) { clearTimeout(helpersTimer); helpersTimer = 0; }
    if (s !== h.cur) return;                     // the session ended meanwhile: its helpers are gone anyway
    for (const [el, a, v] of h.stamps) if (h.cur.el.contains(el)) el.setAttribute(a, v);   // (P-G)
    if (h.cut) { if (h.helpers) ensureSpacers(h.cur); return; }
    for (let k = h.removed.length - 1; k >= 0; k--) {
      const [t, i, c] = h.removed[k];
      if (t.isConnected) t.insertData(Math.min(i, t.data.length), c);
    }
    const sel = doc.getSelection();
    if (h.sel && sel) { try { sel.setBaseAndExtent(h.sel[0], h.sel[1], h.sel[2], h.sel[3]); } catch { /* a node left meanwhile */ } }
  }
  /** U21: a zero-width space before every inline formula that starts a line (begin; again after a cut). */
  function ensureSpacers(cur: Session): void {
    if (cur.kind === BlockKind.Math) return;
    for (const m of Array.from(cur.el.querySelectorAll('.md-math'))) {
      if (!m.classList.contains('md-math--block') && !m.closest('[data-mdr-ui]') && lineLeading(m, cur.el)) spacerBefore(m, cur);
    }
  }

  /** `resumes`: a resume continues the user's text right after this (an emptied wrapper then stays on screen
   *  until it has started, U9). */
  function teardown(cur: Session, resumes = false): void {
    if (s === cur) s = null;
    if (dragFrom === cur) dragFrom = null;
    pasteSplit = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    closeLinkUi(false);
    cur.el.removeAttribute('contenteditable');
    cur.el.removeAttribute('spellcheck');        // (P-A: nothing of the session stays on the wrapper — a copy across it)
    clearStamps(cur.el);                         // (P-G: the stamps never leave the session)
    cur.el.classList.remove('is-editing');
    hint.hidden = true;
    // P-A (U21): the session's helper characters go before the release (U20 counts the selection's offsets then)
    if (helpersOut?.cur === cur) { helpersOut = null; if (helpersTimer) { clearTimeout(helpersTimer); helpersTimer = 0; } }
    scrubHelpers(cur);
    release(cur.id, resumes && cur.gone);
    bus.emit('previewEdit:session', { id: null });
  }

  /**
   * Ends the session: whatever is pending (a frame-coalesced serialization, text typed during an IME
   * composition, an emptied block) is written through `source.replace` SYNCHRONOUSLY before this returns,
   * then `previewEdit:session {id:null}` is emitted. An explicit end never continues elsewhere: a split
   * written here does not resume on the new block, and a resume still waiting from an earlier split is
   * dropped (its capture element gives the focus back) — when end() returns no session is live and none
   * will start by itself (App relies on this for ⌘S, mode switches, opening files and closing the window).
   * The session is torn down even when the write throws (the error is reported, the block re-renders).
   */
  function end(): void {
    cancelResume();
    const cur = s;
    if (!cur) { userPut.clear(); userAll.clear(); return; }       // (the user's session is over: THE GUARD forgets its input)
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    cur.composing = false;
    ending = true;
    try {
      commit();
    } catch (err) {
      console.error('[mdr] previewEdit: writing the session at its end failed', err);
    } finally {
      ending = false;
      ops = [];
      userPut.clear();
      userAll.clear();
      if (s === cur) teardown(cur);              // (commit may have found the block gone and ended it)
    }
  }

  function flush(): void {
    raf = 0;
    const cur = s;
    if (!cur || cur.composing) return;
    const target = commit();
    const pasted = pasteSplit;
    pasteSplit = false;
    if (target && s === cur) {
      if (pasted) {
        target.minVersion = sourceVersion();
        target.reveal = { line: target.startLine, again: true, extended: 0 };
      }
      const el = cur.el;
      teardown(cur, true);
      startResume(target, el);
    }
  }

  function schedule(): void {
    if (!raf && s && !disposed) raf = requestAnimationFrame(flush);
  }

  // ---------------------------------------------------------------- resume after a split / merge / undo
  function startResume(r: Resume, from: HTMLElement | null): void {
    resume = r;
    // P-F amended: a new wait is wanted until the user turns elsewhere — unless the focus is outside the preview
    // already (the user clicked into another control before this frame's write): then it is not, and the capture
    // element does not take that focus (a press inside the preview ends every wait itself: onMouseDown)
    const a = doc.activeElement;
    turnedAway = !!a && a !== doc.body && a !== doc.documentElement && !root.contains(a);
    armResumeTimer();
    doc.addEventListener('keydown', onResumeKey, true);
    if (!turnedAway) holdFocus(from);
    tryResume();
  }

  /** Gives up a resume that never finds its block — but not while an IME composition is open in the
   *  capture element (its text would be lost): the wait restarts when the composition ends. */
  function armResumeTimer(): void {
    if (resumeTimer) clearTimeout(resumeTimer);
    const r0 = resume;
    resumeTimer = win.setTimeout(function expire() {
      resumeTimer = 0;
      const r = resume;
      if (capComposing && r) { resumeTimer = win.setTimeout(expire, RESUME_MS); return; }
      // G12: a history step whose block exists in a structure that shows the step, only not mounted yet
      // (it was scrolled to): keep the queued keys a while longer.
      if (r && r.reveal && r.reveal.extended < MOUNT_WAIT_EXTENSIONS && r.minVersion !== null && version() >= r.minVersion
        && (host.blockAtLine(r.startLine)?.lineCount ?? 0) >= 1) {   // (U22: an empty document has no block to mount)
        r.reveal.extended++;
        r.until = performance.now() + RESUME_MS;
        host.revealLine?.(r.reveal.line);
        resumeTimer = win.setTimeout(expire, RESUME_MS);
        return;
      }
      // P-F / P-B: a click (and the keys typed after it) on a block whose re-render is known to be on its way, and any
      // resume while the structure is known to be behind the source (P-B: by versions), waits for it within the same
      // bound; a click whose block went away or whose HTML nobody renders is given up
      if (r && (r.waits ?? 0) < MOUNT_WAIT_EXTENSIONS && (!r.click || host.blockInfo(r.click.id) !== null)
        && (!caughtUp() || (r.click && host.renderPending?.(r.click.id) === true))) {
        r.waits = (r.waits ?? 0) + 1;
        r.until = performance.now() + RESUME_MS;
        resumeTimer = win.setTimeout(expire, RESUME_MS);
        return;
      }
      cancelResume();
    }, r0 ? Math.max(1, r0.until - performance.now()) : RESUME_MS);
  }

  /** Moves the focus to the capture element (at the old caret), so nothing typed meanwhile is lost. */
  function holdFocus(from: HTMLElement | null): void {
    if (disposed) return;
    let top = root.scrollTop + 8, left = root.scrollLeft + 8;
    try {
      const sel = doc.getSelection();
      const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect?.() : null;
      const base = root.getBoundingClientRect();
      const box = r && r.width + r.height > 0 ? r : from?.getBoundingClientRect?.();
      if (box) {
        top = box.top - base.top + root.scrollTop;
        left = box.left - base.left + root.scrollLeft;
      }
    } catch { /* layout unavailable: keep the default spot */ }
    cap.style.top = `${Math.max(0, top)}px`;
    cap.style.left = `${Math.max(0, left)}px`;
    cap.value = '';
    if (!capInDom) { root.appendChild(cap); capInDom = true; }
    if (modalOpen()) return;                     // G16: the question keeps the focus
    try { cap.focus({ preventScroll: true }); } catch { /* */ }
  }

  /** Ends the capture element's hold. OFFC-3 (CONTRACT §11, Switch-off audit decisions): it is in the DOM only while
   *  a resume or a waiting click holds the focus, and this is the ONE function that takes it out — every path that
   *  ends a wait comes here (it succeeded, timed out, was cancelled, the switch was turned off, the document was
   *  replaced; dispose removes it too). The blur comes first, so removing it moves no focus and the scroller keeps
   *  no height for it. */
  function releaseFocus(): void {
    capComposing = false;
    cap.value = '';
    if (doc.activeElement === cap) cap.blur();
    if (capInDom) { cap.remove(); capInDom = false; }
  }

  function cancelResume(): void {
    const had = resume !== null;
    resume = null;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
    doc.removeEventListener('keydown', onResumeKey, true);
    if (had) {
      dropQueued();                              // (P-G: the one toast when typed input is discarded)
      releaseFocus();
    }
    releaseDeferred();                           // an emptied wrapper kept for this resume goes now
  }

  function tryResume(): void {
    const r = resume;
    if (!r || s || !editable || capComposing) return;
    if (performance.now() > r.until) { cancelResume(); return; }
    // P-F amended (and G16: a modal question keeps the focus): the user turned elsewhere — the wait is abandoned
    if (!waitWanted()) { cancelResume(); return; }
    if (r.click) { tryClick(r.click); return; }
    // G12: once the structure shows the history step, its line is scrolled into view (once more).
    if (r.reveal?.again && r.minVersion !== null && version() >= r.minVersion) {
      r.reveal.again = false;
      host.revealLine?.(r.reveal.line);
    }
    const info = host.blockAtLine(r.startLine);
    if (!info || info.lineCount < 1) {
      // U22 (P1): the structure shows the step and there is no block at its line (an undo / redo into an empty
      // document): nothing to wait for — the resume ends now, and the keys queued meanwhile are not dropped
      if (r.minVersion !== null && version() >= r.minVersion) resumeWithoutBlock();
      return;
    }
    if (r.contains) {
      if (!(info.startLine <= r.startLine && r.startLine < info.startLine + info.lineCount)) return;
    } else if (info.startLine !== r.startLine || (r.lineCount !== null && info.lineCount !== r.lineCount)) return;
    // U18 (c): the emptied element's id went to the block typed into it (the deletion and the new block reached
    // one structure together): that block is no emptied element, its hold ends so its HTML can mount (only in a
    // structure that shows the write: an older one still has the deleted block at that line, P-B)
    if (deferred && deferred.forResume && deferred.id === info.id && caughtUp()) releaseDeferred(true);
    // P-B and the place rule: the block at the resume's place in a structure that describes the current source,
    // mounted with HTML of its current lines; the expected text below is only a check on top
    const w = currentWrapper(info);
    if (!w) return;
    let ok = false;
    let shown: string | null = null;
    // Serialized with the hints a session on it would use (its own fence, table delimiter row …), so a
    // block whose source is spelled that way compares equal.
    const own = src ? contentOf(src.read(info.startLine, info.lineCount)) : null;
    const shownNow = (): string => (shown ??= serializeBlock(w, info.kind, own ? { ...(styleHintsOf ? styleHintsOf(own.content) : {}), fence: codeHints(info.kind, own.lines) } : {}));
    try {
      if (r.expected !== null) ok = shownNow() === r.expected;
      if (!ok && r.minVersion !== null && version() >= r.minVersion) ok = true;
      if (!ok && r.matchSource && own) ok = shownNow() === own.content;
    } catch (err) {
      // H15: the block leaves no free marker set — no session can start on it: the resume ends with the refusal
      if (!(err instanceof NoMarkersError)) throw err;
      cancelResume();
      refuse(info.id);
      return;
    }
    if (!ok) return;
    resume = null;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
    doc.removeEventListener('keydown', onResumeKey, true);
    if (!begin(w, info)) { dropQueued(); releaseFocus(); releaseDeferred(); return; }
    w.focus({ preventScroll: true });
    releaseFocus();
    const started = s as Session | null;
    if (r.pos && src) {
      const c = contentOf(src.read(info.startLine, info.lineCount));
      // P-D: the source position as a DOM caret (the content lines start after the block's leading blank lines, U14)
      const p = caretForSource(w, { ...info, startLine: info.startLine + c.leading.length }, c.lines, r.pos.line, r.pos.col, c.leading.length);
      if ('math' in p) { const e = mathToSource(p.math); if (e) caretToEnd(e); }
      else placeSafe(w, p.point[0], p.point[1], started);
    } else {
      setCaretAtOffset(w, r.offset);             // (never inside a non-editable element: P-D)
      if (started && r.beforeAtom) caretBeforeAtomsAt(w, started);   // (U21)
    }
    const at = selectionIn(w);
    if (started) started.caretOffset = at ? textOffsetOf(w, at.node, at.sel.focusOffset) : r.offset;
    // G12 / U1: the session ends on screen.
    if (r.reveal) host.revealLine?.(r.reveal.line);
    // The user's line moved with the caret: tint it here and mirror it in the editor (CONTRACT §9), as a
    // click on that block would have — nothing else announces a line for a resumed session.
    focusCaretLine(w, info.startLine);
    replayOps();
  }

  /** U22 (P1): a resume whose step left no block at its line (an empty document) ends at once. The keys queued
   *  while it waited for the structure are not lost: a queued ⌘Z / ⇧⌘Z steps the source's history now (as it
   *  does outside a session, U2), and the first step that leaves a block resumes there with the keys after it.
   *  Other input has no block to go into and goes no further than it would outside a session. */
  function resumeWithoutBlock(): void {
    const queued = ops;
    ops = [];
    cancelResume();
    // P-G: what has no block to go into is discarded — told once
    const discard = (upTo: number): void => { ops = queued.slice(0, upTo).filter((o) => o.t !== 'history'); dropQueued(); };
    if (!src?.history) { discard(queued.length); return; }
    for (let k = 0; k < queued.length; k++) {
      const op = queued[k];
      if (op.t !== 'history') continue;
      const at = src.history(op.redo);
      if (!at) continue;
      changes++;
      host.revealLine?.(at.line);
      discard(k);
      ops = queued.slice(k + 1);
      startResume({
        startLine: at.line, contains: true, lineCount: null, offset: 0, pos: { line: at.line, col: at.col },
        until: performance.now() + RESUME_MS, expected: null, minVersion: sourceVersion(), matchSource: true,
        reveal: { line: at.line, again: true, extended: 0 },
      }, null);
      return;
    }
    discard(queued.length);
  }

  /** U7: a click that waited for a write of ours to reach the structure starts its session now — on the
   *  block it was released on, with the caret / selection the browser made. */
  function tryClick(c: { id: number; sel: ClickSel }): void {
    if (!caughtUp()) return;                     // (whether the block went away is told by a current structure)
    const info = host.blockInfo(c.id);
    if (!info) { cancelResume(); return; }       // the clicked block went away
    const w = currentWrapper(info);              // (P-B / P-F: its re-render on its way — wait, keys queued)
    if (!w) return;
    resume = null;
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = 0; }
    doc.removeEventListener('keydown', onResumeKey, true);
    if (!startOn(w, info, c.sel)) { dropQueued(); releaseFocus(); releaseDeferred(); return; }
    releaseFocus();
    focusCaretLine(w, info.startLine);
    replayOps();
  }

  /** Begins the session a click asked for: focus, then the browser's caret / selection (or the clicked
   *  formula's source). */
  function startOn(w: HTMLElement, info: BlockInfo, sel: ClickSel): boolean {
    if (!begin(w, info, sel.end === true)) return false;
    try { w.focus({ preventScroll: true }); } catch { /* */ }
    const math = sel.math && w.contains(sel.math) ? sel.math : null;
    if (sel.end) caretAtBlockEnd(w);
    else if (math) { const e = mathToSource(math); if (e) caretToEnd(e); }
    else {
      restoreSelection(w, sel);
      // U21: a caret the browser put inside a non-editable formula (a click on a list marker in front of it, or past
      // its end) goes before it — at its start — or after it
      const a = selectionIn(w);
      const m = a && a.sel.isCollapsed ? closestIn(a.node, NEEDS_SPACER, w) : null;
      if (m && s) {
        if (textOffsetOf(m, a!.node, a!.sel.focusOffset) === 0) { const t = spacerBefore(m, s); placeCaret(t, t.data.length - 1); }
        else placeCaret(m.parentNode!, (Array.prototype.indexOf.call(m.parentNode!.childNodes, m) as number) + 1);
      }
    }
    const cur = s as Session | null;
    const at = cur ? selectionIn(w) : null;
    if (cur && at) cur.caretOffset = textOffsetOf(w, at.node, at.sel.focusOffset);
    return true;
  }

  function restoreSelection(w: HTMLElement, c: ClickSel): void {
    const sel = doc.getSelection();
    if (!sel) return;
    const r = c.range;
    // U20: an end point directly in the wrapper (the browser's caret after a re-render collapsed it there, or a
    // live range whose nodes the re-render replaced) is no place to type: the text offsets are used instead
    if (r && r.startContainer !== w && r.endContainer !== w && w.contains(r.startContainer) && w.contains(r.endContainer)) {
      if (c.backward && sel.setBaseAndExtent) sel.setBaseAndExtent(r.endContainer, r.endOffset, r.startContainer, r.startOffset);
      else { sel.removeAllRanges(); sel.addRange(r); }
      return;
    }
    setCaretAtOffset(w, c.anchor);
    if (c.focus !== c.anchor) {
      const a = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (!a) return;
      const node = a.startContainer, off = a.startOffset;
      setCaretAtOffset(w, c.focus);
      const b = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (b && sel.setBaseAndExtent) sel.setBaseAndExtent(node, off, b.startContainer, b.startOffset);
    }
  }

  function focusCaretLine(w: HTMLElement, startLine: Line): void {
    const at = selectionIn(w);
    const t = at ? (at.node.nodeType === 1 ? at.node as Element : at.node.parentElement) : null;
    const marked = t?.closest<HTMLElement>('[data-l]') ?? null;
    const rel = marked && w.contains(marked) ? Number(marked.dataset.l) : 0;
    const line = startLine + (Number.isFinite(rel) ? rel : 0);
    host.setFocusLine?.(line);
    bus.emit('focus:line', { line, source: 'preview' });
  }

  const RESUME_KEYS = new Set(['Backspace', 'Delete', 'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

  /** Keys typed while a resume waits: queued (and kept from the capture element) for the new session. Only
   *  keys meant for the preview are taken: the capture element's, or the preview's own; a key for an app
   *  dialog, the toolbar, the editor or a text field keeps its meaning (nothing queued, nothing prevented). */
  function onResumeKey(e: KeyboardEvent): void {
    if (!resume || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t !== cap && (!t || !root.contains(t) || t.closest('input, select, textarea, .cm-editor'))) return;
    if (modalOpen()) return;                     // G16: an app question is up — its keys are its own
    if (e.ctrlKey || e.metaKey) {
      let op: Op | null = null;
      const edit = editCmdOf(e);
      if (src?.history && (matchShortcut(e, 'Mod-z') || matchShortcut(e, 'Mod-Shift-z') || (!IS_MAC && matchShortcut(e, 'Mod-y')))) {
        op = { t: 'history', redo: !matchShortcut(e, 'Mod-z') };
      } else if (matchShortcut(e, 'Mod-b')) op = { t: 'format', cmd: 'bold' };
      else if (matchShortcut(e, 'Mod-i')) op = { t: 'format', cmd: 'italic' };
      else if (matchShortcut(e, 'Mod-e')) op = { t: 'format', cmd: 'code' };
      else if (matchShortcut(e, 'Mod-k')) op = { t: 'format', cmd: 'link' };
      else if (edit) op = { t: 'edit', cmd: edit, shift: e.shiftKey };     // G10: ⌘← ⌘→ ⌘⌫ Ctrl-E ⌘A …
      // A session treats Enter / Esc / Tab the same with or without ⌘ / Ctrl.
      else if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') op = { t: 'key', key: e.key, shift: e.shiftKey, alt: e.altKey, mod: false };
      if (op) { e.preventDefault(); e.stopPropagation(); ops.push(op); }
      return;                                    // other shortcuts (⌘S …) go their own way
    }
    if (e.key.length === 1 || (e.key.length === 2 && /[\ud800-\udbff]/.test(e.key))) {
      e.preventDefault();
      pushText(e.key);
      return;
    }
    if (RESUME_KEYS.has(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') e.stopPropagation();
      ops.push({ t: 'key', key: e.key, shift: e.shiftKey, alt: e.altKey, mod: false });
    }
  }

  function pushText(data: string): void {
    const last = ops[ops.length - 1];
    if (last && last.t === 'text') last.data += data;
    else ops.push({ t: 'text', data });
  }

  function onCapBeforeInput(e: InputEvent): void {
    if (!resume) return;
    if (e.isComposing || e.inputType === 'insertCompositionText') return;
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') {
      e.preventDefault();
      if (e.data) pushText(e.data);
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      ops.push({ t: 'key', key: 'Enter', shift: e.inputType === 'insertLineBreak', alt: false, mod: false });
    } else if (e.inputType !== 'insertFromPaste') {
      e.preventDefault();
    }
  }

  function onCapCompositionStart(): void { capComposing = true; }
  function onCapCompositionEnd(e: CompositionEvent): void {
    capComposing = false;
    if (e.data) pushText(e.data);
    cap.value = '';
    if (resume) {
      resume.until = performance.now() + RESUME_MS;
      armResumeTimer();
      tryResume();
    }
  }
  function onCapPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    if (resume && text) ops.push({ t: 'paste', text });
  }
  function onCapInput(): void { if (!capComposing) cap.value = ''; }
  cap.addEventListener('beforeinput', onCapBeforeInput as EventListener);
  cap.addEventListener('compositionstart', onCapCompositionStart);
  cap.addEventListener('compositionend', onCapCompositionEnd as EventListener);
  cap.addEventListener('paste', onCapPaste);
  cap.addEventListener('input', onCapInput);

  /** Applies the queued input to the session that just started, in order. An op that ends the session
   *  again (a merge, an undo step) leaves the rest queued for the next resume. */
  function replayOps(): void {
    while (ops.length > 0) {
      const cur = s;
      if (!cur || resume || disposed) return;
      const op = ops.shift()!;
      if (linkUi) { replayIntoLink(op); continue; }
      applyOp(op, cur);
    }
  }

  function replayIntoLink(op: Op): void {
    const input = linkUi?.box.querySelector('input');
    if (!input) return;
    if (op.t === 'text') input.value += op.data;
    else if (op.t === 'paste') input.value += op.text.replace(/\n/g, '');
    else if (op.t === 'key' && op.key === 'Enter') closeLinkUi(true);
    else if (op.t === 'key' && op.key === 'Escape') closeLinkUi(false);
    else if (op.t === 'key' && op.key === 'Backspace') input.value = input.value.slice(0, -1);
  }

  function applyOp(op: Op, cur: Session): void {
    switch (op.t) {
      case 'text':
        noteUser(op.data);                       // (THE GUARD: typed while a resume waited; execCommand fires no beforeinput)
        exec('insertText', op.data);
        return;
      case 'paste':
        pasteText(op.text, cur);
        return;
      case 'history':
        runHistory(op.redo, cur);
        return;
      case 'format':
        if (op.cmd === 'code') toggleInlineCode(cur);
        else if (op.cmd === 'link') openLinkUi(cur);
        else {
          const at = selectionIn(cur.el);
          if (at && !inCode(at.node, cur.el)) { exec(op.cmd); schedule(); }
        }
        return;
      case 'key':
        applyKey(op, cur);
        return;
      case 'edit':
        applyEdit(op, cur);
        return;
      case 'para':
        recreateParagraph(op.before, cur);
        return;
    }
  }

  /** G10: what the browser does for the key inside a session (Chrome's editing commands of the same name). */
  function applyEdit(op: Extract<Op, { t: 'edit' }>, cur: Session): void {
    const sel = doc.getSelection() as (Selection & { modify?: (a: string, d: string, g: string) => void }) | null;
    if (!sel) return;
    const move = (dir: string, unit: string): void => { sel.modify?.(op.shift ? 'extend' : 'move', dir, unit); };
    /** Deletes the selection, else up to the `unit` boundary (one character when the caret is already there). */
    const del = (dir: string, unit: string): void => {
      if (cur.gone && goneKey(cur, dir === 'backward')) return;   // (U18 a)
      if (sel.isCollapsed) sel.modify?.('extend', dir, unit);
      if (sel.isCollapsed) sel.modify?.('extend', dir, 'character');
      if (!sel.isCollapsed) { exec('delete'); schedule(); }
    };
    switch (op.cmd) {
      case 'lineStart': move('backward', 'lineboundary'); return;
      case 'lineEnd': move('forward', 'lineboundary'); return;
      case 'paraStart': move('backward', 'paragraphboundary'); return;
      case 'paraEnd': move('forward', 'paragraphboundary'); return;
      case 'docStart': move('backward', 'documentboundary'); return;
      case 'docEnd': move('forward', 'documentboundary'); return;
      case 'charBack': move('backward', 'character'); return;
      case 'charFwd': move('forward', 'character'); return;
      case 'lineUp': move('backward', 'line'); return;
      case 'lineDown': move('forward', 'line'); return;
      case 'wordBack': move('backward', 'word'); return;
      case 'wordFwd': move('forward', 'word'); return;
      case 'delLineBack': del('backward', 'lineboundary'); return;
      case 'delLineFwd': del('forward', 'lineboundary'); return;
      case 'delParaFwd': del('forward', 'paragraphboundary'); return;
      case 'delWordBack': del('backward', 'word'); return;
      case 'delWordFwd': del('forward', 'word'); return;
      case 'delBack': if (!(cur.gone && goneKey(cur, true))) { exec('delete'); schedule(); } return;
      case 'delFwd': if (!(cur.gone && goneKey(cur, false))) { exec('forwardDelete'); schedule(); } return;
      case 'selectAll': selectAllKey(cur, sel); return;
    }
  }

  /** ⌘A in a session (U7): the block's content; again, with that content fully selected, the whole preview. */
  function selectAllKey(cur: Session, sel: Selection): boolean {
    const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (range && blockFullySelected(cur.el, range)) {
      end();
      const r = doc.createRange();
      r.selectNodeContents(root);
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    }
    sel.selectAllChildren(cur.el);
    return false;
  }

  /** G11: puts an empty paragraph after (or before) the caret's top-level element and the caret in it. */
  function recreateParagraph(before: boolean, cur: Session): void {
    const at = selectionIn(cur.el);
    let top: Node | null = at ? at.node : null;
    while (top && top.parentNode && top.parentNode !== cur.el) top = top.parentNode;
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    if (top && top.parentNode === cur.el) {
      if (before) cur.el.insertBefore(p, top);
      else cur.el.insertBefore(p, top.nextSibling);
    } else cur.el.appendChild(p);
    placeCaret(p, 0);
  }

  function applyKey(op: Extract<Op, { t: 'key' }>, cur: Session): void {
    const sel = doc.getSelection() as (Selection & { modify?: (a: string, d: string, g: string) => void }) | null;
    const move = (dir: string, unit: string): void => { sel?.modify?.(op.shift ? 'extend' : 'move', dir, unit); };
    switch (op.key) {
      case 'Backspace':
        if (cur.gone ? goneKey(cur, true) : !op.alt && tryMergeBackward(cur)) return;   // (U18 a)
        if (!op.alt && !cur.gone) dropFreshBox(cur);
        if (op.alt && sel?.isCollapsed) sel.modify?.('extend', 'backward', 'word');
        exec('delete');
        return;
      case 'Delete': if (!(cur.gone && goneKey(cur, false))) exec('forwardDelete'); return;
      case 'Enter': enterKey(op.shift, cur); return;
      case 'Tab': tabKey(op.shift, cur); return;
      case 'Escape': end(); return;
      case 'ArrowLeft': move('backward', op.alt ? 'word' : 'character'); return;
      case 'ArrowRight': move('forward', op.alt ? 'word' : 'character'); return;
      case 'ArrowUp': move('backward', 'line'); return;
      case 'ArrowDown': move('forward', 'line'); return;
      case 'Home': move('backward', 'lineboundary'); return;
      case 'End': move('forward', 'lineboundary'); return;
    }
  }

  // ---------------------------------------------------------------- selection helpers
  function selectionIn(el: Element): { sel: Selection; range: Range; node: Node } | null {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = sel.focusNode;
    if (!node || !el.contains(node)) return null;
    return { sel, range, node };
  }

  function closestIn(node: Node, selector: string, stop: Element): HTMLElement | null {
    const e = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>(selector) ?? null;
    return e && stop.contains(e) ? e : null;
  }

  function trackCaret(): void {
    caretRaf = 0;
    if (!s) return;
    const at = selectionIn(s.el);
    if (at) s.caretOffset = textOffsetOf(s.el, at.node, at.sel.focusOffset);
    // The code ⌘E opened stays "open" only while the caret is inside it.
    if (s.openCode && (!at || !s.openCode.contains(at.node))) s.openCode = null;
  }

  function placeCaret(node: Node, offset: number): void {
    const r = doc.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  // ---------------------------------------------------------------- formulas
  /** Swaps a rendered formula for its TeX source (editable text; serialized back to `$…$` / `$$…$$`). null (nothing
   *  swapped) when its TeX is not known (P-G b: a formula the browser re-created without its stamp). */
  function mathToSource(m: HTMLElement): HTMLElement | null {
    const tex = formulaTex(m, true);
    if (tex === null) return null;
    const block = m.classList.contains('md-math--block');
    const e = doc.createElement(block ? 'pre' : 'code');
    e.className = `md-math-src ${block ? 'md-math--block' : m.classList.contains('md-math--display') ? 'md-math--display' : 'md-math--inline'}`;
    e.textContent = tex;
    m.replaceWith(e);
    return e;
  }

  function caretToEnd(e: Element): void {
    const r = doc.createRange();
    r.selectNodeContents(e);
    r.collapse(false);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  // ---------------------------------------------------------------- keys
  function inCode(node: Node, el: Element): boolean {
    return closestIn(node, 'pre, .md-math-src', el) !== null;
  }

  function onEnter(e: KeyboardEvent, cur: Session): void {
    // Every Enter is ours: the browser's own paragraph / div insertion is never what Markdown needs.
    e.preventDefault();
    enterKey(e.shiftKey, cur);
  }

  function enterKey(shift: boolean, cur: Session): void {
    const at = selectionIn(cur.el);
    if (!at) return;
    const { node } = at;
    if (inCode(node, cur.el)) {
      if (closestIn(node, 'code.md-math-src', cur.el)) return;   // inline formula: one line
      // insertLineBreak inserts a literal '\n' where white-space preserves newlines (and a second one at the
      // very end so the new line shows). insertText('\n') runs Chrome's paragraph-separator command instead,
      // which splits the block-level <code> in two mid-line and the newline is lost.
      exec('insertLineBreak');
      return;
    }
    // U21: the image / formula the caret stands directly before (once U13's whitespace is gone): see caretBeforeAtom
    const atomNext = (range: Range): { atom: Element; had: Set<Element> } | null => {
      const atom = atomAfter(range, cur.el);
      return atom ? { atom, had: new Set(Array.from(cur.el.querySelectorAll('br'))) } : null;
    };
    if (shift) {
      dropWhitespaceAfter(at.range, cur.el);     // U13 (a hard break wrote it as &nbsp; too)
      const a = atomNext(at.range);
      exec('insertLineBreak');
      if (a) caretBeforeAtom(a.atom, cur, a.had, 1);
      return;
    }
    if (closestIn(node, 'td, th', cur.el)) return;
    const li = closestIn(node, 'li', cur.el);
    if (li) {
      const text = Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test((c as Element).tagName))).map((c) => c.textContent ?? '').join('');
      if (text.replace(/[\s\u200b ]/g, '') === '') { leaveListItem(li, cur.el); schedule(); return; }
      const task = li.classList.contains('task-list-item');
      dropWhitespaceAfter(at.range, cur.el);
      const a = atomNext(at.range);
      exec('insertParagraph');
      if (a) caretBeforeAtom(a.atom, cur, a.had, 0);
      const now = selectionIn(cur.el);
      const fresh = now ? closestIn(now.node, 'li', cur.el) : null;
      if (task && fresh && fresh !== li && !fresh.querySelector(':scope > input, :scope > p > input')) {
        const box = doc.createElement('input');
        box.type = 'checkbox';
        box.className = 'task-list-item-checkbox';
        fresh.classList.add('task-list-item');
        // P-G (d): a task item of this list for ownTaskBox: its line map as the browser's split copies it (Chromium
        // clones the item with its attributes), given when the copy lacks it
        if (!fresh.hasAttribute('data-l') && li.hasAttribute('data-l')) fresh.setAttribute('data-l', li.getAttribute('data-l')!);
        const host2 = fresh.firstElementChild?.tagName === 'P' ? fresh.firstElementChild : fresh;
        // The checkbox gives the new item its line: the browser's placeholder <br> of the empty item would stay
        // behind the text typed next (a line break the source does not have).
        const ph = host2.lastChild;
        if (ph && ph.nodeType === 1 && (ph as Element).tagName === 'BR' && !INK.test(host2.textContent ?? '')) ph.remove();
        host2.insertBefore(box, host2.firstChild);
        box.after(doc.createTextNode(' '));
        freshBoxes.add(box);
        placeCaretAfter(box.nextSibling!);
      }
      return;
    }
    dropWhitespaceAfter(at.range, cur.el);
    const a = atomNext(at.range);
    exec('insertParagraph');
    if (a) caretBeforeAtom(a.atom, cur, a.had, 0);
    // A new paragraph after (or split off) a heading is a paragraph, not a second heading.
    const now = selectionIn(cur.el);
    const h = now ? closestIn(now.node, 'h1, h2, h3, h4, h5, h6', cur.el) : null;
    if (h && cur.kind === BlockKind.Heading && h.previousElementSibling && /^H[1-6]$/.test(h.previousElementSibling.tagName)) {
      const p = doc.createElement('p');
      while (h.firstChild) p.appendChild(h.firstChild);
      if (!p.firstChild) p.appendChild(doc.createElement('br'));
      h.replaceWith(p);
      setCaretAtOffset(p, 0);
    }
  }

  /** U23 / P-G (e) in a task list: Backspace with the caret right after the checkbox this module put into the item an
   *  Enter made (only that box and the space after it before the caret, an item before it) takes the box and the space
   *  away; the browser's own Backspace that follows joins the item with the one before, as in any other list — Enter
   *  then Backspace gives the source back. A box of the document is never touched. */
  function dropFreshBox(cur: Session): void {
    const at = selectionIn(cur.el);
    if (!at || !at.sel.isCollapsed) return;
    const li = closestIn(at.node, 'li', cur.el);
    if (!li || li.previousElementSibling?.tagName !== 'LI') return;
    const line = li.firstElementChild?.tagName === 'P' ? li.firstElementChild : li;
    let first: Node | null = line.firstChild;
    while (first && first.nodeType === 3 && (first as Text).data === '') first = first.nextSibling;
    if (!first || first.nodeType !== 1 || !freshBoxes.has(first as Element) || !ownTaskBox(first as HTMLInputElement)) return;
    const gap = doc.createRange();
    gap.setStartAfter(first);
    gap.setEnd(at.range.startContainer, at.range.startOffset);
    if (gap.collapsed && !(gap.startContainer === line && gap.startOffset === Array.prototype.indexOf.call(line.childNodes, first) + 1)) return;
    if (!/^[ \u00a0]*$/.test(gap.toString()) || gap.cloneContents().querySelector('*')) return;
    gap.deleteContents();
    (first as Element).remove();
    // an item left empty keeps a line for the caret (the browser's placeholder), or its Backspace goes astray
    if (!hasContent(line) && !line.querySelector('br')) line.appendChild(doc.createElement('br'));
    placeCaret(line, 0);
  }

  /** U13: the plain whitespace (U+0020, a tab, the line feed of a soft line break) right after the selection's
   *  end inside its paragraph, heading, list item or cell would start the new paragraph / item of an Enter —
   *  the browser keeps it as one non-breaking space, written `&nbsp;`. It is removed from the DOM before the
   *  browser's command (the caret stays where it is), so the new paragraph / item starts with the text after
   *  it. The run stops at anything else: other text (a non-breaking space or U+3000 is the document's own), a
   *  line break, an image, a formula, the end of the paragraph; nothing inside code is touched. */
  function dropWhitespaceAfter(range: Range, el: Element): void {
    const end = range.endContainer;
    if (!el.contains(end) || closestIn(end, 'code, pre, .md-math, .md-math-src, [data-mdr-ui]', el)) return;
    const box = closestIn(end, 'p, li, td, th, h1, h2, h3, h4, h5, h6', el) ?? el;
    const rest = doc.createRange();
    rest.setStart(end, range.endOffset);
    rest.setEnd(box, box.childNodes.length);
    const run: Array<[Text, number, number]> = [];
    const tw = doc.createTreeWalker(box, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 1) {
        // an element holding the selection's end is passed through; one after it stops the run unless it is
        // inline formatting (its text continues the run)
        if (n.contains(end) || !rest.intersectsNode(n)) continue;
        const e = n as Element;
        if (!WS_INLINE.has(e.tagName) || e.matches('.md-math, [data-mdr-ui], [contenteditable="false"]')) break;
        continue;
      }
      const t = n as Text;
      if (t !== end && !rest.intersectsNode(t)) continue;
      const from = t === end ? range.endOffset : 0;
      let k = from;
      while (k < t.data.length && PLAIN_WS.includes(t.data[k])) k++;
      if (k > from) run.push([t, from, k - from]);
      if (k < t.data.length) break;
    }
    for (const [t, from, n] of run) t.deleteData(from, n);
  }

  /** U21: a zero-width space right before `atom` (the one there already, or a new one the session takes out again):
   *  a text position before a non-editable element. */
  function spacerBefore(atom: Element, cur: Session): Text {
    const p = atom.previousSibling;
    if (p && p.nodeType === 3 && (p as Text).data.endsWith(ZWSP)) return p as Text;
    const t = doc.createTextNode(ZWSP);
    atom.before(t);
    cur.spacers.push(t);
    return t;
  }

  /** U21: the image, formula or checkbox directly after the end of `range` on its line (nothing shown between). */
  function atomAfter(range: Range, el: Element): Element | null {
    const end = range.endContainer;
    if (!el.contains(end) || closestIn(end, 'code, pre, .md-math, .md-math-src, [data-mdr-ui]', el)) return null;
    const box = closestIn(end, LINE_BOX, el) ?? el;
    const rest = doc.createRange();
    rest.setStart(end, range.endOffset);
    rest.setEnd(box, box.childNodes.length);
    const tw = doc.createTreeWalker(box, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 1) {
        if (n.contains(end) || !rest.intersectsNode(n)) continue;
        const e = n as Element;
        if (e.hasAttribute('data-mdr-ui')) return null;
        if (e.matches(ATOM_SEL)) return e;
        if (!WS_INLINE.has(e.tagName)) return null;   // a line break, code, a nested list …
        continue;
      }
      const t = n as Text;
      if (t !== end && !rest.intersectsNode(t)) continue;
      if (NOT_ZW.test(t.data.slice(t === end ? range.endOffset : 0))) return null;
    }
    return null;
  }

  /** U21: after the command of an Enter that stood directly before `atom`: a <br> the browser put right before a
   *  non-editable element (its placeholder: the new line has no editable text) is no line break the user typed and
   *  goes — `brs` is how many line breaks the command itself makes (Shift+Enter: one, kept) — and the caret goes
   *  directly before the atom, so the text typed next stands before it on the same line. `had`: the line breaks of
   *  the block before the command. */
  function caretBeforeAtom(atom: Element, cur: Session, had: Set<Element>, brs: number): void {
    if (!cur.el.contains(atom)) return;
    const made = Array.from(cur.el.querySelectorAll('br')).filter((b) => !had.has(b)).length;
    let prev = atom.previousSibling;
    while (prev && prev.nodeType === 3 && !NOT_ZW.test((prev as Text).data)) prev = prev.previousSibling;
    if (made > brs && prev && prev.nodeType === 1 && (prev as Element).tagName === 'BR' && !had.has(prev as Element)) prev.remove();
    if (atom.matches(NEEDS_SPACER)) {
      const t = spacerBefore(atom, cur);
      placeCaret(t, t.data.length - 1);
      return;
    }
    const parent = atom.parentNode!;
    placeCaret(parent, Array.prototype.indexOf.call(parent.childNodes, atom) as number);
  }

  /** U21: a resume that was directly before an atom: the caret the text offset gave (at the start of the text after
   *  the atoms there) goes back before them. */
  function caretBeforeAtomsAt(w: HTMLElement, cur: Session): void {
    const at = selectionIn(w);
    if (!at || !at.sel.isCollapsed || at.node.nodeType !== 3 || at.sel.focusOffset !== 0) return;
    let first: Element | null = closestIn(at.node, NEEDS_SPACER, w);
    if (!first) {
      for (let n: Node = at.node; n !== w && n.parentNode; n = n.parentNode) {
        let p = n.previousSibling;
        for (; p; p = p.previousSibling) {
          if (p.nodeType === 3 && !NOT_ZW.test((p as Text).data)) continue;
          if (p.nodeType === 1 && (p as Element).matches(ATOM_SEL)) { first = p as Element; continue; }
          break;
        }
        if (p || (n.parentNode as Element).matches(LINE_BOX) || n.parentNode === w) break;
      }
    }
    if (!first) return;
    if (first.matches(NEEDS_SPACER)) { const t = spacerBefore(first, cur); placeCaret(t, t.data.length - 1); return; }
    const parent = first.parentNode!;
    placeCaret(parent, Array.prototype.indexOf.call(parent.childNodes, first) as number);
  }

  /** P-D: a collapsed caret at (node, offset) in the session's block `w` — never inside a non-editable element (a
   *  point inside one goes directly after it, or before it at its very start) — and directly before a formula that
   *  starts a line through its zero-width spacer (U21: the browser has no caret position there otherwise). */
  function placeSafe(w: HTMLElement, node: Node, offset: number, cur: Session | null): void {
    let ne: Element | null = null;
    for (let e: Element | null = node.nodeType === 1 ? node as Element : node.parentElement; e && e !== w && w.contains(e); e = e.parentElement) {
      if (e.matches(NEEDS_SPACER)) ne = e;     // (the outermost)
    }
    let n = node, o = offset;
    let atom: Element | null = null;           // the caret stands directly before it
    if (ne) {
      const p = ne.parentNode!;
      const i = Array.prototype.indexOf.call(p.childNodes, ne) as number;
      const atStart = node === ne ? offset === 0 : textOffsetOf(ne, node, offset) === 0;
      n = p;
      o = atStart ? i : i + 1;
      if (atStart) atom = ne;
    } else if (n.nodeType === 1 && n.childNodes[o]?.nodeType === 1 && (n.childNodes[o] as Element).matches(NEEDS_SPACER)) {
      atom = n.childNodes[o] as Element;
    }
    if (atom && cur && lineLeading(atom, w)) { const t = spacerBefore(atom, cur); placeCaret(t, t.data.length - 1); return; }
    placeCaret(n, o);
  }

  function placeCaretAfter(n: Node): void {
    const r = doc.createRange();
    if (n.nodeType === 3) r.setStart(n, (n as Text).data.length);
    else r.setStartAfter(n);
    r.collapse(true);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  /** Enter on an empty item: a nested item moves one level out, a top-level one leaves the list as a paragraph. */
  function leaveListItem(li: HTMLElement, el: Element): void {
    const list = li.parentElement!;
    const parentLi = list.parentElement;
    if (parentLi && parentLi.tagName === 'LI' && el.contains(parentLi)) { outdent(li); setCaretAtOffset(li, 0); return; }
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    // items after the empty one continue as a second list after the paragraph
    const rest: Element[] = [];
    for (let n = li.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
    li.remove();
    list.after(p);
    if (rest.length > 0) {
      const tail = doc.createElement(list.tagName.toLowerCase());
      for (const r of rest) tail.appendChild(r);
      p.after(tail);
    }
    if (list.children.length === 0) list.remove();
    const r = doc.createRange();
    r.setStart(p, 0);
    r.collapse(true);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  function saveCaret(el: Element): number | null {
    const at = selectionIn(el);
    return at ? textOffsetOf(el, at.node, at.sel.focusOffset) : null;
  }

  function indent(li: HTMLElement): void {
    const prev = li.previousElementSibling as HTMLElement | null;
    if (!prev || prev.tagName !== 'LI') return;
    const list = li.parentElement!;
    let sub = Array.from(prev.children).reverse().find((c) => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement | undefined;
    if (!sub) {
      sub = doc.createElement(list.tagName.toLowerCase());
      prev.appendChild(sub);
    }
    sub.appendChild(li);
  }

  function outdent(li: HTMLElement): void {
    const list = li.parentElement!;
    const parentLi = list.parentElement;
    if (!parentLi || parentLi.tagName !== 'LI') return;
    const rest: Element[] = [];
    for (let n = li.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
    if (rest.length > 0) {
      let sub = Array.from(li.children).reverse().find((c) => c.tagName === 'UL' || c.tagName === 'OL') as HTMLElement | undefined;
      if (!sub) { sub = doc.createElement(list.tagName.toLowerCase()); li.appendChild(sub); }
      for (const r of rest) sub.appendChild(r);
    }
    parentLi.after(li);
    if (list.children.length === 0) list.remove();
  }

  function onTab(e: KeyboardEvent, cur: Session): void {
    e.preventDefault();
    tabKey(e.shiftKey, cur);
  }

  function tabKey(shift: boolean, cur: Session): void {
    const at = selectionIn(cur.el);
    if (!at) return;
    if (inCode(at.node, cur.el)) { if (!shift) exec('insertText', '  '); return; }
    const cell = closestIn(at.node, 'td, th', cur.el);
    if (cell) {
      const table = cell.closest('table')!;
      const cells = Array.from(table.querySelectorAll<HTMLElement>('th, td'));
      const next = cells[cells.indexOf(cell) + (shift ? -1 : 1)];
      if (next) caretToEnd(next);
      return;
    }
    const li = closestIn(at.node, 'li', cur.el);
    if (li) {
      // G13: the caret stays in the moved item — kept relative to the item, since an empty item (Enter, then
      // Tab) has no text offset of its own and a block-wide offset would land in the item before it.
      const off = textOffsetOf(li, at.node, at.sel.focusOffset);
      if (shift) outdent(li); else indent(li);
      caretInItem(li, off);
      schedule();
    }
  }

  /** Puts the caret at visible-text offset `off` of the item's own text, or at the start of an empty item. */
  function caretInItem(li: HTMLElement, off: number): void {
    if (visibleTexts(li).some((t) => t.parentElement?.closest('li') === li)) { setCaretAtOffset(li, off); return; }
    const first = li.firstElementChild;
    placeCaret(first && first.tagName === 'P' ? first : li, 0);
  }

  // ---------------------------------------------------------------- Backspace at the very start (U3)
  /** Backspace with a collapsed caret at offset 0 of a paragraph whose previous block is a paragraph too:
   *  the two are joined in the source (no character lost or added, the blank lines between them gone) and
   *  the session continues in the merged block at the join. False = not that case (nothing done). */
  function tryMergeBackward(cur: Session): boolean {
    // U18 (a): an emptied element owns no lines (cur.startLine is where the NEXT block starts): never a merge
    if (cur.gone) return goneKey(cur, true);
    if (!src || cur.composing || cur.kind !== BlockKind.Prose) return false;
    const at = selectionIn(cur.el);
    if (!at || !at.sel.isCollapsed || textOffsetOf(cur.el, at.node, at.sel.focusOffset) !== 0) return false;
    const onlyParagraph = (w: Element): boolean => {
      const kids = Array.from(w.children).filter((c) => !c.hasAttribute('data-mdr-ui'));
      return kids.length === 1 && kids[0].tagName === 'P';
    };
    if (!onlyParagraph(cur.el)) return false;
    if (!retrack()) return true;                 // the block went away: nothing to merge into (handled)
    const prev = cur.startLine > 1 ? host.blockAtLine(cur.startLine - 1) : null;
    if (!prev || prev.kind !== BlockKind.Prose || prev.startLine + prev.lineCount !== cur.startLine) return false;
    const prevSrc = contentOf(src.read(prev.startLine, prev.lineCount));
    if (prevSrc.content === '') return false;
    // A paragraph: judged by its rendering when that is current (right after a split it is not — the old
    // wrapper still shows both halves), else by its source: no setext underline, no raw HTML start.
    const pw = currentWrapper(prev);
    if (pw) {
      if (!onlyParagraph(pw) || unsupportedReason(pw, prevSrc.content) !== null) return false;
    } else {
      const last = prevSrc.lines[prevSrc.lines.length - 1];
      if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(last) || /^ {0,3}</.test(prevSrc.lines[0])) return false;
      if (unsupportedReason(doc.createElement('div'), prevSrc.content) !== null) return false;
    }
    // What the source holds for this block once the pending DOM change is written (the source, not the
    // serialization: an untouched non-canonical block keeps its own spelling).
    let text: string;
    try { text = blockText(cur); } catch (err) {
      if (!(err instanceof NoMarkersError)) throw err;
      refuseMarkers(cur);                        // (H15: nothing written, the session ends)
      return true;
    }
    const mine = text === cur.baseline ? contentOf(src.read(cur.startLine, cur.lineCount)).content : text.trim() === '' ? '' : text;
    if (segmentAll(mine.split('\n')).length > 1) return false;
    const merged = prevSrc.content + mine;
    // P1 (round 7): the block the session would continue in is tested as a start is tested; refused, the merge is
    // refused — nothing written, the toast, the session where it is (the caret at the start of its block)
    if (!mergeContinues(merged, prevSrc.content, pw)) { refuse(cur.id); return true; }
    // U14: the blank lines before the first block's content stay
    const lead = prevSrc.leading.length;
    const full = framed(prevSrc.leading, merged, cur.trailing);
    const start = prev.startLine, count = prev.lineCount + cur.lineCount;
    // the join, as a source position (mapped onto the merged block's text once it is rendered)
    const join = { line: start + lead + prevSrc.lines.length - 1, col: prevSrc.lines[prevSrc.lines.length - 1].length };
    const el = cur.el;
    teardown(cur);
    try { replaceSource(start, count, full); } catch (err) {
      if (!(err instanceof WriteRefused)) throw err;
      refuse(cur.id);                            // (THE GUARD: nothing written; the block re-renders from its source)
      return true;
    }
    const r = resumeAt(start, lead + merged.split('\n').length + cur.trailing.length, 0, merged);
    r.pos = join;
    r.minVersion = sourceVersion();
    startResume(r, el);
    return true;
  }

  /** U18 (a): a deletion key (`back`: Backspace and its word / line variants; else forward Delete) in an emptied
   *  element whose deletion is written. The source never changes: Backspace makes the element go away and the
   *  caret move to the end of the block before it (when a session can start there; else the session just ends),
   *  forward Delete does nothing. Text typed into the element and not yet written is the browser's to delete,
   *  except across the element's start (nothing happens there). True = handled (the key's default is
   *  prevented). */
  function goneKey(cur: Session, back: boolean): boolean {
    if (cur.composing) return false;
    let text: string;
    try { text = serializeBlock(cur.el, cur.kind, { ...cur.hints, editing: true }); } catch (err) {
      if (!(err instanceof NoMarkersError)) throw err;
      refuseMarkers(cur);                        // (H15)
      return true;
    }
    if (text.trim() === '') {
      if (back) leaveGone(cur);
      return true;
    }
    if (!back) return false;
    const at = selectionIn(cur.el);
    return !!at && at.sel.isCollapsed && textOffsetOf(cur.el, at.node, at.sel.focusOffset) === 0;
  }

  function leaveGone(cur: Session): void {
    const prev = cur.prevId >= 0 ? host.blockInfo(cur.prevId) : null;
    const el = cur.el;
    teardown(cur);                               // the emptied element goes (the host removes it)
    if (!prev || !editable || !EDITABLE_KINDS.has(prev.kind)) return;
    const sel: ClickSel = { range: null, backward: false, anchor: 0, focus: 0, math: null, end: true };
    const w = currentWrapper(prev);              // (P-B)
    if (w) { startOn(w, prev, sel); return; }
    // The deletion is still on its way through the worker, or it gave the block before a blank line and that
    // block re-renders: the session starts once the structure (and its HTML) caught up; keys are queued (U4).
    startResume({
      startLine: prev.startLine, contains: false, lineCount: null, offset: 0, pos: null,
      until: performance.now() + RESUME_MS, expected: null, minVersion: sourceVersion(), matchSource: false,
      click: { id: prev.id, sel }, waits: 0,
    }, el);
  }

  /** U18: a collapsed caret at the end of the block's content — after an image or a formula that ends its last
   *  line, before the final line break of code; a formula block shows its TeX source (as a click on it does). */
  function caretAtBlockEnd(w: HTMLElement): void {
    const boxes = Array.from(w.querySelectorAll<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6, td, th, pre, .md-math--block'))
      .filter((e) => !e.closest('[data-mdr-ui]'));
    const last = boxes[boxes.length - 1];
    if (!last) { setCaretAtOffset(w, visibleLength(w)); return; }
    const m = last.closest<HTMLElement>('.md-math');
    if (m && w.contains(m)) { const e = mathToSource(m); if (e) { caretToEnd(e); return; } }
    if (last.tagName === 'PRE') {
      const texts = visibleTexts(last);
      const t = texts[texts.length - 1];
      if (t) placeCaret(t, t.data.length - (t.data.endsWith('\n') ? 1 : 0));
      else caretToEnd(last.querySelector('code') ?? last);
      return;
    }
    caretToEnd(last);
  }

  // ---------------------------------------------------------------- undo / redo through the source (U1)
  /** ⌘Z / ⇧⌘Z: flush, step the source's history, then continue on the block holding the returned line. */
  function runHistory(redo: boolean, cur: Session): void {
    if (!src?.history) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const split = commit();
    if (s !== cur) return;                       // the block went away while flushing
    const el = cur.el;
    const at = src.history(redo);
    if (!at) {
      if (split) { teardown(cur, true); startResume(split, el); }
      return;
    }
    changes++;
    // P-C (J30): undoing the deletion written for an emptied element puts the deleted block back at the element's
    // place; the session continues in THAT block — at the step's position when it lies in it, else at the end of
    // its content (a first block's deletion reached the start of the next block, where the step leaves the caret)
    const back = cur.gone && !redo ? cur.startLine - cur.goneKeep : 0;
    const line = back > 0 && at.line >= back && at.line <= back + cur.lineCount ? back : at.line;
    teardown(cur, true);
    // G12: the step may land in a block far from the viewport: scroll its line into view now (which mounts
    // it), again once the structure shows the step, and keep the queued keys while it mounts.
    host.revealLine?.(at.line);
    startResume({
      startLine: line, contains: true, lineCount: null, offset: 0, pos: { line: at.line, col: at.col },
      until: performance.now() + RESUME_MS, expected: null, minVersion: sourceVersion(), matchSource: true,
      reveal: { line: at.line, again: true, extended: 0 },
    }, el);
  }

  // ---------------------------------------------------------------- inline code / links (U5)
  function toggleInlineCode(cur: Session): void {
    const at = selectionIn(cur.el);
    if (!at || inCode(at.node, cur.el)) return;
    const code = closestIn(at.node, 'code', cur.el);
    if (code) {
      if (code === cur.openCode && at.sel.isCollapsed) {
        // ⌘E again on the code ⌘E opened: leave it (an untouched one disappears).
        cur.openCode = null;
        const after = code.nextSibling;
        if ((code.textContent ?? '').replace(/[\u200b\ufeff]/g, '') === '') {
          if (after && after.nodeType === 3 && (after as Text).data.startsWith(ZWSP)) (after as Text).deleteData(0, 1);
          const parent = code.parentNode!;
          const idx = Array.prototype.indexOf.call(parent.childNodes, code) as number;
          code.remove();
          placeCaret(parent, idx);
        } else if (after && after.nodeType === 3) placeCaret(after, (after as Text).data.startsWith(ZWSP) ? 1 : 0);
        else { const z = doc.createTextNode(ZWSP); code.after(z); cur.spacers.push(z); placeCaret(z, 1); }   // (P-A)
        schedule();
        return;
      }
      const off = saveCaret(cur.el);
      code.replaceWith(doc.createTextNode(code.textContent ?? ''));
      cur.el.normalize();
      if (off !== null) setCaretAtOffset(cur.el, off);
      if (cur.openCode === code) cur.openCode = null;
      schedule();
      return;
    }
    // Built with the DOM, never insertHTML: Chrome bakes computed styles into inserted markup.
    const range = at.range;
    const text = range.toString();
    if (!range.collapsed) range.deleteContents();
    const el = doc.createElement('code');
    const inner = doc.createTextNode(text === '' ? ZWSP : text);
    el.appendChild(inner);
    range.insertNode(el);
    // A zero-width space after the span gives the caret a place outside the code (stripped when serialized).
    const z = doc.createTextNode(ZWSP);
    el.after(z);
    cur.spacers.push(z);                         // (P-A: helpers of the session)
    if (text === '') cur.spacers.push(inner);
    if (text === '') {
      // Collapsed: what is typed next goes INSIDE the code (after its zero-width space); → or ⌘E leaves it.
      placeCaret(inner, 1);
      cur.openCode = el;
    } else placeCaret(z, 1);
    schedule();
  }

  function openLinkUi(cur: Session): void {
    const at = selectionIn(cur.el);
    if (!at || inCode(at.node, cur.el)) return;
    closeLinkUi(false);
    const range = at.range.cloneRange();
    const existing = closestIn(at.node, 'a[href]', cur.el);
    const box = doc.createElement('div');
    box.className = 'mdr-preview__link-input';
    box.setAttribute('data-mdr-ui', '');
    const input = doc.createElement('input');
    input.type = 'url';
    input.placeholder = LINK_PLACEHOLDER;
    input.value = existing?.getAttribute('href') ?? '';
    box.appendChild(input);
    const rr = range.getBoundingClientRect?.();
    const base = root.getBoundingClientRect();
    const top = (rr && rr.height + rr.width > 0 ? rr.bottom : base.top + 40) - base.top + root.scrollTop + 6;
    const left = Math.max(8, (rr && rr.width + rr.height > 0 ? rr.left : base.left + 40) - base.left + root.scrollLeft);
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
    root.appendChild(box);
    linkUi = { box, range };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); closeLinkUi(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkUi(false); }
    });
    input.addEventListener('blur', () => { if (linkUi?.box === box) win.setTimeout(() => { if (linkUi?.box === box) closeLinkUi(false); }, 0); });
    input.focus({ preventScroll: true });
  }

  /** A collapsed caret gets a link whose text is the URL: typed as text, then linked — never insertHTML,
   *  which makes Chrome copy the surrounding computed style onto the `<a>` (finding high 3). */
  function insertLinkAtCaret(cur: Session, url: string): void {
    const sel = doc.getSelection();
    if (!sel) return;
    if (exec('insertText', url)) {
      const at = selectionIn(cur.el);
      if (at && at.node.nodeType === 3) {
        const t = at.node as Text;
        const end = at.sel.focusOffset;
        if (end >= url.length && t.data.slice(end - url.length, end) === url) {
          const r = doc.createRange();
          r.setStart(t, end - url.length);
          r.setEnd(t, end);
          sel.removeAllRanges();
          sel.addRange(r);
          if (exec('createLink', url)) {
            sel.collapseToEnd();
            // the caret goes after the link, so what is typed next is not part of it
            const made = sel.focusNode ? closestIn(sel.focusNode, 'a[href]', cur.el) : null;
            if (made) {
              const after = doc.createRange();
              after.setStartAfter(made);
              after.collapse(true);
              sel.removeAllRanges();
              sel.addRange(after);
            }
            return;
          }
          sel.collapseToEnd();
          r.deleteContents();                    // no createLink: take the text out again, insert below
        }
      }
    }
    const at = selectionIn(cur.el);
    if (!at) return;
    const a = doc.createElement('a');
    a.setAttribute('href', url);
    a.textContent = url;
    at.range.collapse(true);
    at.range.insertNode(a);
    const r = doc.createRange();
    r.setStartAfter(a);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** Drops a `style` the browser baked onto an element the session created (U5); the document's own
   *  styled elements carry `data-mdr-o` from the session start. */
  function scrubStyles(el: Element): void {
    for (const e of Array.from(el.querySelectorAll('[style]'))) if (!e.hasAttribute('data-mdr-o')) e.removeAttribute('style');
  }

  function closeLinkUi(apply: boolean): void {
    const ui = linkUi;
    if (!ui) return;
    linkUi = null;
    const url = (ui.box.querySelector('input')?.value ?? '').trim();
    ui.box.remove();
    const cur = s;
    if (!cur) return;
    cur.el.focus({ preventScroll: true });
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(ui.range);
    if (!apply) return;
    noteUser(url);                               // (THE GUARD: the URL becomes the link's text at a collapsed caret)
    const inLink = closestIn(ui.range.startContainer, 'a[href]', cur.el);
    if (url === '') { if (inLink) { const r = doc.createRange(); r.selectNodeContents(inLink); sel?.removeAllRanges(); sel?.addRange(r); exec('unlink'); } }
    else if (inLink && ui.range.collapsed) inLink.setAttribute('href', url);
    else if (ui.range.collapsed) insertLinkAtCaret(cur, url);
    else exec('createLink', url);
    scrubStyles(cur.el);
    schedule();
  }

  function onKeyDown(e: KeyboardEvent): void {
    const cur = s;
    if (!cur || !(e.target instanceof Node) || !cur.el.contains(e.target)) return;
    if (e.isComposing || e.keyCode === 229) return;
    const at = selectionIn(cur.el);
    const code = at ? inCode(at.node, cur.el) : false;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); return; }
    if (e.key === 'Enter') { onEnter(e, cur); return; }
    if (e.key === 'Tab') { onTab(e, cur); return; }
    if (cur.gone) {
      // U18 (a): no deletion key reaches the source from an emptied element (word / line variants included)
      const cmd = editCmdOf(e);
      const back = e.key === 'Backspace' || cmd === 'delBack' || cmd === 'delWordBack' || cmd === 'delLineBack';
      if (back || e.key === 'Delete' || cmd === 'delFwd' || cmd === 'delWordFwd' || cmd === 'delLineFwd' || cmd === 'delParaFwd') {
        if (goneKey(cur, back)) e.preventDefault();
        return;
      }
    }
    if (e.key === 'Backspace' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (tryMergeBackward(cur)) e.preventDefault();
      else dropFreshBox(cur);
      return;
    }
    // U21: Home / End go to the start / end of the line (what a replayed Home / End does, and the editor pane);
    // Chromium on macOS only scrolls for them
    if ((e.key === 'Home' || e.key === 'End') && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const sel = doc.getSelection() as (Selection & { modify?: (a: string, d: string, g: string) => void }) | null;
      if (sel?.modify) {
        e.preventDefault();
        sel.modify(e.shiftKey ? 'extend' : 'move', e.key === 'Home' ? 'backward' : 'forward', 'lineboundary');
      }
      return;
    }
    if (src?.history && (matchShortcut(e, 'Mod-z') || matchShortcut(e, 'Mod-Shift-z') || (!IS_MAC && matchShortcut(e, 'Mod-y')))) {
      e.preventDefault();
      e.stopPropagation();
      runHistory(!matchShortcut(e, 'Mod-z'), cur);
      return;
    }
    if (matchShortcut(e, 'Mod-b') || matchShortcut(e, 'Mod-i') || matchShortcut(e, 'Mod-u')) {
      e.preventDefault();
      if (!code && !matchShortcut(e, 'Mod-u')) { exec(matchShortcut(e, 'Mod-b') ? 'bold' : 'italic'); scrubStyles(cur.el); schedule(); }
      return;
    }
    if (matchShortcut(e, 'Mod-e')) { e.preventDefault(); e.stopPropagation(); toggleInlineCode(cur); return; }
    if (matchShortcut(e, 'Mod-k')) { e.preventDefault(); e.stopPropagation(); openLinkUi(cur); return; }
    // U7: ⌘A selects the block's content (the browser's own select-all inside the editing host); ⌘A again,
    // with that content already fully selected, ends the session and selects the whole preview.
    if (matchShortcut(e, 'Mod-a') && at && blockFullySelected(cur.el, at.range)) {
      e.preventDefault();
      e.stopPropagation();
      selectAllKey(cur, at.sel);
    }
  }

  function blockFullySelected(el: Element, range: Range): boolean {
    if (visibleLength(el) === 0) return true;    // an emptied block: nothing more to select in it
    if (range.collapsed || !el.contains(range.startContainer) || !el.contains(range.endContainer)) return false;
    // H22: the line break that ends a code block's text is no content the browser's select-all selects
    const texts = visibleTexts(el);
    const last = texts[texts.length - 1];
    const full = visibleLength(el) - (last && last.data.endsWith('\n') && last.parentElement?.closest('pre') ? 1 : 0);
    return textOffsetOf(el, range.startContainer, range.startOffset) === 0
      && textOffsetOf(el, range.endContainer, range.endOffset) >= full;
  }

  /** ⌘S and the other global shortcuts run in a window-capture listener: commit first so they see the text. */
  function onWindowKey(e: KeyboardEvent): void {
    if (s && (e.metaKey || e.ctrlKey) && !s.composing && !e.isComposing) flush();
  }

  // ---------------------------------------------------------------- events
  let toggle: { input: HTMLInputElement; want: boolean } | null = null;

  // U7 — pointer and selection. The press is the browser's (caret, drag selection, double / triple click);
  // a session starts when the primary button is RELEASED in the block it went down in, with no modifier,
  // and the selection is collapsed or inside that block. A press outside the session's block ends the
  // session at once (pending text written), but what that end does to the DOM waits until after the
  // click, so nothing moves under the pointer between press and release.
  function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const t = e.target instanceof Element ? e.target : null;
    if (linkUi && t && linkUi.box.contains(t)) return;
    const w = t?.closest<HTMLElement>('section.md-block') ?? null;
    const cur = s;
    press = null;
    pointerDown = true;
    keptSel = null;                              // (U20) the user makes a new selection
    if (deferTimer) { clearTimeout(deferTimer); deferTimer = 0; }
    if (cur && w === cur.el) {
      const box = t!.closest('input[type="checkbox"]') as HTMLInputElement | null;
      if (box) { toggle = { input: box, want: !box.checked }; e.preventDefault(); return; }
      const m = t!.closest<HTMLElement>('.md-math');
      if (m && cur.el.contains(m)) { e.preventDefault(); const ed = mathToSource(m); if (ed) { caretToEnd(ed); schedule(); } return; }
      const img = t!.closest('img');
      if (img && cur.el.contains(img) && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        // U21: a press on an image puts the caret before or after it (the browser would start dragging the image)
        e.preventDefault();
        const r = caretAtImage(img, e);
        placeCaret(r.startContainer, r.startOffset);
        return;
      }
      dragFrom = cur;                            // a drag that leaves the block ends the session (onMouseMove)
      return;
    }
    end();                                       // also drops a resume still waiting from a split
    if (!editable || !src || !w || !root.contains(w) || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (t!.closest('input[type="checkbox"]')) return;   // outside a session a checkbox just toggles
    // Outside a session a link is still a link: the click navigates (interactions.ts). Once the block is being
    // edited, clicking a link places the caret instead (⌘-click opens) — CONTRACT §11 "while editing".
    if (t!.closest('a[href]')) return;
    if (!host.blockOfElement(w)) return;
    press = { w, target: t! };
  }

  /** A drag that started in the session's block and leaves it: the session ends (pending text written, the
   *  wrapper no longer an editing host) and the browser's selection goes on across the other blocks; the
   *  block re-renders after the release (the selection's start stays where it is meanwhile). */
  function onMouseMove(e: MouseEvent): void {
    const cur = dragFrom;
    if (!cur) return;
    if (s !== cur || !(e.buttons & 1)) { dragFrom = null; return; }
    if (e.target instanceof Node && cur.el.contains(e.target)) return;
    dragFrom = null;
    end();
  }

  function onMouseUp(e: MouseEvent): void {
    if (e.button !== 0) return;
    const p = press;
    press = null;
    dragFrom = null;
    if (pointerDown) {
      pointerDown = false;
      // After the click (dispatched right after this mouseup): the DOM change a session end held back.
      if (deferred && !deferTimer) deferTimer = win.setTimeout(() => { deferTimer = 0; releaseDeferred(); }, 0);
    }
    if (!p || s || resume || !editable || !src || disposed) return;
    const w = p.w;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('section.md-block') !== w || !w.isConnected || !root.contains(w)) return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const info = host.blockOfElement(w);
    if (!info) return;
    const sel = clickSelection(w, p.target, e);
    if (!sel) return;                            // the selection reaches beyond the block: no session
    if (currentWrapper(info) === w) {            // (P-B)
      startOn(w, info, sel);
      return;
    }
    // A write of ours (the session this press ended) is still on its way through the worker, or the block's
    // new HTML is (its re-render after a session ended, U19): the click waits for the structure and the mount,
    // keys typed meanwhile are queued (U4). P-F: within the history resume's bound (RESUME_MS, extended while the
    // block's re-render is known to be on its way — armResumeTimer).
    const r: Resume = {
      startLine: info.startLine, contains: false, lineCount: null, offset: sel.anchor, pos: null,
      until: performance.now() + RESUME_MS, expected: null, minVersion: sourceVersion(), matchSource: false,
      click: { id: info.id, sel }, waits: 0,
    };
    startResume(r, w);
  }

  /** The browser's selection at the release, when it allows a session in `w` (collapsed anywhere, or inside
   *  `w`); null when it reaches beyond the block. A collapsed selection outside `w` (padding, an empty area)
   *  becomes the caret position under the pointer. */
  function clickSelection(w: HTMLElement, target: Element, e: MouseEvent): ClickSel | null {
    const sel = doc.getSelection();
    const m = target.closest<HTMLElement>('.md-math');
    const math = m && w.contains(m) ? m : null;
    const img = target.closest('img');
    const now = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (img && w.contains(img) && (!now || now.collapsed || !w.contains(now.startContainer) || !w.contains(now.endContainer))) {
      // U21: the browser moves no caret for a click on an image: it goes before or after it (the half clicked; a
      // drag that ended on it keeps its selection)
      const range = caretAtImage(img, e);
      const off = textOffsetOf(w, range.startContainer, range.startOffset);
      return { range, backward: false, anchor: off, focus: off, math: null };
    }
    let range: Range | null = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    let backward = false;
    if (range && !range.collapsed) {
      if (!w.contains(range.startContainer) || !w.contains(range.endContainer)) return null;
      backward = !!sel && sel.anchorNode === range.endContainer && sel.anchorOffset === range.endOffset
        && !(sel.focusNode === range.endContainer && sel.focusOffset === range.endOffset);
    } else if (!range || !w.contains(range.startContainer)) {
      const fromPoint = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
      range = fromPoint && w.contains(fromPoint.startContainer) ? fromPoint : null;
    }
    const a = range ? textOffsetOf(w, range.startContainer, range.startOffset) : visibleLength(w);
    const b = range ? textOffsetOf(w, range.endContainer, range.endOffset) : a;
    return { range, backward, anchor: backward ? b : a, focus: backward ? a : b, math };
  }

  /** U21: a collapsed range before `img`, or after it when the pointer is on its right half. */
  function caretAtImage(img: Element, e: MouseEvent): Range {
    const box = img.getBoundingClientRect();
    const r = doc.createRange();
    if (e.clientX > box.left + box.width / 2) r.setStartAfter(img); else r.setStartBefore(img);
    r.collapse(true);
    return r;
  }

  /** P-F amended: the user turned elsewhere — a pointer press outside the preview (a press inside it ends every wait
   *  through onMouseDown) or, for a waiting checkbox click, anywhere but on that checkbox; the focus arriving in any
   *  element but the one that holds it for the wait. The waits then ask waitWanted at once. */
  function onAwayPress(e: Event): void {
    settleClipboard();                           // (P-A: before anything else reaches the page)
    const t = e.target instanceof Node ? e.target : null;
    if ((resume && !(t && root.contains(t))) || (pendingToggle && t !== pendingToggle.input)) { turnedAway = true; checkWaits(); }
  }
  function onAwayFocus(e: FocusEvent): void {
    const t = e.target;
    if ((resume && t !== cap) || (pendingToggle && t !== pendingToggle.input)) { turnedAway = true; checkWaits(); }
  }
  /** Every wait asks waitWanted; one no longer wanted is abandoned (P-G: the queued input's toast; U16: the toggle's). */
  function checkWaits(): void {
    if (resume && !waitWanted()) cancelResume();
    if (pendingToggle && !waitWanted()) giveUpToggle();
  }

  /** Window blur / a drag-and-drop that swallowed the release: no click follows, nothing waits for it. */
  function onPointerGone(): void {
    press = null;
    dragFrom = null;
    if (!pointerDown) return;
    pointerDown = false;
    releaseDeferred();
  }

  function onClick(e: MouseEvent): void {
    if (replayingClick) return;
    const tg = toggle;
    if (tg && e.target === tg.input) {
      toggle = null;
      e.preventDefault();
      // The browser reverts a cancelled checkbox click after dispatch; set the state once it has.
      win.setTimeout(() => {
        tg.input.checked = tg.want;
        if (tg.want) tg.input.setAttribute('checked', ''); else tg.input.removeAttribute('checked');
        schedule();
      }, 0);
      return;
    }
    // U16 amended: a task checkbox outside a session whose block is one a session has just released, its re-render
    // not mounted (taskLine 'wait': as amended a second time, every other click is applied at once or cancelled by
    // interactions, and none waits with the switch off): the click waits — bounded as a click waits — and is then
    // applied to the task the user clicked (replayToggle), whatever element shows it by then. (A host without versions
    // or without taskLine, the unit tests' Sims: whenever the block is not current, counting our writes, as before.)
    const box = e.target;
    if (editable && box instanceof HTMLInputElement && box.type === 'checkbox' && !(s && s.el.contains(box))) {
      const info = host.blockOfElement(box);
      if (info && (host.taskLine && versioned() ? host.taskLine(box) === 'wait' : !currentWrapper(info))) {
        e.preventDefault();
        if (pendingToggle) giveUpToggle();      // (one waits at a time: an earlier one is told)
        const w = host.elementOfBlock(info.id);
        const boxes = w ? taskBoxes(w) : [];
        pendingToggle = { input: box, id: info.id, startLine: info.startLine, ordinal: boxes.indexOf(box), texts: boxes.map(taskText), waits: 0 };
        turnedAway = false;
        armToggleTimer();
      }
    }
  }

  /** U16 amended: the wait of a checkbox click is bounded as a click's (RESUME_MS, extended MOUNT_WAIT_EXTENSIONS times
   *  while the structure is known to be behind or the block's re-render is on its way); then nothing changes and a
   *  toast says so. (interactions.ts REPLAY_MS is longer than this bound.) */
  function armToggleTimer(): void {
    if (toggleTimer) clearTimeout(toggleTimer);
    toggleTimer = win.setTimeout(function expire() {
      toggleTimer = 0;
      const t = pendingToggle;
      if (!t) return;
      if (t.waits < MOUNT_WAIT_EXTENSIONS && host.blockInfo(t.id) !== null && (!caughtUp() || host.renderPending?.(t.id) === true)) {
        t.waits++;
        toggleTimer = win.setTimeout(expire, RESUME_MS);
        return;
      }
      giveUpToggle();
    }, RESUME_MS);
  }
  /** U16 amended: a waiting checkbox click that is not applied (its task not identified with certainty, the wait over,
   *  abandoned): nothing changes, and the user is told. */
  function giveUpToggle(): void {
    if (!pendingToggle) return;
    pendingToggle = null;
    if (toggleTimer) { clearTimeout(toggleTimer); toggleTimer = 0; }
    bus.emit('toast', { text: TASK_NOT_TICKED_TEXT, timeoutMs: 4000 });
  }

  /** U16 amended — replays a waiting checkbox click once its block shows its current source (P-B), on the task the
   *  user clicked, identified by its place among the block's tasks and its text (taskOf), never by the DOM node the
   *  click hit (a re-render replaced it). The block: by its id, else the block at its place. */
  function replayToggle(): void {
    const tg = pendingToggle;
    if (!tg) return;
    if (!waitWanted()) { giveUpToggle(); return; }     // (P-F amended: the user turned elsewhere)
    const info = host.blockInfo(tg.id) ?? host.blockAtLine(tg.startLine);
    const w = info ? currentWrapper(info) : null;
    if (!w) return;                              // not yet: the timer bounds the wait
    const box = taskOf(w, tg);
    if (!box) { giveUpToggle(); return; }
    pendingToggle = null;
    if (toggleTimer) { clearTimeout(toggleTimer); toggleTimer = 0; }
    replayingClick = true;
    try { box.click(); } finally { replayingClick = false; }
  }

  function onInput(e: Event): void {
    const cur = s;
    if (!cur || !(e.target instanceof Node) || !cur.el.contains(e.target)) return;
    if ((e as InputEvent).isComposing || cur.composing) return;
    schedule();
    if (!caretRaf) caretRaf = requestAnimationFrame(trackCaret);
  }

  function onBeforeInput(e: InputEvent): void {
    const cur = s;
    if (!cur || !(e.target instanceof Node) || !cur.el.contains(e.target)) return;
    if (e.inputType.startsWith('insert')) noteUser(e.data ?? e.dataTransfer?.getData('text/plain'));   // (THE GUARD)
    if (e.inputType === 'formatUnderline' || e.inputType === 'insertFromDrop' || e.inputType === 'formatFontName') e.preventDefault();
    // The browser's own undo stack is not used when the source has a history (U1): the session's ⌘Z
    // handler runs it; the edit menu's 撤销 arrives here as historyUndo.
    else if (src?.history && (e.inputType === 'historyUndo' || e.inputType === 'historyRedo')) {
      e.preventDefault();
      runHistory(e.inputType === 'historyRedo', cur);
    }
  }

  function onCompositionStart(e: CompositionEvent): void {
    if (s && e.target instanceof Node && s.el.contains(e.target)) s.composing = true;
  }

  function onCompositionEnd(e: CompositionEvent): void {
    if (s && e.target instanceof Node && s.el.contains(e.target)) {
      noteUser(e.data);                          // (THE GUARD)
      s.composing = false;
      schedule();
    }
  }

  /** Plain text at the caret (CONTRACT §11 paste). In code every line break is a real newline (U6); in
   *  prose a line break is a hard break and a blank line starts a new paragraph where one can start.
   *  U8: refused (nothing inserted, a toast) when the block's source would grow past MAX_EDIT_CHARS; else the
   *  pasted text goes in as one DOM insertion (a browser editing command per line made a long paste quadratic). */
  function pasteText(text: string, cur: Session): void {
    noteUser(text);                              // (THE GUARD: a paste, direct or replayed after a resume)
    const at = selectionIn(cur.el);
    if (!at) return;
    const code = inCode(at.node, cur.el);
    // What the source would hold: the block now, less what the paste replaces, plus the text (a line break in
    // prose is written as a hard break "  \n").
    const now = Math.max(cur.baseline.length, visibleLength(cur.el));
    const replaced = at.range.collapsed ? 0 : at.range.toString().length;
    const breaks = code ? 0 : text.length - text.replace(/\n/g, '').length;
    if (now - replaced + text.length + 2 * breaks > MAX_EDIT_CHARS) {
      bus.emit('toast', { text: PASTE_TOO_LONG_TEXT, timeoutMs: 4000 });
      return;
    }
    if (closestIn(at.node, 'code.md-math-src', cur.el)) { exec('insertText', text.replace(/\n+/g, ' ')); schedule(); return; }
    // The selection the paste replaces goes the way TYPING over it goes (a selection across paragraphs joins them):
    // U19 — the delete command's "smart delete" took the space before a double-clicked word, and a space it left
    // beside another became a non-breaking one. A zero-width space is typed over the selection instead (Chrome's
    // typing path) and marks where typed text would go: P-A (J1) — the pasted text goes exactly there (inside a link,
    // bold, italic, code or strikethrough whose whole text was selected, as typing puts it), and the placeholder goes
    // again: no placeholder stays, no inline element is left without text.
    let ph: Text | null = null;
    let phAt = 0;
    if (!at.range.collapsed) {
      exec('insertText', ZWSP);
      const done = doc.getSelection();
      const n = done && done.rangeCount > 0 ? done.focusNode : null;
      const k = done ? done.focusOffset : 0;
      if (n && n.nodeType === 3 && k > 0 && (n as Text).data[k - 1] === ZWSP) {
        ph = n as Text;
        phAt = k - 1;
        placeCaret(ph, k);                       // (directly after the placeholder, where typing continues)
      }
    }
    /** The inline elements around the placeholder (and their clones a paragraph split makes): removed when the paste
     *  leaves them without text. */
    const around: Element[] = [];
    for (let e = ph?.parentElement ?? null; e && e !== cur.el && cur.el.contains(e) && !e.matches(LINE_BOX); e = e.parentElement) around.push(e);
    try {
      pasteAt(text, cur, code, ph !== null, around);
    } finally {
      // (the insertion went after the placeholder: the text before it, the placeholder included, stays in `ph`)
      if (ph && ph.isConnected && ph.data[phAt] === ZWSP) {
        ph.deleteData(phAt, 1);
        if (ph.data === '') ph.remove();
      }
      for (const e of around) if (e.isConnected && !hasContent(e) && !e.querySelector('br')) e.remove();
    }
  }

  /** pasteText's insertion at the caret (`replaced`: a placeholder typed over a selection marks where the text goes). */
  function pasteAt(text: string, cur: Session, code: boolean, replaced: boolean, around: Element[]): void {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    if (!cur.el.contains(range.startContainer)) return;
    if (code) {
      // One text node: every newline stays a newline; at the very end of the code a newline needs a second one
      // to show (what the browser's own line break does there).
      const pre = closestIn(range.startContainer, 'pre, .md-math-src', cur.el);
      const after = doc.createRange();
      after.setStart(range.startContainer, range.startOffset);
      if (pre) after.setEnd(pre, pre.childNodes.length);
      const t = doc.createTextNode(text.endsWith('\n') && pre && after.toString() === '' ? text + '\n' : text);
      range.insertNode(t);
      placeCaret(t, text.length);
      revealCaret();
      schedule();
      return;
    }
    if (!replaced) avoidLinkEdge(range, cur.el);  // (J1: a replaced selection's place is where typing goes)
    // Blank lines separate paragraphs; leading / trailing ones carry nothing (a blank line written as two
    // hard breaks left a line holding only "  " in the source — low finding).
    const paras = text.split(/\n(?:[ \t]*\n)+/).filter((q, k, all) => q !== '' || (k > 0 && k < all.length - 1));
    if (paras.length === 0) return;
    // A caret directly in the wrapper (an emptied block): the pasted paragraphs start in a paragraph of their own.
    if (paras.length > 1 && !closestIn(range.startContainer, 'p, li, td, th, h1, h2, h3, h4, h5, h6, pre', cur.el)) {
      const p0 = doc.createElement('p');
      range.insertNode(p0);
      range.setStart(p0, 0);
      range.collapse(true);
    }
    const p = closestIn(range.startContainer, 'p', cur.el);
    const canSplit = !!p && (p.parentElement === cur.el || p.parentElement?.tagName === 'BLOCKQUOTE') && !closestIn(range.startContainer, 'li, td, th', cur.el);
    /** A paragraph's lines: text nodes with a <br> between them. */
    const linesOf = (q: string, f: DocumentFragment): void => {
      q.split('\n').forEach((l, i) => {
        if (i > 0) f.appendChild(doc.createElement('br'));
        if (l) f.appendChild(doc.createTextNode(l));
      });
    };
    const head = doc.createDocumentFragment();
    if (canSplit) linesOf(paras[0], head);
    else paras.forEach((q, k) => { if (k > 0) head.appendChild(doc.createElement('br')); linesOf(q, head); });
    let last: Node | null = head.lastChild;
    if (last) range.insertNode(head);
    if (canSplit && paras.length > 1) {
      // The rest of the caret's paragraph moves to the end of the last pasted one.
      const tail = doc.createRange();
      if (last) tail.setStartAfter(last); else tail.setStart(range.startContainer, range.startOffset);
      tail.setEnd(p!, p!.childNodes.length);
      const rest = tail.extractContents();
      for (let n = rest.firstChild; n && n.nodeType === 1; n = n.firstChild) around.push(n as Element);   // (J1: split clones)
      let prev: HTMLElement = p!;
      for (let k = 1; k < paras.length; k++) {
        const np = doc.createElement('p');
        const f = doc.createDocumentFragment();
        linesOf(paras[k], f);
        last = f.lastChild;
        np.appendChild(last ? f : doc.createElement('br'));
        prev.after(np);
        prev = np;
      }
      prev.appendChild(rest);
      for (const e of [p!, prev]) if (!hasContent(e) && !e.querySelector('br')) e.appendChild(doc.createElement('br'));
      pasteSplit = true;
      if (!last) { placeCaret(prev, 0); revealCaret(); schedule(); return; }
    }
    if (!last) { schedule(); return; }
    if (last.nodeType === 3) placeCaret(last, (last as Text).data.length);
    else {
      // A line break that ends its line box shows only with a second one after it (the browser's own way).
      if (nothingAfter(last, cur.el)) last.parentNode!.insertBefore(doc.createElement('br'), last.nextSibling);
      placeCaretAfter(last);
    }
    revealCaret();
    schedule();
  }

  /** Scrolls the preview so the caret shows (what the browser's own editing commands do after an insertion). */
  function revealCaret(): void {
    try {
      const sel = doc.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      let box: DOMRect | null = r.getBoundingClientRect?.() ?? null;
      if (!box || box.width + box.height === 0) {
        const n = r.startContainer;
        const e = n.nodeType === 1 ? (n as Element).childNodes[r.startOffset - 1] ?? n : n.parentElement;
        box = (e && e.nodeType === 1 ? (e as Element) : (e?.parentElement ?? null))?.getBoundingClientRect?.() ?? null;
      }
      if (!box || box.width + box.height === 0) return;
      const view = root.getBoundingClientRect();
      if (box.bottom > view.bottom - 8) root.scrollTop += box.bottom - view.bottom + 8;
      else if (box.top < view.top + 8) root.scrollTop -= view.top + 8 - box.top;
    } catch { /* layout unavailable */ }
  }

  /** The browser types next to a link, not into it, when the caret sits on the link's edge. */
  function avoidLinkEdge(range: Range, el: Element): void {
    const a = closestIn(range.startContainer, 'a', el);
    if (!a) return;
    const before = doc.createRange();
    before.setStart(a, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = doc.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(a, a.childNodes.length);
    if (after.toString() === '') { range.setStartAfter(a); range.collapse(true); }
    else if (before.toString() === '') { range.setStartBefore(a); range.collapse(true); }
  }

  /** Nothing shows after `n` up to the end of its line container (paragraph, item, cell, heading). */
  function nothingAfter(n: Node, el: Element): boolean {
    for (let x: Node | null = n; x && x !== el; x = x.parentNode) {
      if (x.nodeType === 1 && /^(P|LI|TD|TH|H[1-6]|BLOCKQUOTE|DIV)$/.test((x as Element).tagName) && x !== n) return true;
      for (let sib = x.nextSibling; sib; sib = sib.nextSibling) {
        if (hasContent(sib) || (sib.nodeType === 1 && /^(BR|UL|OL)$/.test((sib as Element).tagName))) return false;
      }
    }
    return true;
  }

  function onPaste(e: ClipboardEvent): void {
    const cur = s;
    if (!cur || !(e.target instanceof Node) || !cur.el.contains(e.target)) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
    if (!text) return;
    pasteText(text, cur);
  }

  function onDrop(e: DragEvent): void {
    if (s && e.target instanceof Node && s.el.contains(e.target)) e.preventDefault();
  }

  function onFocusOut(e: FocusEvent): void {
    const cur = s;
    if (!cur || !(e.target instanceof Node) || !cur.el.contains(e.target)) return;
    win.setTimeout(() => {
      if (s !== cur || linkUi) return;
      const a = doc.activeElement;
      if (a && cur.el.contains(a)) return;
      if (!doc.hasFocus()) return;      // the window lost focus (app switch): keep the session
      end();
    }, 0);
  }

  function onSelectionChange(): void {
    if (s && !caretRaf) caretRaf = requestAnimationFrame(trackCaret);
  }

  root.addEventListener('mousedown', onMouseDown, true);
  root.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('input', onInput);
  root.addEventListener('beforeinput', onBeforeInput as EventListener);
  root.addEventListener('compositionstart', onCompositionStart as EventListener);
  root.addEventListener('compositionend', onCompositionEnd as EventListener);
  root.addEventListener('paste', onPaste);
  root.addEventListener('drop', onDrop);
  root.addEventListener('focusout', onFocusOut);
  doc.addEventListener('selectionchange', onSelectionChange);
  win.addEventListener('keydown', onWindowKey, true);
  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('mousemove', onMouseMove, true);
  doc.addEventListener('dragend', onPointerGone, true);
  win.addEventListener('blur', onPointerGone);
  doc.addEventListener('mousedown', onAwayPress, true);
  doc.addEventListener('pointerdown', onAwayPress, true);
  doc.addEventListener('focusin', onAwayFocus, true);
  doc.addEventListener('copy', onClipboard as EventListener, true);
  for (const ty of ['keydown', 'beforeinput', 'compositionstart', 'paste']) doc.addEventListener(ty, settleClipboard, true);
  doc.addEventListener('cut', onClipboard as EventListener, true);
  doc.addEventListener('dragstart', onClipboard as EventListener, true);
  // G16: a new document (App emits this after every setDoc). Nothing of the old one continues in it: no
  // resume (its queued keys), no waiting click or toggle, no session (App ends it before setDoc; a leftover
  // one is dropped, not written), and blocks refused in the old document are not remembered.
  const offDocLoaded = bus.on('doc:loaded', () => {
    cancelResume();
    giveUpToggle();
    press = null;
    dragFrom = null;
    refusedAt.clear();
    userPut.clear();                             // (THE GUARD)
    userAll.clear();
    const cur = s;
    if (cur) teardown(cur);
    releaseDeferred(true);
    keptSel = null;                              // (U20: nothing of the old document's selection is put back)
  });

  return {
    setEditable(on) {
      editable = on && !!src;
      if (!editable) { end(); cancelResume(); }
    },
    isEditable: () => editable,
    activeId: () => (s ? s.id : null),
    end,
    flush() { if (raf) { cancelAnimationFrame(raf); raf = 0; } flush(); },
    afterStructure() {
      if (s) retrack();
      tryResume();
      replayToggle();
    },
    afterMount(id) { restoreKept(id); tryResume(); replayToggle(); },
    keepsRemoved: (id, v) => !!(s && s.id === id && s.gone && (v === undefined || v >= s.goneVersion)),
    isEditingTarget: (el) => !!(s && el && s.el.contains(el)),
    isResuming: () => resume !== null,
    dispose() {
      if (disposed) return;
      end();
      cancelResume();
      releaseDeferred(true);
      disposed = true;
      if (caretRaf) cancelAnimationFrame(caretRaf);
      if (deferTimer) clearTimeout(deferTimer);
      if (toggleTimer) clearTimeout(toggleTimer);
      offDocLoaded();
      doc.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('mousemove', onMouseMove, true);
      doc.removeEventListener('dragend', onPointerGone, true);
      win.removeEventListener('blur', onPointerGone);
      doc.removeEventListener('mousedown', onAwayPress, true);
      doc.removeEventListener('pointerdown', onAwayPress, true);
      doc.removeEventListener('focusin', onAwayFocus, true);
      doc.removeEventListener('copy', onClipboard as EventListener, true);
      for (const ty of ['keydown', 'beforeinput', 'compositionstart', 'paste']) doc.removeEventListener(ty, settleClipboard, true);
      if (helpersTimer) clearTimeout(helpersTimer);
      doc.removeEventListener('cut', onClipboard as EventListener, true);
      doc.removeEventListener('dragstart', onClipboard as EventListener, true);
      root.removeEventListener('mousedown', onMouseDown, true);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('beforeinput', onBeforeInput as EventListener);
      root.removeEventListener('compositionstart', onCompositionStart as EventListener);
      root.removeEventListener('compositionend', onCompositionEnd as EventListener);
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('selectionchange', onSelectionChange);
      win.removeEventListener('keydown', onWindowKey, true);
      cap.removeEventListener('beforeinput', onCapBeforeInput as EventListener);
      cap.removeEventListener('compositionstart', onCapCompositionStart);
      cap.removeEventListener('compositionend', onCapCompositionEnd as EventListener);
      cap.removeEventListener('paste', onCapPaste);
      cap.removeEventListener('input', onCapInput);
      cap.remove();
      hint.remove();
    },
  };
}
