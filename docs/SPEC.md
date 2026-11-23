# MDReader — Final Implementation Spec (v1.0, frozen)

## 0. Lineage and decisions

Base design: **"ux"** (highest combined score). Grafted from "perf": paragraph-granularity blocks, 64-bit hash + byte-budgeted LRU, packed transferable HTML batches, wrappers inserted in rAF slices, running stats, minimal CM6 extension list, User-Timing perf table + `?perf=1` overlay, verified package pins. Grafted from "simple": whole structure sent as one transferable `Int32Array` with stateless prefix/suffix reconciliation, full set of `<section class="md-block">` wrappers with `content-visibility:auto`, budgeted `MountQueue`, failure-mode table with rate-limited worker restart, per-block `.md-error`, fakes for day-0 parallel work, Node-side vitest benches, 4× CPU-throttled Playwright.

Critique fixes applied: (1) block **ids are position-stable** (deterministic identity rule §4.4) so typing never destroys a DOM node; (2) `TextChange` coordinate semantics are unambiguous (original coordinates, applied in reverse); each CM transaction is one `edit` message, no client-side change concatenation; (3) no 48-line coalescing (cascade problem) — blocks are paragraph-sized, headings always start a block; (4) no spacer windowing and no IntersectionObserver rect reuse — one **height model** (`heights`/`tops`) owned by the preview drives both materialization and scroll sync with zero layout reads on hot paths; (5) `markdown-it html:true` + DOMPurify (inline HTML works); (6) outline sent only when it changed; (7) every cross-engineer surface is a typed interface with a `create*` factory signature; (8) memory bounded by evicting far-away mounted blocks with their measured height pinned (no scroll jump); (9) giant-block guard for the unclosed-fence case; (10) scope trimmed: no image paste/asset resolver/front matter.

## 1. Packages (`package.json`)

Verified pins: `vite 8.2.2`, `typescript 7.0.2`, `codemirror 6.0.2`, `@codemirror/lang-markdown 6.5.2`, `markdown-it 15.0.1`, `markdown-it-task-lists 2.1.1`, `highlight.js 11.12.0`, `dompurify 3.4.14`, `katex 0.18.5`, `idb-keyval 6.3.0`. Pin at install (latest 6.x / 1.x): `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`, `@lezer/highlight`, `@types/markdown-it`, `@vscode/markdown-it-katex` (verify against markdown-it 15 in a worker; fallback: our own 60-line `$`/`$$` rule in `worker/math.ts`), `@types/wicg-file-system-access`, dev: `vitest`, `@playwright/test`. `"type":"module"`, strict TS, worker via `new Worker(new URL('../worker/render.worker.ts', import.meta.url), {type:'module'})`.

## 2. File tree and ownership

```
index.html vite.config.ts tsconfig.json package.json
src/main.ts                                  createApp(#app)                       [E4]
src/shared/types.ts                          ALL contracts (below, verbatim)       [lead, day 0]
src/shared/protocol.ts                       packHtml/unpackHtml, isFromWorker     [lead, day 0]
src/shared/hash.ts                           fnv1a64(s): [lo, hi]                  [lead, day 0]
src/shared/bus.ts                            createBus(): EventBus                 [lead, day 0]
src/shared/keys.ts                           matchShortcut(e, 'Mod-Shift-p')       [lead, day 0]
src/shared/i18n.ts                           zh-CN strings used by ≥2 modules      [lead]
src/worker/render.worker.ts                  entry, message loop, scheduler        [E1]
src/worker/doc.ts                            lines[], applyChange, lineStarts      [E1]
src/worker/segmenter.ts                      segmentAll / resegmentWindow / identity [E1]
src/worker/md.ts                             markdown-it instance + rules          [E1]
src/worker/highlight.ts                      hljs wrapper + caps                   [E1]
src/worker/math.ts                           lazy KaTeX                            [E1]
src/worker/outline.ts  src/worker/stats.ts   heading scan + slugs, counts          [E1]
src/worker/cache.ts                          byte-budgeted LRU                     [E1]
src/worker/draft.ts                          IDB autosave from worker              [E1]
src/preview/createPreview.ts                 PreviewApi: wrappers, reconcile, window [E2]
src/preview/heights.ts                       heights/tops model + ResizeObserver   [E2]
src/preview/mountQueue.ts                    budgeted mounting                     [E2]
src/preview/sanitize.ts                      DOMPurify config                      [E2]
src/preview/interactions.ts                  checkbox write-back, click-to-source, anchors [E2]
src/preview/scrollSync.ts                    createScrollSync                      [E2]
src/preview/toc.ts                           createToc                             [E2]
src/styles/preview.css  src/styles/hljs.css                                        [E2]
src/editor/createEditor.ts                   EditorApi                             [E3]
src/editor/changes.ts                        ChangeSet → TextChange[]              [E3]
src/editor/commands.ts                       bold/italic/code/link/heading/list    [E3]
src/editor/keymap.ts  src/editor/phrases.ts  CM keymap from registry, zh-CN phrases [E3]
src/editor/cmTheme.ts                        light/dark themes (Compartment)       [E3]
src/editor/toolbar.ts  src/editor/palette.ts createToolbar / createPalette         [E3]
src/styles/editor.css                                                              [E3]
src/app/App.ts                               composition root, session, open/save flows [E4]
src/app/workerClient.ts                      createWorkerClient                    [E4]
src/app/layout.ts  src/app/theme.ts          createLayout / createTheme            [E4]
src/app/statusbar.ts  src/app/shortcuts.ts   createStatusBar / global keydown      [E4]
src/app/registry.ts                          createCommandRegistry                 [E4]
src/app/toast.ts  src/app/dialogs.ts         toast bar, confirm                    [E4]
src/app/perfOverlay.ts                       ?perf=1                               [E4]
src/files/fileService.ts fsaBackend.ts legacyBackend.ts drafts.ts recent.ts        [E4]
src/styles/tokens.css  src/styles/layout.css                                       [E4]
bench/gen-fixture.ts  bench/perf.spec.ts  bench/worker.bench.ts  test/*.test.ts    [E4 harness; E1 worker tests]
```

Only `App.ts` imports across modules. Every other module imports `src/shared/*` and its own directory only.

## 3. `src/shared/types.ts` (verbatim, frozen)

```ts
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
export const HTML_FLAG_PLAIN = 1; // payload is raw text, mount as <pre class="md-code md-code--plain"><code> via textContent
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
  | { type: 'exportHtml'; requestId: number };

export interface StructureMsg {
  type: 'structure'; version: number;
  blocks: Int32Array;        // transferred, see BLOCK_STRIDE
  changed: Int32Array;       // ids whose content changed or that were created in this version
  lineCount: number; stats: DocStats; outlineVersion: number;
}
export interface HtmlMsg { type: 'html'; version: number; batch: HtmlBatch }
export type FromWorker =
  | { type: 'ready' }
  | StructureMsg
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
  'doc:cursor': { line: Line; col: number; typing: boolean };   // typing = caused by a doc-changing transaction
  'nav:gotoLine': { line: Line; fraction?: number; source: 'toc' | 'preview' | 'palette' | 'link' };
  'source:edit': SourceEdit;                                    // preview → editor
  'mode:changed': Mode;
  'theme:changed': ResolvedTheme;
  'outline:changed': OutlineEntry[];
  'stats:changed': DocStats;
  'file:dirty': boolean;
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
  getText(): string; lineCount(): number;
  onChanges(fn: (version: number, changes: TextChange[]) => void): () => void;  // synchronous, one call per transaction
  onCursor(fn: (line: Line, col: number, typing: boolean) => void): () => void; // rAF-coalesced
  onScroll(fn: () => void): () => void;               // rAF-coalesced, fires for user and programmatic scrolls
  topVisible(): { line: Line; fraction: number };     // uses cached line-block heights, never forces layout
  scrollToLine(line: Line, fraction?: number): void;  // top edge of viewport to that line, no animation
  gotoLine(line: Line, col?: number): void;           // cursor + scroll into view + focus
  applySourceEdit(e: SourceEdit): void;
  setTheme(t: ResolvedTheme): void; setLineWrap(on: boolean): void;
  setVisible(on: boolean): void;                      // hidden panes must not measure; visible → requestMeasure()
  focus(): void; hasFocus(): boolean;
}
export type CreateEditor = (o: EditorOptions) => EditorApi;

export interface PreviewOptions {
  parent: HTMLElement; bus: EventBus;
  request(ids: number[]): void;                       // preview wants HTML for these ids (App → worker 'need')
  viewport(firstLine: Line, lastLine: Line): void;    // materialization window in lines (App → worker 'viewport')
}
export interface PreviewApi {
  readonly el: HTMLElement;                           // .mdr-preview scroll container
  applyStructure(m: StructureMsg): void;
  applyHtml(m: HtmlMsg): void;
  applyOutline(items: OutlineEntry[]): void;          // for #anchor resolution
  blockCount(): number;
  blockAtLine(line: Line): { index: number; id: number; startLine: Line; lineCount: number; kind: BlockKind };
  lineToScrollTop(line: Line, fraction: number): number;     // model only, no layout reads
  scrollTopToLine(top: number): { line: Line; fraction: number };
  topVisible(): { line: Line; fraction: number };
  isLineVisible(line: Line): boolean;
  scrollToLine(line: Line, fraction?: number, behavior?: 'instant' | 'smooth'): void;
  onScroll(fn: () => void): () => void;               // rAF-coalesced
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
  onStructure(m: StructureMsg): void; onOutline(items: OutlineEntry[]): void; onHtml(m: HtmlMsg): void;
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
export interface OpenedFile { docId: string; name: string; text: string; handle?: FileSystemFileHandle; lastModified: number; source: 'fsa' | 'legacy' | 'new' }
export type SaveResult = { ok: true; savedAt: number; file: OpenedFile } | { ok: false; reason: 'cancelled' | 'permission' | 'error'; message?: string };
export interface RecentEntry { docId: string; name: string; handle?: FileSystemFileHandle; openedAt: number }
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
export const LS_THEME = 'mdr.theme', LS_MODE = 'mdr.mode', LS_TOC = 'mdr.toc', LS_SPLIT = 'mdr.split';
export const IDB_DRAFT_PREFIX = 'mdr.draft:', IDB_RECENT = 'mdr.recent';
export const MAX_RECENT = 10;
export const DRAFT_DEBOUNCE_MS = 1000;
export const HTML_BATCH_MAX_ITEMS = 200, HTML_BATCH_MAX_BYTES = 262144;
export const WORKER_SLICE_MS = 8, MOUNT_SLICE_MS = 8;
export const SYNC_SUPPRESS_MS = 120;
```

`src/shared/protocol.ts`: `packHtml(items: HtmlItem[]): { batch: HtmlBatch; transfer: ArrayBuffer[] }` — allocates `ids/flags/offsets`, one `Uint8Array` sized `Σ payload.length*3`, `TextEncoder.encodeInto` sequentially, trims to written length, transfers all four buffers. `unpackHtml(b: HtmlBatch): HtmlItem[]` decodes each `utf8.subarray(offsets[i], offsets[i+1])` with one shared `TextDecoder`. `src/shared/hash.ts`: `fnv1a64(s: string): [lo: number, hi: number]` — two 32-bit FNV-1a lanes (seeds `0x811c9dc5`, `0x9747b28c`) over UTF-16 code units in one loop; `hashKey(lo, hi, len) = `${hi}:${lo}:${len}``. `src/shared/keys.ts`: `matchShortcut(e: KeyboardEvent, s: string): boolean` for CM notation (`Mod` = metaKey on mac, ctrlKey elsewhere).

## 4. Render worker (E1)

### 4.1 State
`docId`, `version`, `lines: string[]`, `blocks: Block[]` where `Block = { id, startLine, lineCount, kind, hashLo, hashHi, chars, cjk, latinWords, hasRef: boolean, slow: boolean, lastEditAt }`, `nextId = 1`, `dirty: Set<id>`, `need: Set<id>`, `viewport = {firstLine, lastLine}`, `cache: LruCache<string, RenderedBlock>` keyed by `hashKey` (64 MB budget, cost `html.length*2`), `refs: {references: Record<string,{href,title}>}`, `outlineVersion`, `lastOutlineHash`, `draftEnabled`, `draftTimer`.

### 4.2 Applying an edit (`doc.ts`)
`applyChange(lines, c: TextChange) → { fromLine, toLineOld, toLineNew, lineDelta }`: `lineStarts: Uint32Array` (prefix sums of `lines[i].length+1`) is rebuilt lazily and invalidated by every change; binary-search `from`/`to` to `(line, col)`, splice `lines` with `lines[la].slice(0,ca) + insert + lines[lb].slice(cb)` split on `\n`. Changes of one `edit` are applied **in reverse order**, each immediately followed by `resegmentWindow`. `setDoc` splits the whole text (`text.split('\n')`, 10 MB ≈ 30–40 ms) and runs `segmentAll`.

### 4.3 Segmentation rules (`segmenter.ts`) — single implementation, worker only
Line scanner with state ∈ {TEXT, FENCE(char,len), HTML1(closeRe), MATH}. Blocks tile the document; **trailing blank lines belong to the preceding block**; every block starts in TEXT state.
1. FENCE opens on `/^ {0,3}(`{3,}|~{3,})/` (backtick fences: no backtick in the info string); closes on the same char with length ≥ opener, ≤3 indent, nothing else on the line. HTML1 opens on `/^ {0,3}<(pre|script|style|textarea)(\s|>|$)/i` (close `/<\/(pre|script|style|textarea)>/i`, checked on the opening line too) and `/^ {0,3}<!--/` (close `-->`). MATH opens on a line starting with `$$` that does not also close it; closes on a line containing `$$`.
2. In TEXT, a **blank line is a boundary candidate**. Look ahead to the next non-blank line `j` (EOF → the block ends, absorbing the blanks). **Glue** (no boundary) when: the block's kind is `List` and `lines[j]` matches `/^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/` or has indent ≥ 2; or the kind is `Quote` and `lines[j]` starts with `/^ {0,3}>/`. Otherwise the block ends before `j`.
3. In TEXT, a non-blank ATX heading line `/^ {0,3}#{1,6}(\s|$)/` that is not the block's first line **starts a new block**, and so does a line that markdown-it would render as a list item (`startsListBlock`, CommonMark paragraph-interruption rules: a lazy-continuation context excludes setext underlines, empty items and ordered markers other than `1.`/`1)`) — headings and lists always start a block. A heading nested inside a list item (indent ≥ the List block's content indent) stays in the list. An HTML block of CommonMark types 1–6 (`htmlInterruptsParagraph`) may open a raw region in the **middle** of a block: from that line the rest of the block is raw until the next blank line, so `# ` lines inside the element are not turned into headings.
4. Block `kind` is decided from its first line: heading → `Heading`; fence opener → `Code`; `/^ {0,3}(\*\s*){3,}$|^ {0,3}(-\s*){3,}$|^ {0,3}(_\s*){3,}$/` → `Hr`; list marker → `List`; `>` → `Quote`; `$$` → `Math`; `/^ {0,3}<[a-zA-Z!\/?]/` → `Html`; first line contains `|` and second line matches `/^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/` → `Table`; else `Prose`. A block of exactly 2 lines whose second line is `/^ {0,3}(=+|-+)\s*$/` and whose first is prose is a setext heading (level 1/2) for the outline only.
5. `segmentAll(lines): Segment[]` is the scanner from line 1. `resegmentWindow(blocks, lines, fromLine, toLineOld, toLineNew, lineDelta)`: `a = indexOfBlockContaining(fromLine) - 1` clamped to 0 (previous block included for setext/glue safety); scan from `blocks[a].startLine` with fresh TEXT state; after producing each boundary at new line `n` with `n > toLineNew`, binary-search old blocks for `k > indexOfBlockContaining(toLineOld)` with `oldStart[k] + lineDelta === n`; if found, stop: new segments replace `blocks[a..k)`, blocks `k..` keep identity and get `startLine += lineDelta` (plain loop over ≤30k entries, ≈30 µs). An unclosed fence legitimately scans to EOF (≈5 ms for 100k lines) and produces one giant `Code` block; closing it reverses that.
6. **Identity rule** (deterministic): let `O = blocks[a..k)`, `N = new segments` with `hash = fnv1a64(source)`. Pass 1: each `N[i]` claims the first unclaimed `O[j]` with equal `(hashLo, hashHi, lineCount)` → keeps id, **not dirty**. Pass 2: remaining `N` and remaining `O` are zipped in document order → keep id, mark dirty. Pass 3: surplus `N` get `nextId++` (dirty); surplus `O` are dropped (their cache entries stay in the LRU). Typing inside a paragraph = 1 old : 1 new → same id; splitting a paragraph = first half keeps the id.
7. **Reference definitions**: `hasRef = /^ {0,3}\[[^\]]+\]:\s/m.test(source)`. When any block in `O ∪ N` has `hasRef`, rebuild `refs` by parsing the concatenation of all ref-definition lines of all `hasRef` blocks with `md.parse(text, env)` (uses markdown-it's own normalisation) and compare `JSON.stringify(refs)`; if changed, add every block whose source contains `]` to `dirty` (rendered viewport-first, rest lazily — never a synchronous full re-render).
8. Per-block stats (`stats.ts`) recomputed for `N` only: `cjk = count(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)`, `latinWords = count(/[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}]+)*/gu` on the source with CJK removed), `chars`, `charsNoSpace`. Doc totals are maintained by subtracting `O` and adding `N` (O(window)). `readingMinutes = max(1, ceil(cjk/400 + latinWords/200))` (0 for empty doc).
9. Outline (`outline.ts`): entries from `Heading` blocks (ATX; text = first line stripped of `#`, trailing `#`, inline markup ``*_~` `` and `[text](url)` → text) plus 2-line setext blocks; slug = lowercase, whitespace → `-`, strip `[^\p{L}\p{N}_-]`; global dedupe `-1, -2…` in document order. `outlineVersion++` and an `outline` message are sent only when `fnv1a64(entries.map(e=>e.level+e.text+e.line).join('\n'))` differs from the last one. No `id=` attributes in block HTML.

### 4.4 Rendering a block (`md.ts`, `highlight.ts`, `math.ts`)
`markdown-it({ html: true, linkify: true, typographer: false, breaks: opts.breaks })`, `.enable(['table','strikethrough'])`, `markdown-it-task-lists({ enabled: true, label: false })`, custom core rule `line_attrs`: `data-l="<token.map[0]>"` (line relative to block start) on `paragraph_open, heading_open, list_item_open, blockquote_open, table_open, html_block`; the `fence`, `code_block`, `hr` renderers are wrapped to inject `data-l` (and `data-lang` on `<pre class="md-code">`). Fence highlighting via `highlight.js/lib/common` when `opts.highlight && hljs.getLanguage(lang) && code.length ≤ maxHighlightChars`, else escaped (`md-code--unhighlighted`). Images get `loading="lazy"`. Math: on the first render of a block containing `$`, `math.ts` does `await import('katex')` once and registers the plugin; that block is re-queued; on import failure `math=false` and `error` (non-fatal) is posted once. Block source longer than `maxHtmlChars` → `HTML_FLAG_PLAIN` with raw source (escaped nothing; mounted via `textContent`). Any exception → `<div class="md-error"><p>渲染此段落时出错：{escaped message}</p><pre>{escaped source}</pre></div>`, pass continues. `env = { references: refs.references, blockId }`.

Fix-round rules (2026-09): (a) **inline math** — a `$` opener immediately followed by a digit does not pair with a closer that is
immediately preceded by a digit and followed by whitespace/end, so `Price $5, then 5$ each.` stays text while `$x = 5$` is math; the failed-closer
search is memoised per inline state, making the scan linear in the number of `$`. (b) **big fences** — a fenced `Code` block of ≥ 8 KB
(`fastCodeChars`) that is still being edited is pushed as escaped, unhighlighted text at once (`HTML_FLAG_TRUSTED`) and re-rendered with
highlight.js once the block has been quiet for 150 ms (`codeCoalesceMs`); the > 30 ms slow-block throttle applies on top. (c) `HTML_FLAG_TRUSTED`
is set on Code-kind blocks and PLAIN payloads (CONTRACT §6); the preview mounts those with `innerHTML`, no DOMPurify. (d) `exportHtml` honours
`mathOutput` (`'html'` for the standalone export, so a formula never renders twice offline).

### 4.5 Scheduling (`render.worker.ts`)
Messages are handled synchronously in arrival order; `edit` is applied immediately (never skipped). After `setDoc`/`edit`: post `structure` (fresh `Int32Array`, `changed` = dirty ids of this version), maybe `outline`, then schedule a render slice via a `MessageChannel` port (yields to incoming messages between slices). A slice runs ≤ `WORKER_SLICE_MS`: pick blocks by priority (1) dirty ∩ auto-push window, (2) `need`, (3) dirty, nearest to viewport centre, (4) cache-miss blocks nearest the viewport (background back-fill). Auto-push window = viewport lines ± 1.5× its height in lines. For each picked block: cache hit → use; miss → render, `cache.set`, record `renderMs`; if `renderMs > 30` mark `slow` and, while typing continues in that block, re-render it at most once per 300 ms (deferred timer). Rendered items for blocks inside the auto-push window or in `need` are appended to the outgoing batch (flushed at `HTML_BATCH_MAX_ITEMS`/`HTML_BATCH_MAX_BYTES` or slice end via `packHtml`); other results only warm the cache. When nothing is left: post `idle`. `exportHtml`: full-document `md.render` with heading ids (deduped slugs).

### 4.6 Drafts (`draft.ts`)
`idb-keyval` in the worker: 1000 ms after the last edit (debounced) write `{docId, version, text: lines.join('\n'), at: Date.now()}` to `IDB_DRAFT_PREFIX + docId`; post `draftSaved`. `disable` cancels, `clear` deletes, `flush` writes now. All IDB calls wrapped in try/catch (private mode → no-op).

## 5. Preview (E2)

### 5.1 DOM
```
div.mdr-preview                        (scroll container, overflow:auto, overflow-anchor:auto)
  article.mdr-preview__body.markdown-body
    section.md-block[data-id="17"]     one per block, document order; states: .is-pending (no children, min-height:var(--est-h))
                                       .is-stale (content outdated, opacity .85) .is-slow (giant block awaiting settle)
```
`.md-block { content-visibility:auto; contain-intrinsic-size:auto var(--est-h); }` — c-v:auto implies layout/style/paint containment, so child margins never collapse out and each block's height is self-contained. Estimates (`heights.ts`): `Heading 48`, `Hr 32`, `Code 24+23·lines`, `Table 36·lines`, others `28·lines`, min 28.

### 5.2 `applyStructure` (stateless reconcile)
Compare old and new `blocks` arrays by **id**: common prefix `p`, common suffix `s`. Removed ids `old[p..nOld−s)`: `el.remove()`, `byId.delete`, `measured.delete`, RO unobserve. Inserted ids `new[p..nNew−s)`: create wrappers into one `DocumentFragment`, `insertBefore` the element of `new[nNew−s]` (or append). For every id in `changed`: add `.is-stale`, `staleSince.set(id, version)`, refresh `--est-h` if pending. `heights: Float64Array` is spliced (typed-array `set` of prefix/suffix, estimates or `measured.get(id)` for the middle) and `topsDirty = true`. Then `updateWindow()`. Cost per keystroke ≈ 0.1 ms; initial 30k wrappers are created in rAF slices of ≤ 8 ms (5–8 frames), scrollbar correct after the first slice's `heights` (all 30k estimates are known immediately).

### 5.3 Height model
`tops` (prefix sums, rebuilt lazily on read when dirty, ≈0.05 ms for 30k) and `bodyTop` (offsetTop of the body inside the scroller, re-read on a ResizeObserver of `el`). One `ResizeObserver` observes **mounted** wrappers only; a callback sets `measured[id] = heights[index] = borderBoxSize.blockSize` and `topsDirty = true`. Pending wrappers are exactly `--est-h` tall by construction, so the model equals real layout to within one frame without ever reading `offsetTop` on hot paths. `lineToScrollTop(line, f)`: binary search `startLine` → `bodyTop + tops[i] + ((line − start) + f) / lineCount · heights[i]`. `scrollTopToLine(top)`: binary search `tops` → inverse. `scrollToLine` writes `scrollTop` then re-checks once on the next frame (if the target moved > 4 px after measurements, writes again — max two passes).

### 5.4 Materialization window and eviction (`updateWindow`, rAF-coalesced on scroll/structure/resize)
`H = el.clientHeight`; window = block indices covering `[scrollTop − 1.5H, scrollTop + 2.5H]` from the model. Pending blocks in the window not yet requested → `opts.request(ids)` (`requested: Set<id>`, cleared on mount or removal); `opts.viewport(firstLine, lastLine)` of the window. Eviction (`requestIdleCallback`, ≤ 300 blocks per pass, at most every 500 ms): mounted blocks with `|tops[i] − scrollTop| > 20H` → `--est-h` := measured height, `replaceChildren()`, `.is-pending`, unobserve. Height is pinned, so no layout shift. `mountAll()` mounts everything in 8 ms slices and disables eviction until the next `applyStructure`. No IntersectionObserver anywhere. Hidden pane (`setVisible(false)`): window is empty, nothing requested; `setVisible(true)` → `updateWindow()`.

### 5.5 `applyHtml` + `MountQueue`
`unpackHtml` → for each item: id unknown or outside the window → drop (and `requested.delete`); else enqueue (replacing a queued item with the same id). rAF `flush()` mounts in order of `|index − centreIndex|` until `MOUNT_SLICE_MS`, reschedules the rest. Mount: PLAIN → `pre.md-code.md-code--plain > code` with `textContent`; HTML → `el.replaceChildren(DOMPurify.sanitize(html, cfg))` with `RETURN_DOM_FRAGMENT:true`; remove `.is-pending`; if `batch.version ≥ staleSince.get(id)` clear `.is-stale`; RO observe; `bus.emit('perf:sample', {name:'mount', ms})`. **Giant guard**: payload > 256 KB is mounted only after the block has been stable for 500 ms (`.is-slow` on the wrapper; the old content stays visible). `sanitize.ts`: one instance, `{ USE_PROFILES:{html:true, mathMl:true, svg:true}, ADD_ATTR:['data-l','data-lang','target'], FORBID_TAGS:['style','form','button','select','textarea','iframe','object','embed'], FORBID_ATTR:['onerror','onload'] }`; hook `afterSanitizeAttributes`: external `a[href]` → `target=_blank rel="noopener noreferrer"`; `input` allowed only as `type=checkbox`.

### 5.6 Interactions (`interactions.ts`, delegated listeners on `el`)
Checkbox `change` → `input.closest('li[data-l]')` → `line = block.startLine + data-l` → `bus.emit('source:edit', {kind:'toggleTask', line})` (the editor toggles the first `[ ]`/`[x]` after the list marker on that line). `Alt+click` on any `[data-l]` ancestor → `nav:gotoLine {line, source:'preview'}`. `a[href^="#"]` → resolve `slug` (or raw `slug` prefix match) in the outline → `nav:gotoLine {source:'link'}`; other relative links → toast「暂不支持打开相对链接」; external links open in a new tab.

### 5.7 TOC (`toc.ts`)
`nav.mdr-toc > a.mdr-toc__item.mdr-toc__item--h{1..6}[data-line]`, `.is-active`. `setOutline` rebuilds only if the entries changed (keyed on `level+text+line` string); click → `nav:gotoLine {source:'toc'}`. `setActiveLine` = last entry with `line ≤ cursorLine` (binary search), `scrollIntoView({block:'nearest'})` only when the item is outside the nav's visible box (compare cached `offsetTop` ranges updated on rebuild). > 3000 entries: levels ≥ 3 collapsed by default.

## 6. Scroll sync (`preview/scrollSync.ts`, E2)
Both panes expose the top edge as `(line, fraction)`; the follower is positioned with `lineToScrollTop` / `scrollToLine`. Algorithm:
```
master: 'editor'|'preview' = 'editor'; suppressUntil = { editor:0, preview:0 }
wheel/pointerdown/touchstart/keydown/focusin on editor.view.scrollDOM → master='editor'; same on preview.el → 'preview'
editor.onScroll: if (!enabled || master!=='editor' || now < suppressUntil.editor) return
   {line,fraction} = editor.topVisible(); top = preview.lineToScrollTop(line,fraction)
   if |preview.el.scrollTop − top| > 1: suppressUntil.preview = now+SYNC_SUPPRESS_MS; preview.el.scrollTop = top; settle next frame (recompute once from the master, write again if > 4 px)
preview.onScroll: symmetric with preview.topVisible() → editor.scrollToLine(line,fraction)
syncNow(from): one forced pass (App calls it after load, on mode switch, on split resize)
bus 'doc:cursor' with typing && enabled && !preview.isLineVisible(line): preview.scrollToLine(line, 0, farther than 3 screens ? 'instant' : 'smooth')
bus 'nav:gotoLine': editor.gotoLine(line); preview.scrollToLine(line, fraction ?? 0)
```
Enabled only in `split` mode. Hot path cost < 0.2 ms, no layout reads (editor side uses `view.lineBlockAtHeight(scrollTop − documentPadding.top)` / `lineBlockAt`, preview side the model).

## 7. Editor (E3)
Extensions (no `basicSetup`): `lineNumbers, history, drawSelection, highlightActiveLine, bracketMatching, closeBrackets, markdown({ base: markdownLanguage, codeLanguages: languages /* lazy @codemirror/language-data optional */ }), syntaxHighlighting(defaultHighlightStyle), search({ top: true }), highlightSelectionMatches, EditorView.lineWrapping (Compartment), theme Compartment, EditorState.tabSize.of(2), EditorState.phrases.of(zhCN)` (all search-panel phrases in `phrases.ts`), keymaps: `[...our keymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]` with `Enter → insertNewlineContinueMarkup`, `Backspace → deleteMarkupBackward`, `Tab/Shift-Tab → indentListItem/dedentListItem` (when the cursor is in a `ListItem` syntax node, else `indentMore/indentLess`). Omitted: foldGutter, rectangularSelection, crosshairCursor, autocompletion. `updateListener`: on `docChanged` → `changes.ts` flattens `update.changes.iterChanges((fromA,toA,_,_,ins) => list.push({from:fromA,to:toA,insert:ins.toString()}))`, `version++`, calls `onChanges` handlers synchronously; cursor and scroll notifications are rAF-coalesced; the listener never touches the DOM. `setDoc` = `view.setState(EditorState.create(...))` (10 MB ≈ 60–120 ms, once). Commands (`commands.ts`, registered with `scope:'editor'`): `edit.bold` `**`, `edit.italic` `_`, `edit.code` `` ` `` (toggle-wrap; cursor-only inserts a pair and places the cursor inside), `edit.link` (`[sel](url)` with `url` selected; if the clipboard holds a URL, use it), `edit.heading1..6/paragraph` (rewrite the line prefix), `edit.toggleTask`, `edit.find` (`openSearchPanel`), `edit.gotoLine`. Toolbar (`.mdr-toolbar > button.mdr-toolbar__btn[data-cmd]`) and palette (`.mdr-palette` overlay with `.mdr-palette__input` and `.mdr-palette__list > .mdr-palette__item`, fuzzy match over `title`) both read `registry.list()`.

**Size-gated language** (a `Compartment`, re-evaluated only in `setDoc`, never per keystroke): ≤ 128 KB full `markdown({ base: markdownLanguage, codeLanguages: languages })`;
≤ 256 KB `markdown()` without `codeLanguages`; above that **no language extension at all** (plain text; every other extension unchanged).
Independently, a document with a line longer than 50 000 chars is gated to no language **and** no `lineWrapping` (CodeMirror's MutationObserver
read-back of one wrapped 1 MB line is the whole cost). Either downgrade emits the toast 「大文件：已关闭语法高亮以保持流畅」 once; `setLineWrap(true)`
overrides the long-line wrap veto for the current document and the next `setDoc` re-arms it. The thresholds are derived from the measured
per-keystroke `view.dispatch` cost against the P5 budget (§11) — the tree-building markdown parser costs 6–14 ms per keystroke once a document has
≈13 000 top-level blocks — and are asserted in `test/editor.api.test.ts`; the measured table lives in the gate comment in `createEditor.ts`.

## 8. Shell (E4)
**Layout** (`layout.ts`) builds:
```
div.mdr-app[data-mode=split][data-toc=open]      grid-template-rows: auto 1fr auto
  header.mdr-toolbar
  div.mdr-main                                     grid-template-columns: var(--toc-w,240px) var(--split,1fr) 6px 1fr
    aside.mdr-toc  div.mdr-editor  div.mdr-gutter  div.mdr-preview
  footer.mdr-statusbar > span.mdr-statusbar__item[data-stat=pos|words|chars|reading|file|mode|progress]
  div.mdr-overlay (toasts .mdr-toast, dialogs .mdr-dialog, palette)
```
`[data-mode=edit] .mdr-preview, [data-mode=preview] .mdr-editor, .mdr-gutter { display:none }`; on mode change App calls `editor.setVisible`, `preview.setVisible`, `sync.setEnabled(mode==='split')`, then `sync.syncNow(previousVisiblePane)` so the shown pane lands on the same line. `Mod-/` cycles edit → split → preview. Gutter drag sets `--split` (persisted `LS_SPLIT`). **Theme** (`theme.ts`): pref in `LS_THEME`; `system` follows `matchMedia('(prefers-color-scheme: dark)')`; applied as `document.documentElement.dataset.theme`; `tokens.css` defines all colours on `:root[data-theme=light|dark]`; `hljs.css` maps hljs classes to tokens (no upstream theme CSS). **Status bar**: `行 L, 列 C · 字数 N (cjk+latinWords) · 字符 N · 约 M 分钟 · 已保存/未保存/草稿已存/未命名 · 编辑/分栏/预览 · 渲染中 37%`. **Shortcuts** (`shortcuts.ts`): one `keydown` capture listener on `window`, skipped when the palette/dialog owns focus; matches `scope:'global'` commands via `matchShortcut`. Table:

| Shortcut | Command | Scope |
|---|---|---|
| Mod-s / Mod-Shift-s / Mod-o | 保存 / 另存为 / 打开 | global |
| Mod-/ · Mod-Shift-p · Mod-Shift-o · Mod-Shift-l | 切换模式 · 命令面板 · 显示/隐藏目录 · 切换主题 | global |
| Mod-b / Mod-i / Mod-e / Mod-k | 加粗 / 斜体 / 行内代码 / 链接 | editor |
| Mod-1..6 / Mod-0 · Mod-Shift-x | 标题级别 / 正文 · 切换任务项 | editor |
| Mod-f · Mod-g / Mod-Shift-g · Mod-Alt-g | 查找/替换面板 · 下/上一个 · 跳转到行 | editor (CM search keymap) |
| Enter / Backspace / Tab / Shift-Tab | 列表续行 / 删除标记 / 缩进 / 反缩进 | editor |

**Startup** (`App.ts`): `bus, registry, theme, layout → editor → preview({request: worker.need, viewport: worker.viewport}) → toc, sync, statusbar, toolbar, palette → worker = createWorkerClient({onStructure: m => { preview.applyStructure(m); statusbar.setStats(m.stats); bus.emit('stats:changed') }, onOutline: it => { preview.applyOutline(it); toc.setOutline(it); bus.emit('outline:changed') }, onHtml: preview.applyHtml, onIdle: progress→null, onRestart: () => ({docId, version: editor.version, text: editor.getText()}) })`, `editor.onChanges((v,ch) => { worker.edit(v,ch); updateDirty() })`, `bus.on('doc:cursor', e => { toc.setActiveLine(e.line); statusbar.setCursor })`, `bus.on('source:edit', editor.applySourceEdit)`. Then restore mode/theme/toc, `openFile(files.newFile())`, and if a draft for `untitled` exists offer restore. **Open flow**: dirty guard (`confirm('当前文档尚未保存，是否放弃更改？')`) → `v = editor.setDoc(text)` → `worker.setDoc(docId, v, text)` → `worker.draft('enable')` → `savedVersion = v` → `recent.push` → `drafts.get(docId)`: if `at > lastModified && text !== file.text` → toast bar「发现未保存的草稿，是否恢复？ 恢复 / 丢弃」. **Dirty** = `editor.version !== savedVersion`; `document.title = (dirty ? '● ' : '') + name`; `beforeunload` guard; `visibilitychange→hidden` → `worker.draft('flush')`. **Save**: `files.save(file, editor.getText())` → on ok `savedVersion = editor.version`, `worker.draft('clear')`, `drafts.del`. **WorkerClient**: posts `init` then messages; `viewport` throttled 100 ms; `need` coalesced per frame; restart on `worker.onerror`, `error.fatal`, or no `structure` within 10 s of `setDoc`/`edit`: `terminate()`, new Worker, `init`, `setDoc(onRestart())`, toast「渲染器已重启」; max 3 restarts/min, then a static `.md-error` toast. `exportHtml` → wraps in a standalone template with inlined CSS (`?inline` imports) → download. `?perf=1` overlay (`perfOverlay.ts`): keystroke→mount latency, last 20 `perf:sample`s, longtask count, mounted block count.

**Files** (`src/files`): `FsaBackend` when `'showOpenFilePicker' in window` (`types:[{description:'Markdown', accept:{'text/markdown':['.md','.markdown','.txt']}}]`; save = `queryPermission({mode:'readwrite'})` → `requestPermission` (user gesture) → `createWritable()/write/close`), else `LegacyBackend` (`<input type=file>`, `Blob` + `<a download>`, `canSaveInPlace=false`, toolbar shows「下载」). `docId`: `recent.findByHandle(h)` (`isSameEntry` over ≤10 entries) reuses the stored id, else `crypto.randomUUID()`; legacy files `'legacy:' + name`. Drag&drop on `.mdr-app` (`.is-dragover` class): `item.getAsFileSystemHandle?.()` → `getAsFile()`. Recent (`idb-keyval`, `IDB_RECENT`, `MAX_RECENT`): reopen `NotFoundError` → remove entry + toast; `NotAllowedError` → toast「需要重新授权」. All IDB in try/catch.

## 9. Error handling (summary)
| Failure | Handling |
|---|---|
| Worker crash / fatal error / 10 s silence | restart + full-text resend, ≤3/min, toast |
| markdown-it / hljs / KaTeX throws on a block | `.md-error` block, pass continues |
| KaTeX import fails | `math=false`, `$$` shown as text, one toast |
| HTML for unknown id / outside window | dropped; re-requested by `updateWindow` |
| Giant block (unclosed fence at top) | worker: no hljs > 30k chars, PLAIN > 200k chars, 300 ms throttle; main: mount deferred until 500 ms stable |
| FSA unavailable / permission denied | legacy backend / `SaveResult.permission` toast |
| IndexedDB unavailable | drafts/recent are no-ops |
| Hash collision (64-bit) | negligible; self-heals on next edit |

## 10. Keystroke budget (10 MB, typing in a paragraph)
CM transaction + view update 1–3 ms · `iterChanges` + `postMessage` < 0.1 ms · worker: splice + resegment + hash + stats 0.2–1 ms, render 0.1–2 ms, structure fill 0.1 ms · main: reconcile 0.05 ms, `unpackHtml` + sanitize + `replaceChildren` 0.3–1 ms, RO callback < 0.1 ms. **Main-thread total ≈ 2–5 ms; preview updates within 1–2 frames.** Initial 10 MB: `file.text()` ~15 ms, CM state ~100 ms (one task), worker split+segment+hash ~120 ms off-main, wrappers in 5–8 rAF slices, first viewport HTML mounted at ~300–400 ms.

## 11. Performance test plan (`bench/`, `npm run perf`)
`gen-fixture.ts` (seeded): `small 50 KB`, `medium 1 MB`, `large 10 MB (~100k lines)`: 40% zh/en paragraphs, 20% nested loose lists with tasks, 15% fences (ts/py/json, some 2k lines), 10% tables, 10% headings (~3k in large), 5% quotes/math/HTML; plus `pathological.md` (one 5 MB paragraph; 20k one-line blocks; one 50k-line fence). Playwright Chromium, 1× and 4× CPU throttle (4× targets = 3× the numbers), collects User-Timing marks (`mdr:open`, `mdr:structure`, `mdr:first-visible`, `mdr:idle`), `PerformanceObserver` `longtask` + `long-animation-frame`, `perf:sample` events, `measureUserAgentSpecificMemory`. CI fails on any target miss or > 20% regression vs `bench/baseline.json`; P5/P11/P13/P15 on every PR, all nightly.

| # | Scenario (large.md unless noted) | Metric | Target (1×) |
|---|---|---|---|
| P1 | open | `mdr:open` → `mdr:first-visible` | < 400 ms |
| P2 | open | → first keystroke echoed | < 600 ms |
| P3 | open | → outline visible / `mdr:idle` | < 800 ms / < 20 s |
| P4 | open | longest main task; long tasks after t = 1 s | < 120 ms (CM state) ; 0 > 50 ms |
| P5 | type 200 chars mid-doc at 60 wpm | main-thread work per keystroke p95 / max; keystroke → block mounted p95 | < 5 ms / < 10 ms ; < 40 ms |
| P6 | type in 300-line / 5k-line fence | main p95 | < 8 ms / < 16 ms |
| P7 | unclosed ``` at line 1 then close | input latency p95; tasks > 100 ms | < 16 ms ; ≤ 1 (deferred giant mount) |
| P8 | preview wheel 20 screens | frames > 20 ms; forced layouts > 2 ms; editor follows | < 3 % ; 0 ; ≤ 1 frame |
| P9 | editor PageDown ×100 | same, reverse | same |
| P10 | 50 random sync positions | block error / fraction error | ≤ 1 block / < 0.25 |
| P11 | undo ×50 / redo ×50 | main p95 per step; worker cache hits | < 5 ms ; 100 % |
| P12 | mode ×20, theme ×20 | longest task | < 50 ms |
| P13 | memory after load + 1 min typing + scroll to end | renderer process | < 450 MB (go/no-go: lower eviction distance to 10H) |
| P14 | save 10 MB via FSA; draft write | total; main-thread task caused | < 300 ms ; < 5 ms |
| P15 | vitest (Node) worker benches | `segmentAll` 100k lines; `resegmentWindow` local edit; render medium.md; throughput | < 40 ms ; < 1 ms ; < 800 ms ; ≥ 5 MB/s |

## 12. Work partition

| Engineer | Owns (files) | Builds against (day 0) | Must NOT touch |
|---|---|---|---|
| E1 worker | `src/worker/*`, `test/segmenter.test.ts`, `bench/worker.bench.ts` | `ToWorker/FromWorker`, `packHtml`, fixtures; tested in Node with vitest, no DOM | any `src/preview`, `src/editor`, `src/app`, `src/files`; `src/shared/*` (PR only) |
| E2 preview | `src/preview/*`, `styles/preview.css`, `styles/hljs.css` | `PreviewApi/ScrollSyncApi/TocApi`, a recorded-message fake worker and a fake `EditorApi` | worker code, editor internals, `App.ts`, tokens/layout CSS |
| E3 editor | `src/editor/*`, `styles/editor.css` | `EditorApi`, `CommandRegistry` (fake), standalone test page | preview, worker, app, files, shared |
| E4 shell/files | `src/app/*`, `src/files/*`, `main.ts`, `index.html`, `vite.config.ts`, `styles/tokens.css`, `styles/layout.css`, `bench/gen-fixture.ts`, `bench/perf.spec.ts` | stubs implementing every `Create*` type until real modules land | anything inside `src/editor`, `src/preview`, `src/worker`; `src/shared/*` |

Integration order: E4 wires stubs on day 1; real modules are swapped by replacing one import each. `App.ts` is the only file importing from more than one module directory.

## 13. Tradeoffs (stated plainly)
- Independent block rendering is not bit-identical CommonMark for HTML blocks spanning blank lines, lazy continuation after a blank line, and multi-line reference titles; fixture tests enumerate accepted deviations. Footnotes are unsupported.
- The text exists twice (CM rope + worker `lines[]`); that is the price of zero main-thread parsing.
- Sanitizing on main (~0.3–1 ms per mounted block) keeps inline HTML working; PLAIN mounting bypasses it only for worker-escaped code text.
- Eviction beyond 20 screens means native Cmd+F/print in the preview see only nearby content; `view.mountAll` (「全部渲染」) restores full DOM at ~1–2 s for 10 MB; Cmd+F is routed to the editor's search panel.
- Scroll sync is linear within a block; a 2k-line code block drifts within itself (bounded by P10).
- Undo/redo costs a worker round trip (cache hit) plus one DOM replace instead of a main-side cache; simpler ownership, ~1 ms more latency.
- Stats/outline are exact and O(window) per keystroke but the outline is only ATX + 2-line setext.