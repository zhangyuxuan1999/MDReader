// src/shared/types.ts — FROZEN. Changes require a PR touching only src/shared, approved by all four engineers.
import type { EditorView } from '@codemirror/view';

// ---------------------------------------------------------------- primitives
export type Mode = 'edit' | 'split' | 'preview';
export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
/** Lines are 1-based everywhere (CodeMirror convention). Block indices are 0-based. Columns are 0-based. */
export type Line = number;

/** One replacement in ORIGINAL (pre-transaction) document offsets, exactly as ChangeSet.iterChanges yields it.
 *  A TextChange[] is ascending and non-overlapping. Consumers MUST apply it in REVERSE array order. */
export interface TextChange { from: number; to: number; insert: string }

export const BlockKind = { Prose: 0, Heading: 1, Code: 2, Table: 3, List: 4, Quote: 5, Html: 6, Math: 7, Hr: 8 } as const;
export type BlockKind = (typeof BlockKind)[keyof typeof BlockKind];

/** Structure array: Int32Array, BLOCK_STRIDE ints per block, document order, tiling the document:
 *  startLine[0] === 1, startLine[i+1] === startLine[i] + lineCount[i], sum(lineCount) === doc lineCount. */
export const BLOCK_STRIDE = 4;
export const B_ID = 0, B_START = 1, B_LINES = 2, B_KIND = 3;

export interface OutlineEntry { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; slug: string; line: Line; blockId: number }
export interface DocStats { chars: number; charsNoSpace: number; cjk: number; latinWords: number; lines: number; readingMinutes: number }
export interface RenderOptions {
  math: boolean; highlight: boolean; linkify: boolean; breaks: boolean;
  maxHighlightChars: number;   // fence longer than this: escaped, no hljs (default 30000)
  maxHtmlChars: number;        // block source longer than this: rendered as HTML_FLAG_PLAIN text (default 200000)
}
export const DEFAULT_RENDER_OPTIONS: RenderOptions = { math: true, highlight: true, linkify: true, breaks: false, maxHighlightChars: 30000, maxHtmlChars: 200000 };

// ---------------------------------------------------------------- html batches (transferable)
/** Payload is raw source text (block too large to render). Code-kind blocks mount as
 *  <pre class="md-code md-code--plain"><code>, every other kind as <p class="md-plain"> pieces of <= 64 KB, all via
 *  textContent; the preview adds a small note (.md-plain__note) telling the user the block is shown as plain text. */
export const HTML_FLAG_PLAIN = 1;
/** Payload was produced entirely by the worker from escaped source text (fenced/indented code via hljs or
 *  escapeHtml, PLAIN fallbacks) and can contain no user-authored markup: the preview may mount it WITHOUT DOMPurify. */
export const HTML_FLAG_TRUSTED = 2;
/** A raw-HTML token of the block (html_inline / html_block) carries a name the app reserves for itself: an attribute
 *  named data-l, data-lang, data-md… or data-mdr…, or a class token starting with md- or mdr- (CONTRACT §11, U10). The
 *  preview marks the block wrapper with `data-mdr-x`; such a block is never edited in the preview. */
export const HTML_FLAG_RESERVED = 4;
export interface HtmlItem { id: number; flags: number; payload: string }
export interface HtmlBatch { ids: Int32Array; flags: Uint8Array; offsets: Uint32Array /* ids.length + 1 byte offsets */; utf8: Uint8Array }

// ---------------------------------------------------------------- worker protocol
export type ToWorker =
  | { type: 'init'; options: RenderOptions }
  | { type: 'setDoc'; docId: string; version: number; text: string }
  | { type: 'edit'; version: number; changes: TextChange[] }
  | { type: 'viewport'; firstLine: Line; lastLine: Line }     // priority hint + auto-push window
  | { type: 'need'; ids: number[] }                            // push HTML for these blocks (cache or render)
  | { type: 'setOptions'; options: Partial<RenderOptions> }
  | { type: 'draft'; action: 'enable' | 'disable' | 'clear' | 'flush' }
  | { type: 'exportHtml'; requestId: number; mathOutput?: 'html' | 'htmlAndMathml' }
  | { type: 'resync' };                                        // reply with a full `structure` (+ outline) for the current version

export interface StructureMsg {
  type: 'structure'; version: number;
  blocks: Int32Array;        // transferred, see BLOCK_STRIDE
  changed: Int32Array;       // ids whose content changed or that were created in this version
  lineCount: number; stats: DocStats; outlineVersion: number;
}
/** Incremental structure update for ONE edit transaction (sent instead of a full `structure` after `edit`):
 *  blocks[index .. index+removed) are replaced by `inserted` (BLOCK_STRIDE ints per block, transferred); every block
 *  after the replaced range keeps its id/kind/lineCount and gets startLine += lineDelta. Consumers keep persistent,
 *  growable typed arrays and splice in place, so a keystroke never allocates a full-document array on either side.
 *  The worker still sends a full `structure` for setDoc, restarts and any reset. */
export interface StructureDeltaMsg {
  type: 'structureDelta'; version: number;
  index: number; removed: number; inserted: Int32Array; lineDelta: number;
  changed: Int32Array;       // ids whose content changed or that were created in this version (subset of inserted)
  lineCount: number; stats: DocStats; outlineVersion: number;
}
export interface HtmlMsg { type: 'html'; version: number; batch: HtmlBatch }
export type FromWorker =
  | { type: 'ready' }
  | StructureMsg
  | StructureDeltaMsg
  | { type: 'outline'; outlineVersion: number; items: OutlineEntry[] }
  | HtmlMsg
  | { type: 'idle'; version: number }                          // nothing left to render for this version
  | { type: 'draftSaved'; docId: string; version: number; at: number }
  | { type: 'exportHtml'; requestId: number; html: string }
  | { type: 'error'; message: string; fatal: boolean; blockId?: number };

// ---------------------------------------------------------------- app events (bus)
export type SourceEdit = { kind: 'toggleTask'; line: Line };
export interface ToastSpec { text: string; kind?: 'info' | 'error'; timeoutMs?: number; actions?: Array<{ label: string; run(): void }> }
export interface AppEvents {
  'doc:loaded': { docId: string; name: string };
  'doc:cursor': { line: Line; col: number; typing: boolean;   // typing = caused by a doc-changing transaction
    /** U2 as amended (CONTRACT §11, RVS-3): caused by ⌘Z / ⇧⌘Z run from outside the editor (App historyOutside):
     *  the preview's cursor-follow follows it although the editor has no focus. Absent otherwise. */
    follow?: boolean };
  /** The line the user is "on" in one pane (click / caret / text selection); the OTHER pane mirrors it with the
   *  same subtle background (--mdr-focus-line). Never scrolls, never moves the caret, never steals focus. */
  'focus:line': { line: Line; source: 'editor' | 'preview' };
  'nav:gotoLine': { line: Line; fraction?: number; source: 'toc' | 'preview' | 'palette' | 'link' };
  'source:edit': SourceEdit;                                    // preview → editor
  'mode:changed': Mode;
  'theme:changed': ResolvedTheme;
  'outline:changed': OutlineEntry[];
  'stats:changed': DocStats;
  'file:dirty': boolean;
  'previewEdit:changed': boolean;                               // the "预览可编辑" toggle
  'previewEdit:session': { id: number | null };                 // a block entered (id) / left (null) in-preview editing
  'toast': ToastSpec;
  'perf:sample': { name: string; ms: number };
}
export interface EventBus {
  on<K extends keyof AppEvents>(key: K, fn: (e: AppEvents[K]) => void): () => void;
  emit<K extends keyof AppEvents>(key: K, e: AppEvents[K]): void;
}

// ---------------------------------------------------------------- commands
export type CommandId =
  | 'file.new' | 'file.open' | 'file.save' | 'file.saveAs' | 'file.exportHtml'
  | 'view.cycleMode' | 'view.mode.edit' | 'view.mode.split' | 'view.mode.preview' | 'view.toggleToc' | 'view.toggleTheme' | 'view.palette' | 'view.mountAll'
  | 'view.togglePreviewEdit'
  | 'edit.bold' | 'edit.italic' | 'edit.code' | 'edit.link' | 'edit.heading1' | 'edit.heading2' | 'edit.heading3' | 'edit.heading4' | 'edit.heading5' | 'edit.heading6' | 'edit.paragraph'
  | 'edit.find' | 'edit.toggleTask' | 'edit.gotoLine';
export interface Command {
  id: CommandId; title: string;               // zh-CN
  shortcut?: string;                          // CM notation: 'Mod-s', 'Mod-Shift-p'
  scope: 'global' | 'editor';                 // global: window keydown (E4); editor: CM keymap (E3)
  run(): void | Promise<void>; enabled?(): boolean;
}
export interface CommandRegistry {
  register(c: Command): void; get(id: CommandId): Command | undefined;
  run(id: CommandId): boolean; list(): Command[]; onChange(fn: () => void): () => void;
}

// ---------------------------------------------------------------- module factories
export interface EditorOptions { parent: HTMLElement; bus: EventBus; registry: CommandRegistry; theme: ResolvedTheme }
export interface EditorApi {
  readonly view: EditorView;
  readonly version: number;                           // +1 per doc-changing transaction and per setDoc
  setDoc(text: string): number;                       // replaces doc, clears history, returns new version
  /** U16 (CONTRACT §11, Checkpoint-D and Checkpoint-E decisions): the line that was `line` in the document of `version`,
   *  now: its number; null when it is gone (its first character deleted, joined into the line above, split by a line
   *  break put inside it, the document replaced); undefined when it cannot be known (a version above the current one or
   *  older than the editor remembers: at most 4096 edits, fewer when they touched very long lines). Optional. */
  lineNow?(line: Line, version: number): Line | null | undefined;
  getText(): string; lineCount(): number;
  onChanges(fn: (version: number, changes: TextChange[]) => void): () => void;  // synchronous, one call per transaction
  onCursor(fn: (line: Line, col: number, typing: boolean) => void): () => void; // rAF-coalesced
  onScroll(fn: () => void): () => void;               // rAF-coalesced, fires for user and programmatic scrolls
  topVisible(): { line: Line; fraction: number };     // uses cached line-block heights, never forces layout
  scrollToLine(line: Line, fraction?: number): void;  // top edge of viewport to that line, no animation
  gotoLine(line: Line, col?: number): void;           // cursor + scroll into view + focus
  applySourceEdit(e: SourceEdit): void;
  /** Mirror of the preview's focus line: a line decoration with the focus background (no caret move, no scroll,
   *  no focus). While set, the editor's own caret-line background is hidden so exactly one line is tinted.
   *  Cleared automatically when the user moves the caret in the editor; null clears it explicitly. */
  setPeerLine(line: Line | null): void;
  setTheme(t: ResolvedTheme): void; setLineWrap(on: boolean): void;
  setVisible(on: boolean): void;                      // hidden panes must not measure; visible → requestMeasure()
  focus(): void; hasFocus(): boolean;
}
export type CreateEditor = (o: EditorOptions) => EditorApi;

/** Source access for in-preview editing (App wires it to CodeMirror). Lines are 1-based. */
export interface PreviewSourceAccess {
  /** The exact `lineCount` source lines starting at `startLine`, joined with '\n' (no trailing newline). */
  read(startLine: Line, lineCount: number): string;
  /** Replace those lines with `text` (may contain fewer or more lines; no trailing newline) in ONE CodeMirror
   *  transaction tagged userEvent 'input.type.previewEdit' (CodeMirror only joins undo events whose userEvent is
   *  input.type… / delete…) so consecutive edits group for undo. Never scrolls the editor. */
  replace(startLine: Line, lineCount: number, text: string): void;
  /** Undo (`redo` false) or redo (`redo` true) ONE step of the source document's own history (CodeMirror), where
   *  preview writes are grouped like typing. Returns where the editor caret landed afterwards — `line` 1-based,
   *  `col` a 0-based UTF-16 offset inside that line — or null when there was nothing to undo / redo (the document
   *  did not change). Optional: when absent the preview session keeps the browser's own contenteditable undo.
   *  (CONTRACT §11, decision U1.) */
  history?(redo: boolean): { line: Line; col: number } | null;
  /** The source document's version: the editor's version, the one the worker's structures carry. Optional.
   *  (CONTRACT §11, P-B amended: the preview describes the current source when its structure's version is at least
   *  this.) */
  version?(): number;
  /** EditorApi.lineNow (CONTRACT §11, Checkpoint-D decisions: a task checkbox ticks the line its box stands for, mapped
   *  exactly through the changes made since its HTML was rendered). Optional: present when the editor has it. */
  lineNow?(line: Line, version: number): Line | null | undefined;
}
export interface BlockInfo { index: number; id: number; startLine: Line; lineCount: number; kind: BlockKind }
export interface PreviewOptions {
  parent: HTMLElement; bus: EventBus;
  request(ids: number[]): void;                       // preview wants HTML for these ids (App → worker 'need')
  viewport(firstLine: Line, lastLine: Line): void;    // materialization window in lines (App → worker 'viewport')
  resync(): void;                                     // preview cannot apply a delta → App → worker 'resync' → full structure
  source?: PreviewSourceAccess;                       // absent → in-preview editing is unavailable (read-only preview)
}
export interface PreviewApi {
  readonly el: HTMLElement;                           // .mdr-preview scroll container
  applyStructure(m: StructureMsg): void;
  applyStructureDelta(m: StructureDeltaMsg): void;     // in-place splice of the persistent block/height arrays
  applyHtml(m: HtmlMsg): void;
  applyOutline(items: OutlineEntry[]): void;          // for #anchor resolution
  blockCount(): number;
  blockAtLine(line: Line): BlockInfo;
  blockOfElement(el: Element): BlockInfo | null;      // the block whose section.md-block contains `el`
  elementOfBlock(id: number): HTMLElement | null;     // its mounted section.md-block, null when not materialized
  /** In-preview editing ("预览可编辑"): while `on`, a click inside an editable block starts an edit session on it
   *  (src/preview/inlineEdit.ts); the block's DOM is contenteditable, every change is serialized to Markdown and
   *  written through PreviewOptions.source.replace, and worker HTML for that id is held back until the session ends.
   *  Persisted by App (LS_PREVIEW_EDIT). No-op when PreviewOptions.source is absent.
   *  Rule L (CONTRACT §11, Round-4 verification decisions): the editing code is a chunk of its own. Turning editing on
   *  before that chunk arrived returns a promise and changes nothing until it settles: true = installed and editable,
   *  false = a later call withdrew the wish (or the preview went away), rejected = the chunk could not be loaded (editing
   *  stays off). Otherwise (off, or the chunk is here) it applies at once and returns nothing. isPreviewEditable() is
   *  what is true now: false until the module is installed and editable. */
  setPreviewEditable(on: boolean): void | Promise<boolean>; isPreviewEditable(): boolean;
  /** Ends any active edit session: writes the pending serialization synchronously (also text of an open IME
   *  composition), emits 'previewEdit:session' {id:null} before returning, never continues onto a block split
   *  off by that write, and cancels a continuation still waiting from an earlier split. */
  endEditSession(): void;
  /** Writes pending in-preview edits synchronously through PreviewOptions.source.replace and keeps the session
   *  and caret (⌘S). Writes nothing while an IME composition is open. No-op without a session. */
  flushEditSession(): void;
  lineToScrollTop(line: Line, fraction: number): number;     // model only, no layout reads
  scrollTopToLine(top: number): { line: Line; fraction: number };
  topVisible(): { line: Line; fraction: number };
  isLineVisible(line: Line): boolean;
  scrollToLine(line: Line, fraction?: number, behavior?: 'instant' | 'smooth'): void;
  onScroll(fn: () => void): () => void;               // rAF-coalesced
  /** Tint the innermost [data-l] element covering `line` with `.is-focus` (kept across lazy mounts / re-renders
   *  of that block; at most one element tinted at a time). null clears it. No scrolling. */
  setFocusLine(line: Line | null): void;
  setVisible(on: boolean): void;
  mountAll(): Promise<void>;                          // materialize everything, eviction off until next structure
  dispose(): void;
}
export type CreatePreview = (o: PreviewOptions) => PreviewApi;

export interface ScrollSyncApi { setEnabled(on: boolean): void; syncNow(from: 'editor' | 'preview'): void; dispose(): void }
export type CreateScrollSync = (editor: EditorApi, preview: PreviewApi, bus: EventBus) => ScrollSyncApi;

export interface TocApi { setOutline(items: OutlineEntry[]): void; setActiveLine(line: Line): void; setVisible(on: boolean): void }
export type CreateToc = (parent: HTMLElement, bus: EventBus) => TocApi;

export interface WorkerClientHandlers {
  onStructure(m: StructureMsg): void; onStructureDelta(m: StructureDeltaMsg): void;
  onOutline(items: OutlineEntry[]): void; onHtml(m: HtmlMsg): void;
  onIdle(version: number): void; onDraftSaved(docId: string, version: number, at: number): void;
  onError(message: string, fatal: boolean): void;
  onRestart(): { docId: string; version: number; text: string };   // called after a restart; returns current doc
}
export interface WorkerClientApi {
  setDoc(docId: string, version: number, text: string): void;
  edit(version: number, changes: TextChange[]): void;
  viewport(firstLine: Line, lastLine: Line): void;    // throttled inside: ≤ 1 per 100 ms, last wins
  need(ids: number[]): void;                          // coalesced per animation frame, deduped
  setOptions(o: Partial<RenderOptions>): void;
  draft(action: 'enable' | 'disable' | 'clear' | 'flush'): void;
  exportHtml(): Promise<string>;
  resync(): void;                                     // posts 'resync'; coalesced per animation frame
  dispose(): void;
}
export type CreateWorkerClient = (h: WorkerClientHandlers, options?: RenderOptions) => WorkerClientApi;

export interface PaletteApi { open(): void; close(): void; isOpen(): boolean }
export type CreatePalette = (parent: HTMLElement, registry: CommandRegistry) => PaletteApi;
export interface ToolbarApi { setMode(m: Mode): void; setDirty(d: boolean): void; setTocVisible(on: boolean): void }
export type CreateToolbar = (parent: HTMLElement, registry: CommandRegistry) => ToolbarApi;

export interface LayoutEls { toolbar: HTMLElement; toc: HTMLElement; editor: HTMLElement; gutter: HTMLElement; preview: HTMLElement; statusbar: HTMLElement; overlay: HTMLElement }
export interface LayoutApi { els: LayoutEls; setMode(m: Mode): void; getMode(): Mode; setTocVisible(on: boolean): void; isTocVisible(): boolean }
export interface ThemeApi { get(): ThemePref; set(p: ThemePref): void; resolved(): ResolvedTheme; onChange(fn: (t: ResolvedTheme) => void): () => void }
export type FileState = 'untitled' | 'saved' | 'dirty' | 'draft';
export interface StatusBarApi { setStats(s: DocStats): void; setCursor(line: Line, col: number): void; setFile(name: string, state: FileState): void; setMode(m: Mode): void; setProgress(fraction: number | null): void }

// ---------------------------------------------------------------- files
/** `source:'native'` = opened through the desktop shell (see src/shared/native.ts); `path` is the absolute path
 *  saves go back to. Web builds never produce it. */
export interface OpenedFile { docId: string; name: string; text: string; handle?: FileSystemFileHandle; path?: string; lastModified: number; source: 'fsa' | 'legacy' | 'new' | 'native' }
export type SaveResult = { ok: true; savedAt: number; file: OpenedFile } | { ok: false; reason: 'cancelled' | 'permission' | 'error'; message?: string };
export interface RecentEntry { docId: string; name: string; handle?: FileSystemFileHandle; path?: string; openedAt: number }
export interface DraftRecord { docId: string; version: number; text: string; at: number }
export interface FileService {
  readonly canSaveInPlace: boolean;                   // File System Access API available
  newFile(): OpenedFile;                              // docId 'untitled', name '未命名.md'
  open(): Promise<OpenedFile | null>;                 // picker or <input type=file>; null = cancelled
  openHandle(h: FileSystemFileHandle, docId?: string): Promise<OpenedFile>;  // rejects with DOMException NotFoundError / NotAllowedError
  fromDrop(dt: DataTransfer): Promise<OpenedFile | null>;
  save(file: OpenedFile, text: string): Promise<SaveResult>;   // in place when handle+permission, else saveAs
  saveAs(text: string, suggestedName: string): Promise<SaveResult>;
}
export interface DraftStore { get(docId: string): Promise<DraftRecord | undefined>; del(docId: string): Promise<void> }  // writes are done by the worker
export interface RecentStore { list(): Promise<RecentEntry[]>; push(e: RecentEntry): Promise<void>; remove(docId: string): Promise<void>; findByHandle(h: FileSystemFileHandle): Promise<RecentEntry | undefined> }

// ---------------------------------------------------------------- storage keys / constants
export const LS_THEME = 'mdr.theme', LS_MODE = 'mdr.mode', LS_TOC = 'mdr.toc', LS_SPLIT = 'mdr.split', LS_PREVIEW_EDIT = 'mdr.previewEdit';
export const IDB_DRAFT_PREFIX = 'mdr.draft:', IDB_RECENT = 'mdr.recent';
export const MAX_RECENT = 10;
export const DRAFT_DEBOUNCE_MS = 1000;
export const HTML_BATCH_MAX_ITEMS = 200, HTML_BATCH_MAX_BYTES = 262144;
export const WORKER_SLICE_MS = 8, MOUNT_SLICE_MS = 8;
export const SYNC_SUPPRESS_MS = 120;
