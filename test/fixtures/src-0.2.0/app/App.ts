// src/app/App.ts — composition root (SPEC §8 "Startup"). The only file importing across module
// directories. Owns the session: current file, saved/draft versions, open/save/draft flows, mode,
// TOC, theme, global commands, drag & drop, export, test hooks (window.__mdr) and the ?perf=1 overlay.
import {
  BLOCK_STRIDE,
  LS_MODE,
  LS_PREVIEW_EDIT,
  LS_TOC,
  type CommandId,
  type CommandRegistry,
  type DocStats,
  type DraftRecord,
  type EditorApi,
  type EventBus,
  type FileState,
  type LayoutApi,
  type Mode,
  type OpenedFile,
  type PaletteApi,
  type PreviewApi,
  type RecentEntry,
  type ResolvedTheme,
  type ScrollSyncApi,
  type ThemeApi,
  type ThemePref,
  type ToastSpec,
  type TocApi,
  type ToolbarApi,
  type WorkerClientApi,
} from '../shared/types';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { createBus } from '../shared/bus';
import { T } from '../shared/i18n';
import { createEditor, disposeEditor } from '../editor/createEditor';
import { createToolbar, disposeToolbar, setToolbarEditorRouter, setToolbarPreviewEdit, setToolbarTheme } from '../editor/toolbar';
import { createPalette, disposePalette } from '../editor/palette';
import { createPreview } from '../preview/createPreview';
import { createScrollSync } from '../preview/scrollSync';
// `disposeToc` is the preview module's teardown hook for the frozen TocApi (side-table pattern, like
// disposeToolbar / disposeTheme).
import { createToc, disposeToc } from '../preview/toc';
import { sanitizeHtmlString } from '../preview/sanitize';
import { createCommandRegistry } from './registry';
import { createLayout, disposeLayout, installSplitResize } from './layout';
import { createTheme, disposeTheme } from './theme';
import { createStatusBar, disposeStatusBar, setStatusPreviewEditing } from './statusbar';
import { installShortcuts } from './shortcuts';
import { createWorkerClient } from './workerClient';
import { createToasts } from './toast';
import { wireFocusLine } from './focusLine';
import { createPreviewEdit, createSourceAccess, parsePreviewEditPref, PREVIEW_EDIT_T, previewWriteGate, SESSION_FORMAT_COMMANDS, shortcutKeyEvent } from './previewEdit';
import { loadInlineEdit } from '../preview/inlineEditLoader';
import { confirmDialog, createDocumentGuard, createQuestionGate } from './dialogs';
import { createNativeOpener, installNative, installUnloadGuard, OPEN_FAIL_T, openFailureToast, type NativeWiring } from './native';
import { createPerfOverlay, type PerfOverlayApi } from './perfOverlay';
import { getNative } from '../shared/native';
import { createFileService, isMarkdownDrop, UNTITLED_ID } from '../files/fileService';
import {
  encodingOf,
  isLegacyEncoding,
  isNativeFileService,
  openPath as readNativePath,
  saveProblem,
} from '../files/nativeBackend';
import { createDraftStore } from '../files/drafts';
import { createRecentStore } from '../files/recent';
import { downloadText } from '../files/legacyBackend';

export interface AppHandle {
  editor: EditorApi; preview: PreviewApi; bus: EventBus; registry: CommandRegistry; worker: WorkerClientApi;
  layout: LayoutApi; theme: ThemeApi;
  loadText(text: string, name?: string): Promise<void>;
  getText(): string;
  dispose(): void;
}

export interface PerfSample { name: string; ms: number; at: number }
/** Test hooks installed on window.__mdr in dev and with ?perf=1 (CONTRACT §4). */
export interface MdrHooks {
  app: AppHandle;
  loadText(text: string, name?: string): Promise<void>;
  loadUrl(url: string): Promise<void>;
  marks(): PerformanceEntry[];
  samples(): PerfSample[];
  waitIdle(): Promise<void>;
  mode(m: Mode): void;
  version(): number;
}
declare global {
  interface Window { __mdr?: MdrHooks }
}

const MODES: Mode[] = ['edit', 'split', 'preview'];
const PROGRESS_MIN_BLOCKS = 100;
const MAX_SAMPLES = 200;
const OPEN_FILE_LABEL = '打开文件…';
const NO_RECENT_LABEL = '暂无最近文件';
const UNSUPPORTED_FILE = '仅支持打开 Markdown 文本文件（.md / .markdown / .txt）';
/** Desktop-only zh-CN strings (src/shared/i18n.ts is frozen). */
const LEGACY_ENCODING_TOAST = (label: string): string =>
  `该文件是 ${label.toUpperCase()} 编码，已按原编码读取，保存时也写回 ${label.toUpperCase()}`;
const CONFLICT_TOAST = '文件已被其他程序修改';
const OVERWRITE_LABEL = '覆盖保存';
const RELOAD_LABEL = '重新载入';
const SAVE_AS_LABEL = '另存为…';
const DRAFT_OTHER_DOC = '该草稿属于其他文档，已忽略';
/** R4: 恢复 after the document changed while the offer was up (the restore replaces that text). */
const DRAFT_RESTORE_OVER = '草稿提示出现后文档又有改动，恢复草稿将替换当前内容，是否继续？';
const REMOTE_BLOCKED_TOAST = '已阻止该文档载入远程内容（桌面版隐私保护）';
/** How long the scratch buffer waits for the shell's launch document before offering its draft.
 *  The document a user double-clicked must be the only thing on screen; the queued path arrives one
 *  IPC hop after `onOpenFile` is subscribed, which is far inside this window. */
const LAUNCH_SETTLE_MS = 400;
/** Below this width layout.css gives the TOC no column and floats an open one over the editor pane
 *  instead (see the media query there and `createTocVisibility` below). */
const NARROW_QUERY = '(max-width: 900px)';
/** Frames on which a mode switch re-checks that the newly shown pane still sits on the captured line. */
const MODE_SETTLE_PASSES = 3;
const MODE_SETTLE_FRACTION = 0.25;
/** Installed KaTeX version (node_modules/katex); its fonts are referenced from the CDN by the export. */
const KATEX_VERSION = '0.18.5';
const KATEX_FONT_CDN = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/fonts/`;
/** `url(<vite path>/KaTeX_Main-Regular[-hash].woff2)` as Vite rewrites it in dev and build. */
const KATEX_FONT_URL_RE = /url\((['"]?)[^)'"]*?(KaTeX_[A-Za-z0-9]+-[A-Za-z]+)(?:-[A-Za-z0-9_-]+)?\.(woff2|woff|ttf)\1\)/g;

const isMode = (v: string | null): v is Mode => v !== null && (MODES as string[]).includes(v);

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no persistence */
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface ProgressTracker {
  /** A new structure arrived: forget the old ids; `active` gates the indicator (big passes only). */
  reset(active: boolean): void;
  /** Preview → worker `need`: these blocks are now in flight. */
  requested(ids: readonly number[]): void;
  /** Worker → preview HTML: delivered blocks count on both sides (the window is pushed unrequested). */
  delivered(ids: ArrayLike<number>): void;
}

/** SPEC §8 「渲染中 37%」. The worker renders lazily: only the blocks the preview asks for (plus the
 *  auto-pushed viewport window) are rendered before it goes idle, so "every block of the document" is
 *  a denominator that can never be reached — measuring against it pinned the indicator at 「渲染中 0%」
 *  for the few hundred ms it was visible. Progress is the share of the blocks actually in flight that
 *  have arrived (requested ∪ delivered as the total, delivered as the numerator); it grows with every
 *  batch and reaches 100% with the last one before `idle` hides it. */
export function createProgressTracker(set: (fraction: number | null) => void): ProgressTracker {
  let active = false;
  const wanted = new Set<number>();
  const got = new Set<number>();
  const update = (): void => {
    if (!active || wanted.size === 0) return;
    set(got.size / wanted.size);
  };
  return {
    reset(on) {
      active = on;
      wanted.clear();
      got.clear();
      set(null);
    },
    requested(ids) {
      if (!active) return;
      let added = false;
      for (const id of ids) {
        if (got.has(id) || wanted.has(id)) continue;
        wanted.add(id);
        added = true;
      }
      if (added) update();
    },
    delivered(ids) {
      if (!active) return;
      for (let i = 0; i < ids.length; i++) {
        wanted.add(ids[i]);
        got.add(ids[i]);
      }
      update();
    },
  };
}

/**
 * 视图 → 切换主题 as a cycle instead of a switch (fix round 2). The old toggle always wrote an
 * explicit light/dark preference, so after one ⇧⌘L the window stopped following the macOS
 * appearance for good and nothing in the app could hand it back. Rules:
 *   - following the system → pin the opposite of what is on screen (a visible flip);
 *   - pinned → flip, unless that would land on the system's own appearance, in which case follow
 *     the system again (same pixels as the flip would give, and dark mode follows the OS from then on).
 * Every press therefore changes what the user sees, and every second press returns to 跟随系统.
 */
export function nextThemePref(pref: ThemePref, resolved: ResolvedTheme, system: ResolvedTheme): ThemePref {
  if (pref === 'system') return resolved === 'dark' ? 'light' : 'dark';
  const flipped: ThemePref = pref === 'dark' ? 'light' : 'dark';
  return flipped === system ? 'system' : flipped;
}

export interface TocVisibility {
  /** Whether the TOC is on screen right now (what the toolbar button must report). */
  shown(): boolean;
  /** The 显示/隐藏目录 command. Narrow: opens/closes the overlay only. Wide: sets and persists the preference. */
  set(on: boolean): void;
  /** Esc / outside click / a TOC navigation. Only the narrow overlay closes; the wide preference is untouched. */
  closeOverlay(): void;
  /** Whether the narrow overlay is currently up — a free check for the document-level dismiss listeners. */
  overlayOpen(): boolean;
  /** Startup: apply the stored preference without writing it back, overlay closed. */
  restore(pref: boolean): void;
  /** The (max-width: 900px) media query flipped. */
  breakpointChanged(): void;
}

/**
 * TOC visibility policy. Below 900 px there is no room for a third column, so layout.css floats an open
 * TOC over the editor pane (an overlay panel) instead of giving it one. Two separate states keep that
 * honest: `pref` is the persisted wide-layout preference, `overlay` is the session-only state of the
 * narrow panel. A narrow-screen toggle therefore has a visible effect AND leaves the stored preference
 * alone — it used to do neither (it silently wrote `mdr.toc=closed`, and the TOC was then missing the
 * next time the window was wide).
 */
export function createTocVisibility(o: { isNarrow(): boolean; apply(shown: boolean): void; persist(on: boolean): void }): TocVisibility {
  let pref = true;
  let overlay = false;
  const shown = (): boolean => (o.isNarrow() ? overlay : pref);
  const push = (): void => o.apply(shown());
  return {
    shown,
    // `overlay` is only ever set while narrow (and cleared by breakpointChanged), so this needs no
    // media query — it runs on every pointerdown in the app.
    overlayOpen: () => overlay,
    set(on) {
      if (o.isNarrow()) {
        overlay = on;
        push();
        return;
      }
      pref = on;
      overlay = false;
      push();
      o.persist(on);
    },
    closeOverlay() {
      if (!overlay || !o.isNarrow()) return;
      overlay = false;
      push();
    },
    restore(next) {
      pref = next;
      overlay = false;
      push();
    },
    // Leaving the breakpoint drops the overlay and restores the stored preference; entering it starts
    // closed — a persisted `open` must not cover the editor with a panel the user did not ask for.
    breakpointChanged() {
      overlay = false;
      push();
    },
  };
}

/** Which pane's reading position a mode switch preserves (`master`, the pane visible before the switch)
 *  and which pane must be positioned from it afterwards (`follower`, the pane the user will look at). */
export function planModeSwitch(prev: Mode, next: Mode): { master: 'editor' | 'preview'; follower: 'editor' | 'preview' } {
  const master = prev === 'preview' ? 'preview' : 'editor';
  const follower = next === 'preview' ? 'preview' : next === 'edit' ? 'editor' : master === 'preview' ? 'editor' : 'preview';
  return { master, follower };
}

export const hasMath = (html: string): boolean => html.includes('class="katex');

/** Standalone export document: same DOM shape as the live preview so preview.css applies. The body is
 *  sanitized with the preview's DOMPurify configuration (markdown-it runs with html:true) and every
 *  stylesheet is inlined — no external resource is required to read the file. */
export function buildExportDocument(o: { title: string; html: string; css: string; theme: ResolvedTheme }): string {
  const overrides =
    'html,body{height:auto;overflow:auto}body{padding:32px 16px}' +
    '.mdr-preview{height:auto;overflow:visible}.mdr-preview__body{max-width:860px;margin:0 auto}';
  return (
    `<!doctype html><html lang="zh-CN" data-theme="${o.theme}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(o.title)}</title><style>${o.css}\n${overrides}</style></head>` +
    `<body><div class="mdr-preview"><article class="mdr-preview__body markdown-body">${sanitizeHtmlString(o.html)}</article></div></body></html>`
  );
}

/** KaTeX's stylesheet for the export: font faces point at the CDN (the woff2 set is ~1 MB, too large
 *  to embed); without network the page still reads fine with the system fallback fonts. */
export const relocateKatexFonts = (css: string): string => css.replace(KATEX_FONT_URL_RE, `url(${KATEX_FONT_CDN}$2.$3)`);

async function loadExportCss(withMath: boolean): Promise<string> {
  const [tokens, preview, hljs, katex] = await Promise.all([
    import('../styles/tokens.css?inline'),
    import('../styles/preview.css?inline'),
    import('../styles/hljs.css?inline'),
    withMath ? import('katex/dist/katex.min.css?inline') : Promise.resolve(null),
  ]);
  const parts = [tokens.default, preview.default, hljs.default];
  if (katex) parts.push(relocateKatexFonts(katex.default));
  return parts.join('\n');
}

/** Right-aligned file name + dirty dot in the toolbar; click opens the recent-files list. */
function createFileMenu(
  toolbar: HTMLElement,
  o: { listRecent(): Promise<RecentEntry[]>; openRecent(e: RecentEntry): void; openPicker(): void },
): { setName(n: string): void; setDirty(d: boolean): void; dispose(): void } {
  const doc = toolbar.ownerDocument;
  const host = doc.createElement('span');
  host.className = 'mdr-toolbar__file';
  host.setAttribute('role', 'button');
  host.tabIndex = 0;
  host.title = '最近文件';
  const dot = doc.createElement('span');
  dot.className = 'mdr-toolbar__dot';
  dot.hidden = true;
  const name = doc.createElement('span');
  name.className = 'mdr-toolbar__name';
  host.append(dot, name);
  toolbar.appendChild(host);

  let list: HTMLUListElement | null = null;
  const close = (): void => {
    list?.remove();
    list = null;
  };
  const item = (label: string, cls: string, run?: () => void): HTMLLIElement => {
    const li = doc.createElement('li');
    li.className = cls;
    li.textContent = label;
    if (run) li.addEventListener('click', () => { close(); run(); });
    return li;
  };
  const open = async (): Promise<void> => {
    if (list) return close();
    const ul = doc.createElement('ul');
    ul.className = 'mdr-recent';
    ul.setAttribute('role', 'menu');
    ul.appendChild(item(OPEN_FILE_LABEL, 'mdr-recent__item', o.openPicker));
    // Desktop entries carry a path instead of a handle (CONTRACT §10); both are reopenable.
    const entries = (await o.listRecent()).filter((e) => !!e.handle || !!e.path);
    if (entries.length === 0) ul.appendChild(item(NO_RECENT_LABEL, 'mdr-recent__empty'));
    for (const e of entries) ul.appendChild(item(e.name, 'mdr-recent__item', () => o.openRecent(e)));
    if (list) return;
    list = ul;
    host.appendChild(ul);
  };
  host.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.mdr-recent')) return;
    void open();
  });
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(); }
    if (e.key === 'Escape') close();
  });
  const onDocDown = (e: MouseEvent): void => {
    if (list && !host.contains(e.target as Node)) close();
  };
  doc.addEventListener('mousedown', onDocDown);

  return {
    setName(n) { name.textContent = n; },
    setDirty(d) { dot.hidden = !d; },
    dispose() { doc.removeEventListener('mousedown', onDocDown); host.remove(); },
  };
}

export async function createApp(root: HTMLElement): Promise<AppHandle> {
  const params = new URLSearchParams(location.search);
  const perfMode = params.get('perf') === '1';
  const hooksEnabled = import.meta.env.DEV || perfMode;
  // Rule L5 (RL-3): where the test hooks are installed and 预览可编辑 starts on, the editing chunk is asked for HERE and
  // awaited just before createPreviewEdit, so the editor and the preview are built while it is on its way and every
  // test script (they wait for the hooks) meets the editing module from the first moment, as before rule L. A user's
  // boot never waits for it (createPreviewEdit asks for it after the first idle). A failure here is swallowed: the
  // controller's own load fails again and reports it.
  const editChunk = hooksEnabled && parsePreviewEditPref(readLocal(LS_PREVIEW_EDIT), true)
    ? loadInlineEdit().then(() => {}, () => {})
    : null;

  // ---- construction order: bus, registry, theme, layout → editor → preview → toc, sync, statusbar, toolbar, palette → worker
  const bus = createBus();
  const registry = createCommandRegistry();
  const theme = createTheme();
  const layout = createLayout(root);
  const { els } = layout;

  const editor: EditorApi = createEditor({ parent: els.editor, bus, registry, theme: theme.resolved() });
  let worker: WorkerClientApi | null = null; // assigned below; the preview only calls these from rAF callbacks
  const previewWrites = previewWriteGate();
  /** U2 as amended (RVS-3): the mark of a history step run from outside the editor (historyOutside); the same one-shot
   *  gate as previewWrites, consumed by the cursor notification that step causes. */
  const historySteps = previewWriteGate();
  // CONTRACT §11: in-preview editing reads and writes the source through CodeMirror.
  const source = createSourceAccess(editor, previewWrites.note);
  const preview: PreviewApi = createPreview({
    parent: els.preview,
    bus,
    request: (ids) => {
      noteRequested(ids);
      worker?.need(ids);
    },
    viewport: (first, last) => worker?.viewport(first, last),
    // CONTRACT §8: the preview rejected a `structureDelta` it cannot apply. Ask the worker for a full
    // `structure` for the current version instead of letting the two sides drift apart silently.
    resync: () => worker?.resync(),
    source,
  });
  const toc: TocApi = createToc(els.toc, bus);
  const sync: ScrollSyncApi = createScrollSync(editor, preview, bus);
  const statusbar = createStatusBar(els.statusbar);
  const toolbar: ToolbarApi = createToolbar(els.toolbar, registry);
  setToolbarTheme(toolbar, theme.resolved());
  const palette: PaletteApi = createPalette(els.overlay, registry);
  const toasts = createToasts(els.overlay);
  const toast = (spec: ToastSpec): void => { toasts.show(spec); };
  /** G34: a failed open, one toast per file (`key`: its path, else 'name:' + its name); a successful open of
   *  that file removes it (openFile). */
  const openFailed = (key: string, spec: ToastSpec): void => toasts.failure(key, spec);
  const nameKey = (name: string): string => `name:${name}`;
  // 「预览可编辑」 (CONTRACT §11): the toggle (persisted; off by default for a user, on where the test hooks
  // are installed: createPreviewEdit's defaultOn) and the live session flag. Every
  // flow that reads or replaces the whole document — mode switch, open/new/close guards, export — calls
  // `previewEdit.commit()` first, so the session's last serialization is in CodeMirror by then; save only
  // `previewEdit.flush()`es (same guarantee, the session and its caret survive ⌘S).
  // Rule L8: a user's stored 预览可编辑 asks for the editing chunk after the worker's first idle (the start document is
  // rendered), never in competition with the worker script; 4 s at the latest (a worker that never becomes idle).
  let afterFirstIdle: Array<() => void> | null = [];
  let firstIdleTimer = 0;
  const drainFirstIdle = (): void => {
    if (firstIdleTimer) { clearTimeout(firstIdleTimer); firstIdleTimer = 0; }
    const q = afterFirstIdle;
    afterFirstIdle = null;
    if (q) for (const f of q) f();
  };
  const whenFirstIdle = (run: () => void): void => {
    if (!afterFirstIdle) { run(); return; }
    afterFirstIdle.push(run);
    if (!firstIdleTimer) firstIdleTimer = window.setTimeout(drainFirstIdle, 4000);
  };
  // Rule L3 (RL-2): while a load of the editing chunk for a wish of on is on its way, the toolbar button is aria-busy;
  // 300 ms after the user's press without the module, PREVIEW_EDIT_T.loading (once per load). Neither touches
  // aria-pressed or the stored value; both end when the load settles or the wish is withdrawn.
  let loadingTimer = 0;
  let loadingToast: (() => void) | null = null;
  const onEditLoading = (busy: boolean, byUser: boolean): void => {
    const btn = els.toolbar.querySelector('[data-cmd="view.togglePreviewEdit"]');
    if (busy) {
      btn?.setAttribute('aria-busy', 'true');
      if (byUser && !loadingTimer && !loadingToast) {
        loadingTimer = window.setTimeout(() => {
          loadingTimer = 0;
          loadingToast = toasts.show({ text: PREVIEW_EDIT_T.loading });
        }, 300);
      }
      return;
    }
    btn?.removeAttribute('aria-busy');
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = 0; }
    const dismiss = loadingToast;
    loadingToast = null;
    dismiss?.();
  };
  // Rule L5 (RL-3): the chunk asked for at the top of createApp (test hooks, switch on at start) is here before the
  // controller applies the start state, so it installs the module at once.
  if (editChunk) await editChunk;
  const previewEdit = createPreviewEdit({
    bus,
    preview,
    read: readLocal,
    write: writeLocal,
    onToggle: (on) => setToolbarPreviewEdit(toolbar, on),
    onSession: (active) => setStatusPreviewEditing(statusbar, active, PREVIEW_EDIT_T.editing),
    defaultOn: hooksEnabled,
    // Rule L4: the editing code could not be loaded (offline, a new deployment replaced the chunk): the switch stays off.
    onUnavailable: () => toast({ text: PREVIEW_EDIT_T.loadFailed, kind: 'error', timeoutMs: 6000 }),
    onLoading: onEditLoading,
    ...(hooksEnabled ? {} : { deferStart: whenFirstIdle }),
  });

  const recent = createRecentStore();
  const drafts = createDraftStore();
  const files = createFileService(recent);
  // Desktop shell (CONTRACT §10). Absent in the web build, where everything below is a no-op.
  const native = getNative();
  let nativeWiring: NativeWiring | null = null;
  /** Lets the native 另存为 dialog start in the current file's folder. */
  const noteOpened = isNativeFileService(files) ? (f: OpenedFile | null) => files.noteOpened(f) : () => {};
  const addNativeRecent = (path: string | undefined): void => {
    if (!native || !path) return;
    try {
      native.addRecent(path);
    } catch {
      /* the shell went away */
    }
  };

  // ---- session state
  let file: OpenedFile = files.newFile();
  /** R6 (J4): bumped whenever another document (or a restored draft) replaces the open one; a save
   *  that completes after a bump changes nothing of the open document. */
  let docEpoch = 0;
  let savedVersion = 0;
  let draftVersion = -1;
  /** R4: the editor version at which the document needs no draft — it was loaded, restored or saved
   *  then. The visibility flush writes only for text changed since (an unanswered crash-recovery offer
   *  must not be overwritten by the clean document). */
  let draftBase = 0;
  /** R4: the last draft write of THIS tab the worker confirmed; a discard deletes only that one. */
  let ownDraft: { docId: string; version: number; at: number } | null = null;
  /** The restore offer on screen (G36: one offer, not one per 新建). */
  let draftOffer: (() => void) | null = null;
  /** R5 (H5): the recovery offer of `docId` is unanswered (neither 恢复 nor 丢弃 ran for this document);
   *  `base` is the text the document was loaded with (or last saved as). */
  let r5: { docId: string; base: string } | null = null;
  /** R5: the worker's drafts are paused because the text is back to `r5.base`. */
  let r5Paused = false;
  let dirty = false;
  let lastTitle = '';
  let workerIdle = true;
  let idleWaiters: Array<() => void> = [];
  /** Two animation frames (or 100 ms in a hidden tab, where rAF does not run). */
  const framesSettled = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const fin = (): void => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(fin));
      setTimeout(fin, 100);
    });
  const samples: PerfSample[] = [];
  let perf: PerfOverlayApi | null = null;
  /** With the desktop shell present the launch document (the file the user double-clicked) is still
   *  on its way while the empty scratch buffer opens — the shell flushes it one IPC hop after
   *  `onOpenFile` is subscribed, which happens at the very end of createApp. Anything that would
   *  talk about the scratch buffer waits this out first. */
  let launchPending = !!native;
  const launchSettled: Promise<void> = launchPending
    ? new Promise<void>((resolve) => {
        setTimeout(() => {
          launchPending = false;
          resolve();
        }, LAUNCH_SETTLE_MS);
      })
    : Promise.resolve();
  /** Toasts that only make sense for one document (a draft offer, a save conflict, a blocked remote
   *  image): when another document takes the screen they go with it. */
  let docToasts: Array<{ docId: string; dismiss(): void }> = [];
  const showDocToast = (spec: ToastSpec): void => {
    docToasts.push({ docId: file.docId, dismiss: toasts.show(spec) });
  };
  const dropDocToasts = (keepDocId: string): void => {
    const keep: typeof docToasts = [];
    for (const t of docToasts) {
      if (t.docId === keepDocId) keep.push(t);
      else t.dismiss();
    }
    docToasts = keep;
  };
  let remoteBlockedShown = false;

  const isDirty = (): boolean => editor.version !== savedVersion;
  const fileState = (): FileState => {
    if (!dirty) return file.source === 'new' ? 'untitled' : 'saved';
    return draftVersion === editor.version ? 'draft' : 'dirty';
  };

  const fileMenu = createFileMenu(els.toolbar, {
    listRecent: () => recent.list(),
    openRecent: (e) => void openRecent(e),
    openPicker: () => void openViaPicker(),
  });

  // Status refresh is rAF-coalesced: onChanges runs inside CM's update listener and must not touch the DOM.
  let statusFrame = 0;
  const refreshStatus = (): void => {
    statusFrame = 0;
    const d = isDirty();
    if (d !== dirty) {
      dirty = d;
      toolbar.setDirty(d);
      fileMenu.setDirty(d);
      bus.emit('file:dirty', d);
    }
    const title = (d ? '● ' : '') + file.name;
    if (title !== lastTitle) {
      lastTitle = title;
      document.title = title;
    }
    statusbar.setFile(file.name, fileState());
    fileMenu.setName(file.name);
    reportNative();
  };
  /** Check item 7: the shell asks the close / quit question only while ITS copy of the dirty flag is set
   *  (electron/main.mjs). That copy must not lag behind a keystroke: an editor change reports it at once
   *  (onChanges), and input in a preview session — not in CodeMirror until the session's next frame — reports
   *  "dirty" right away (`sessionInput`); the close question itself then commits the session and asks the
   *  real isDirty(). The window title, the macOS "edited" dot and the shell's close/quit guard all follow it. */
  let sessionInput = false;
  const reportNative = (): void => {
    nativeWiring?.setDocumentState({ path: file.path ?? null, name: file.name, dirty: isDirty() || sessionInput });
  };
  const scheduleStatus = (): void => {
    if (!statusFrame) statusFrame = requestAnimationFrame(refreshStatus);
  };

  const progress = createProgressTracker((f) => statusbar.setProgress(f));
  const noteRequested = (ids: number[]): void => progress.requested(ids);

  // Shared by the full `structure` and the per-edit `structureDelta` (CONTRACT §7): both carry the
  // document's stats and both restart the progress counters. Only a big pass (a load, a paste, an
  // option change) gets an indicator; a keystroke must not flash one. `pending` is the number of blocks
  // this message put in play — for a delta that is the replaced range, never the whole document.
  const afterStructure = (stats: DocStats, pending: number): void => {
    statusbar.setStats(stats);
    bus.emit('stats:changed', stats);
    workerIdle = false;
    progress.reset(pending >= PROGRESS_MIN_BLOCKS);
  };

  worker = createWorkerClient({
    onStructure(m) {
      preview.applyStructure(m);
      // The counters restart with every structure: block ids may have been reset.
      afterStructure(m.stats, m.changed.length || m.blocks.length / BLOCK_STRIDE);
    },
    onStructureDelta(m) {
      preview.applyStructureDelta(m);
      afterStructure(m.stats, m.changed.length || m.inserted.length / BLOCK_STRIDE);
    },
    onOutline(items) {
      preview.applyOutline(items);
      toc.setOutline(items);
      bus.emit('outline:changed', items);
    },
    onHtml(m) {
      preview.applyHtml(m);
      progress.delivered(m.batch.ids);
    },
    onIdle() {
      workerIdle = true;
      // (an idle period after it: the first blocks mount before the chunk is asked for)
      if (afterFirstIdle) { if (typeof requestIdleCallback === 'function') requestIdleCallback(drainFirstIdle, { timeout: 1000 }); else queueMicrotask(drainFirstIdle); }
      performance.mark('mdr:idle');
      progress.reset(false);
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    },
    onDraftSaved(docId, version, at) {
      ownDraft = { docId, version, at };
      if (docId !== file.docId) return;
      draftVersion = version;
      scheduleStatus();
    },
    onError(message, fatal) {
      toast({ text: message, kind: fatal ? 'error' : 'info' });
    },
    onRestart: () => ({ docId: file.docId, version: editor.version, text: editor.getText() }),
  });
  const w: WorkerClientApi = worker;

  // ---- editor / bus wiring
  const offChanges = editor.onChanges((v, ch) => {
    // The window survived a 不保存 (the shell kept it after all): the next edit is worth a draft again.
    if (draftsSuspended) {
      draftsSuspended = false;
      w.draft('enable');
    }
    r5Check();
    // An edit in flight means the worker is not idle: waitIdle() must resolve at the idle that follows
    // this version, not immediately (the structure for it has not arrived yet).
    workerIdle = false;
    w.edit(v, ch);
    perf?.markKeystroke();
    // The session's pending input (if any) is in the document now.
    sessionInput = false;
    reportNative();
    scheduleStatus();
  });
  // The ONE place that knows where a cursor notification came from (finding high 1, CONTRACT §11): a write
  // from an in-preview editing session moves CodeMirror's caret to the edited block (createSourceAccess) and
  // the editor reports that rAF-late, coalesced, as `typing`. It is the preview's edit, not typing in the
  // editor: it is announced with `typing: false`, so nothing that follows editor typing (scroll sync's
  // cursor-follow, the focus line) moves; the status bar and the TOC still follow its line — the edited
  // block. `previewWrites.consume()` runs for every notification, so a write's mark never outlives the
  // notification it caused.
  // U2 as amended (CONTRACT §11, Checkpoint-C decisions, RVS-3): the notification a history step from outside the editor
  // causes (historyOutside's mark, consumed here for EVERY notification as well) is that step's — not a preview write
  // even when the step's own commit of a live session wrote in the same frame — and it carries `follow`: the preview
  // follows it although the editor has no focus.
  let cursorFromPreview = false;
  const offCursor = editor.onCursor((line, col, typing) => {
    const step = historySteps.consume();
    cursorFromPreview = previewWrites.consume() && !step;
    try {
      bus.emit('doc:cursor', { line, col, typing: typing && !cursorFromPreview, ...(step ? { follow: true } : {}) });
    } finally {
      cursorFromPreview = false;
    }
  });
  // Focus line (CONTRACT §9): caret/selection in one pane → the same subtle tint on the matching line
  // in the other. Subscribes to 'doc:cursor' and 'focus:line' itself.
  const focusLine = wireFocusLine(bus, editor, preview, {
    previewWrite: () => cursorFromPreview,
    previewEditing: () => previewEdit.sessionActive(),
  });
  const unsub = [
    bus.on('doc:cursor', (e) => {
      toc.setActiveLine(e.line);
      statusbar.setCursor(e.line, e.col);
    }),
    bus.on('source:edit', (e) => editor.applySourceEdit(e)),
    // A narrow-screen TOC overlay covers the editor: navigating from it is the end of its job.
    bus.on('nav:gotoLine', (e) => { if (e.source === 'toc') tocVis.closeOverlay(); }),
    bus.on('toast', toast),
    theme.onChange((t) => {
      editor.setTheme(t);
      setToolbarTheme(toolbar, t);
      bus.emit('theme:changed', t);
    }),
  ];
  // Check item 7: text typed in a preview session counts for the shell's close guard before the session's
  // frame writes it into CodeMirror (see reportNative).
  const onPreviewInput = (e: Event): void => {
    if (!nativeWiring || sessionInput) return;
    // The session's editing host (contenteditable="true"): not a task checkbox, not the link input.
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== 'function' || !t.closest('[contenteditable="true"]')) return;
    sessionInput = true;
    reportNative();
  };
  els.preview.addEventListener('input', onPreviewInput, true);
  unsub.push(
    () => els.preview.removeEventListener('input', onPreviewInput, true),
    // The session ended: whatever it had is written (onChanges cleared the hint) or there was nothing.
    bus.on('previewEdit:session', (e) => {
      if (e && e.id === null && sessionInput) {
        sessionInput = false;
        reportNative(); // at once, as the hint was set (integrator: the rAF path made the clear lag a frame)
      }
    }),
  );
  if (hooksEnabled) {
    unsub.push(
      bus.on('perf:sample', (s) => {
        samples.push({ name: s.name, ms: s.ms, at: performance.now() });
        if (samples.length > MAX_SAMPLES) samples.shift();
      }),
    );
  }

  // ---- mode / toc / theme
  const panes = { editor, preview } as const;
  let modeSettleRaf = 0;
  /** Puts `follower` on the captured line and re-checks on the next frames: a pane that has just become
   *  visible measures afterwards (CodeMirror line heights, preview block mounts), which can shift its
   *  top line away from where scrollToLine put it. In split mode the other pane follows through the sync. */
  const restorePosition = (follower: 'editor' | 'preview', pos: { line: number; fraction: number }, split: boolean): void => {
    const pane = panes[follower];
    const apply = (): void => {
      pane.scrollToLine(pos.line, pos.fraction);
      if (split) sync.syncNow(follower);
    };
    apply();
    let passes = 0;
    const check = (): void => {
      modeSettleRaf = 0;
      const got = pane.topVisible();
      if (got.line !== pos.line || Math.abs(got.fraction - pos.fraction) > MODE_SETTLE_FRACTION) apply();
      if (++passes < MODE_SETTLE_PASSES) modeSettleRaf = requestAnimationFrame(check);
    };
    if (modeSettleRaf) cancelAnimationFrame(modeSettleRaf);
    modeSettleRaf = requestAnimationFrame(check);
  };
  const applyMode = (m: Mode, initial: boolean): void => {
    const prev = layout.getMode();
    if (!initial && prev === m) return;
    if (!initial) previewEdit.commit();
    // Capture the reading position BEFORE any pane is hidden: a display:none scroller reads scrollTop 0.
    const plan = initial ? null : planModeSwitch(prev, m);
    const pos = plan ? panes[plan.master].topVisible() : null;
    layout.setMode(m);
    editor.setVisible(m !== 'preview');
    preview.setVisible(m !== 'edit');
    sync.setEnabled(m === 'split');
    // Focus before positioning: the focusin elects the editor as scroll master; positioning below
    // re-elects the follower explicitly through syncNow.
    if (!initial && m !== 'preview') editor.focus();
    // That focus() is ours, not the user's: its `focusin` just made the editor drop the preview's
    // mirror. Put the remembered focus line back so both panes keep tinting the same line (CONTRACT §9).
    if (!initial) focusLine.reassert();
    if (plan && pos) restorePosition(plan.follower, pos, m === 'split');
    toolbar.setMode(m);
    statusbar.setMode(m);
    bus.emit('mode:changed', m);
    writeLocal(LS_MODE, m);
  };
  const setMode = (m: Mode): void => applyMode(m, false);
  const cycleMode = (): void => setMode(MODES[(MODES.indexOf(layout.getMode()) + 1) % MODES.length]);

  const narrowMq: MediaQueryList | null = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
  const tocVis = createTocVisibility({
    isNarrow: () => !!narrowMq?.matches,
    apply: (shown) => {
      layout.setTocVisible(shown);
      toc.setVisible(shown);
      toolbar.setTocVisible(shown);
    },
    persist: (on) => writeLocal(LS_TOC, on ? 'open' : 'closed'),
  });
  const onNarrowChange = (): void => tocVis.breakpointChanged();
  narrowMq?.addEventListener('change', onNarrowChange);
  // Overlay dismissal. Both listeners are cheap no-ops while the overlay is closed.
  const onDocKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') tocVis.closeOverlay();
  };
  const onDocPointerDown = (e: Event): void => {
    if (!tocVis.overlayOpen()) return;
    const t = e.target as Node | null;
    // The toolbar is excluded so a pointerdown on 显示/隐藏目录 does not close the panel a moment
    // before its own click would toggle it back open.
    if (t && (els.toc.contains(t) || els.toolbar.contains(t))) return;
    tocVis.closeOverlay();
  };
  document.addEventListener('keydown', onDocKeydown);
  document.addEventListener('pointerdown', onDocPointerDown, true);
  /** 跟随系统 → 浅色/深色 → 跟随系统 (see `nextThemePref`). */
  const themeLabel = (p: ThemePref): string => (p === 'system' ? '跟随系统' : p === 'dark' ? '深色' : '浅色');
  const systemTheme = (): ResolvedTheme =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const toggleTheme = (): void => {
    const next = nextThemePref(theme.get(), theme.resolved(), systemTheme());
    theme.set(next);
    toast({ text: `${T.toggleTheme}：${themeLabel(next)}`, timeoutMs: 1600 });
  };

  // ---- open / draft / save flows
  // R1 (CONTRACT §11): ONE modal question at a time, and no request is dropped. Every operation that
  // replaces the document (新建, 打开…, a recent entry, a drop, a document the OS sends) runs through
  // `docGuard.run`, one after another; each asks 取消 / 丢弃 only if the document it finds is dirty. The
  // gate is shared with the desktop close question (native.ts): neither stacks on the other. A second
  // open used to be refused while the question was up — and the double-clicked file vanished (F4).
  const questions = createQuestionGate();
  const docGuard = createDocumentGuard({
    gate: questions,
    isDirty: () => {
      previewEdit.commit();
      return isDirty();
    },
    ask: () => confirmDialog(els.overlay, { text: T.discardChanges, ok: T.discard, danger: true }),
  });
  const confirmDiscard = (): Promise<boolean> => docGuard.confirmDiscard();

  // R2: 不保存 / 丢弃 mean discard — the thrown-away document's draft must not come back as
  // 「发现未保存的草稿，是否恢复？」. `openFile` deletes the draft of a dirty document it replaces; the
  // desktop close flow (不保存) calls `discardDraftForClose`, after which nothing writes a draft for the
  // dying page (visibilitychange → flush would otherwise re-create it) until the user edits again.
  let draftsSuspended = false;
  /** R4: deletes the stored draft of `docId` only if this tab wrote it: the last write the worker
   *  confirmed (`ownDraft`), or a record holding exactly `text` — the text being thrown away, written by a
   *  write whose confirmation is still on its way. A draft another tab (same untitled key, same file)
   *  wrote since is left alone (G30). */
  const sameDraft = (d: DraftRecord, s: { docId: string; version: number; at: number } | null): boolean =>
    s !== null && d.docId === s.docId && d.version === s.version && d.at === s.at;
  const delDraftIf = async (docId: string, owned: (d: DraftRecord) => boolean): Promise<void> => {
    const d = await drafts.get(docId);
    if (d && owned(d)) await drafts.del(docId);
  };
  const delOwnDraft = (docId: string, text: string): Promise<void> =>
    delDraftIf(docId, (d) => sameDraft(d, ownDraft) || d.text === text);
  /** R5: while a recovery offer is unanswered, text that is back to the loaded (or saved) text writes no
   *  draft — the stored record is the offered one and must stay — and taking typing back deletes only a
   *  draft this tab wrote (the worker's clear() checks its own stamp). Runs before the edit is posted, so
   *  the worker's debounce never fires for that text; any other text re-enables the writes as before. */
  const r5Check = (): void => {
    const back = r5 !== null && r5.docId === file.docId && editor.view.state.doc.length === r5.base.length && editor.getText() === r5.base;
    if (back) {
      if (!r5Paused) w.draft('clear');
      r5Paused = true;
      w.draft('disable');
    } else if (r5Paused) {
      r5Paused = false;
      w.draft('enable');
    }
  };
  /** R5: the offer was answered (or its document left): drafts are written as R4 says again. */
  const endR5 = (): void => {
    r5 = null;
    if (!r5Paused) return;
    r5Paused = false;
    if (!draftsSuspended) w.draft('enable');
  };
  const discardDraftForClose = async (): Promise<void> => {
    draftsSuspended = true;
    w.draft('disable');
    w.draft('clear');
    await delOwnDraft(file.docId, editor.getText());
  };

  /** The draft's text as ONE undoable step (R4): Cmd-Z brings back what the editor held. Only the
   *  differing middle is replaced, isolated in the history so neither earlier nor later typing joins it. */
  const replaceTextUndoable = (text: string): void => {
    const view = editor.view;
    const old = view.state.doc.toString();
    const next = text.replace(/\r\n?/g, '\n');
    const max = Math.min(old.length, next.length);
    let pre = 0;
    while (pre < max && old.charCodeAt(pre) === next.charCodeAt(pre)) pre++;
    let suf = 0;
    while (suf < max - pre && old.charCodeAt(old.length - 1 - suf) === next.charCodeAt(next.length - 1 - suf)) suf++;
    if (pre === old.length && pre === next.length) return;
    view.dispatch({
      changes: { from: pre, to: old.length - suf, insert: next.slice(pre, next.length - suf) },
      userEvent: 'input.replace.draft',
      annotations: isolateHistory.of('full'),
    });
  };

  /** `offeredAt`: the editor version when the offer appeared. Text changed since is the user's newer
   *  work: 恢复 asks first (through the shared question gate) and replaces it as one undoable step (R4). */
  const restoreDraft = (d: DraftRecord, offeredAt: number): Promise<void> =>
    docGuard.run(async () => {
      // A draft belongs to one document. The toast is dropped when another document opens, so this is
      // only reachable in a race — say so instead of leaving a 恢复 button that silently does nothing.
      if (d.docId !== file.docId) {
        toast({ text: DRAFT_OTHER_DOC, kind: 'error' });
        return;
      }
      previewEdit.commit();
      const changed = editor.version !== offeredAt;
      if (changed) {
        const yes = await questions.ask(() => confirmDialog(els.overlay, { text: DRAFT_RESTORE_OVER, ok: T.restore, danger: true }));
        // 取消 keeps the offer: the stored record may already hold the newer text, so this one is the
        // only copy of the crash draft.
        if (!yes) {
          if (d.docId === file.docId) offerDraft(d, offeredAt);
          return;
        }
        if (d.docId !== file.docId) {
          toast({ text: DRAFT_OTHER_DOC, kind: 'error' });
          return;
        }
        previewEdit.commit();
      }
      endR5();
      docEpoch++;
      replaceTextUndoable(d.text);
      draftBase = editor.version;
      // Unchanged since the offer: the stored record is this text. Otherwise the worker's next write
      // (the restore is an edit) confirms it through onDraftSaved.
      if (!changed) draftVersion = editor.version;
      refreshStatus();
    });
  const offerDraft = (d: DraftRecord, offeredAt = editor.version): void => {
    draftOffer?.();
    // R5: a re-offer (取消 on the restore question) keeps the base of the first one.
    if (!r5 || r5.docId !== file.docId) r5 = { docId: file.docId, base: file.text.replace(/\r\n?/g, '\n') };
    const dismiss = toasts.show({
      text: T.draftFound,
      actions: [
        { label: T.restore, run: () => void restoreDraft(d, offeredAt) },
        // Only that record: a draft this tab wrote over it since (typing after the offer) stays.
        {
          label: T.discard,
          run: () => {
            if (r5?.docId === d.docId) endR5();
            void delDraftIf(d.docId, (s) => sameDraft(s, d));
          },
        },
      ],
    });
    docToasts.push({ docId: file.docId, dismiss });
    draftOffer = dismiss;
  };

  const openFile = async (f: OpenedFile): Promise<void> => {
    performance.mark('mdr:open');
    // A different document: nothing is focused until the user interacts with it again.
    focusLine.reset();
    // A session left open across setDoc would write its block into the NEW document.
    previewEdit.commit();
    sessionInput = false;
    // Replacing a document that has unsaved changes is a discard (the guard asked, or the user chose
    // 重新载入): its draft goes too (R2). The worker deletes it under the OLD docId — `clear` is posted
    // before setDoc — and so does this thread, awaited below before the new document's draft is read
    // (新建 after 丢弃 reads the same untitled key). A clean document keeps its draft: an unanswered
    // restore offer from a crash is still the user's.
    const discardedId = isDirty() ? file.docId : null;
    const discardedText = discardedId !== null ? editor.getText() : '';
    if (discardedId !== null) w.draft('clear');
    if (draftsSuspended) draftsSuspended = false;
    // R5: another document: its own offer (if any) starts afresh; `enable` below resumes the writes.
    r5 = null;
    r5Paused = false;
    const v = editor.setDoc(f.text);
    file = f;
    docEpoch++;
    dropDocToasts(f.docId);
    // G34: this file opened — an earlier failure to open it is no longer true.
    if (f.path) toasts.clearFailure(f.path);
    toasts.clearFailure(nameKey(f.name));
    toasts.clearFailure('picker');
    remoteBlockedShown = false;
    noteFileEncoding(f);
    savedVersion = v;
    draftVersion = -1;
    draftBase = v;
    workerIdle = false;
    w.setDoc(f.docId, v, f.text);
    w.draft('enable');
    bus.emit('doc:loaded', { docId: f.docId, name: f.name });
    refreshStatus();
    if (layout.getMode() !== 'preview') editor.focus();
    noteOpened(f);
    if (f.handle || f.path) void recent.push({ docId: f.docId, name: f.name, handle: f.handle, path: f.path, openedAt: Date.now() });
    addNativeRecent(f.path);
    if (discardedId !== null) await delOwnDraft(discardedId, discardedText);
    const draft = await drafts.get(f.docId);
    if (!draft || file.docId !== f.docId || draft.at <= f.lastModified || draft.text === f.text) return;
    // The empty scratch buffer is opened before the shell can deliver the document the user
    // double-clicked: its leftover draft must not pop a restore offer over that document. Waiting is
    // deliberately NOT awaited here — createApp subscribes to the bridge as soon as this promise
    // resolves, and a menu command that arrives before that subscription is lost.
    if (f.docId === UNTITLED_ID && launchPending) {
      void launchSettled.then(() => {
        if (file.docId === f.docId) offerDraft(draft);
      });
      return;
    }
    offerDraft(draft);
  };

  /** 打开…: the question first (in the guard), then the panel OUTSIDE the guard — an open panel can stay
   *  up indefinitely and must not hold back a document the OS sends meanwhile — then the load, guarded
   *  again. That last step asks once more only if the document changed while the panel was up: the
   *  user's 丢弃 was about the document they saw. */
  const openViaPicker = async (): Promise<void> => {
    const asked = await docGuard.run(async () => ((await confirmDiscard()) ? { doc: file, version: editor.version } : null));
    if (!asked) return;
    let f: OpenedFile | null;
    try {
      f = await files.open();
    } catch (err) {
      // G33: on the web this is the panel itself refusing (already open, no user activation).
      openFailed('picker', openFailureToast(err, { name: '', desktop: !!native, picker: true }));
      return;
    }
    if (!f) return;
    const picked = f;
    await docGuard.run(async () => {
      const unchanged = file === asked.doc && editor.version === asked.version;
      if (!unchanged && !(await confirmDiscard())) return;
      try {
        await openFile(picked);
      } catch (err) {
        openFailed(picked.path ?? nameKey(picked.name), openFailureToast(err, { name: picked.name, desktop: !!native }));
      }
    });
  };

  /** Open an absolute path: the OS `open-file` event and desktop recent entries (CONTRACT §10). */
  const nativeOpener = createNativeOpener({
    confirmDiscard,
    readPath: (p) => readNativePath(p, native),
    load: openFile,
    forgetRecent: async (path, docId) => {
      const id = docId ?? (await recent.findByPath(path))?.docId;
      if (!id) return false;
      await recent.remove(id);
      return true;
    },
    toast,
    fail: openFailed,
  });
  const openNativePath = (path: string, docId?: string): Promise<void> => docGuard.run(() => nativeOpener(path, docId));

  const openRecent = async (e: RecentEntry): Promise<void> => {
    if (native && e.path) return openNativePath(e.path, e.docId);
    const h = e.handle;
    if (!h) return;
    return docGuard.run(async () => {
      if (!(await confirmDiscard())) return;
      try {
        await openFile(await files.openHandle(h, e.docId));
      } catch (err) {
        const missing = err instanceof DOMException && err.name === 'NotFoundError';
        if (missing) await recent.remove(e.docId);
        openFailed(e.path ?? nameKey(e.name), openFailureToast(err, { name: e.name, desktop: !!native, forgotRecent: missing }));
      }
    });
  };

  const newFile = (): Promise<void> =>
    docGuard.run(async () => {
      if (!(await confirmDiscard())) return;
      await openFile(files.newFile());
    });

  /** The shell decodes a file with its real encoding (GBK, Big5, UTF-16 …) and writes it back the
   *  same way; say so once, so 「为什么文件还是 GBK」 never becomes a surprise. */
  const noteFileEncoding = (f: OpenedFile): void => {
    if (!native || !f.path) return;
    const enc = encodingOf(f.path);
    if (isLegacyEncoding(enc)) showDocToast({ text: LEGACY_ENCODING_TOAST(enc!) });
  };

  /** Re-read the document from disk, discarding what is in the editor. Only reachable from an
   *  explicit 重新载入 button, so it does NOT ask the dirty guard again. */
  const reloadFromDisk = (path: string): Promise<void> =>
    docGuard.run(async () => {
      try {
        await openFile(await readNativePath(path, native));
      } catch (err) {
        openFailed(path, openFailureToast(err, { name: file.name, desktop: !!native }));
      }
    });

  /** Another program wrote to the file after MDReader opened it. The shell refused the write and
   *  remembered the new mtime, so 覆盖保存 is literally "ask once more" and then goes through. */
  const offerConflict = (): void => {
    const path = file.path;
    showDocToast({
      text: `${CONFLICT_TOAST}：${file.name}`,
      kind: 'error',
      actions: [
        { label: OVERWRITE_LABEL, run: () => { void save(false); } },
        ...(path ? [{ label: RELOAD_LABEL, run: () => { void reloadFromDisk(path); } }] : []),
        { label: SAVE_AS_LABEL, run: () => { void save(true); } },
      ],
    });
  };

  /** Resolves true when the document is on disk afterwards (the desktop close guard needs to know). */
  const save = async (as: boolean): Promise<boolean> => {
    // ⌘S while typing in the preview: the last keystrokes may still be waiting for their frame. Flush them
    // into CodeMirror but keep the session (and the caret) so typing continues right after saving.
    previewEdit.flush();
    const text = editor.getText();
    const version = editor.version;
    // R6 (J4): which document this save is for, taken before the first await.
    const epoch = docEpoch;
    const savingName = file.name;
    const r = as ? await files.saveAs(text, file.name) : await files.save(file, text);
    if (epoch !== docEpoch) {
      // Another document (or a restored draft) replaced the one saved: the bytes written stay, and
      // nothing of the open document changes — not its file, saved version, title, draft or recent
      // entry. Only a toast that names the saved file. False: the OPEN document was not saved.
      noteOpened(file); // the native service noted the saved file's folder for 另存为
      if (r.ok) toast({ text: files.canSaveInPlace ? `${T.saved_ok}：${r.file.name}` : `已下载 ${r.file.name}` });
      else {
        const why =
          saveProblem(r) === 'conflict' ? CONFLICT_TOAST
          : r.reason === 'permission' ? T.needReauth
          : r.reason === 'error' ? r.message ?? ''
          : null; // cancelled: nothing to say
        if (why !== null) toast({ text: `${T.saveFailed}：${savingName}：${why}`, kind: 'error' });
      }
      return false;
    }
    if (!r.ok) {
      const problem = saveProblem(r);
      if (problem === 'conflict') offerConflict();
      else if (problem === 'encoding') {
        // The document now holds a character the file's own encoding cannot represent: the only
        // lossless way out is a new UTF-8 file.
        showDocToast({
          text: `${T.saveFailed}：${r.message ?? ''}`,
          kind: 'error',
          actions: [{ label: SAVE_AS_LABEL, run: () => { void save(true); } }],
        });
      } else if (r.reason === 'permission') toast({ text: `${T.saveFailed}：${T.needReauth}`, kind: 'error' });
      else if (r.reason === 'error') toast({ text: `${T.saveFailed}：${r.message ?? ''}`, kind: 'error' });
      return false;
    }
    const prevDocId = file.docId;
    file = r.file;
    savedVersion = version;
    draftVersion = -1;
    draftBase = version;
    // Text typed while the save was in flight is not on disk: its (pending) draft stays. The old
    // document's draft goes only when the saved text is still the document's text, or when the
    // document moves to a new docId (its draft is re-written there below).
    const savedCurrent = editor.version === version;
    // R5: an unanswered offer now guards against the saved text; a new docId leaves the offer behind.
    if (r5) {
      if (file.docId !== prevDocId) endR5();
      else r5.base = text;
    }
    if (savedCurrent || file.docId !== prevDocId) {
      w.draft('clear');
      void delOwnDraft(prevDocId, text);
    }
    if (file.docId !== prevDocId) {
      // The worker keys drafts by docId: re-seed it under the new identity.
      void drafts.del(file.docId);
      w.setDoc(file.docId, editor.version, editor.getText());
      w.draft('enable');
      if (!savedCurrent) w.draft('flush');
    }
    if (file.handle || file.path) void recent.push({ docId: file.docId, name: file.name, handle: file.handle, path: file.path, openedAt: Date.now() });
    if (file.docId !== prevDocId) addNativeRecent(file.path);
    refreshStatus();
    toast({ text: files.canSaveInPlace ? T.saved_ok : `已下载 ${file.name}` });
    return true;
  };

  const exportHtml = async (): Promise<void> => {
    previewEdit.commit();
    try {
      const html = await w.exportHtml();
      const css = await loadExportCss(hasMath(html));
      const base = file.name.replace(/\.(md|markdown|txt)$/i, '') || 'document';
      downloadText(`${base}.html`, buildExportDocument({ title: base, html, css, theme: theme.resolved() }), 'text/html');
    } catch (err) {
      toast({ text: `${T.fileExportHtml}失败：${errorMessage(err)}`, kind: 'error' });
    }
  };

  // ---- global commands (editor-scope commands are registered by createEditor)
  const reg = (id: Parameters<CommandRegistry['get']>[0], title: string, shortcut: string | undefined, run: () => void | Promise<void>): void =>
    registry.register({ id, title, shortcut, scope: 'global', run });
  reg('file.new', T.fileNew, undefined, newFile);
  reg('file.open', T.fileOpen, 'Mod-o', openViaPicker);
  reg('file.save', files.canSaveInPlace ? T.fileSave : T.fileDownload, 'Mod-s', () => { void save(false); });
  reg('file.saveAs', T.fileSaveAs, 'Mod-Shift-s', () => { void save(true); });
  reg('file.exportHtml', T.fileExportHtml, undefined, exportHtml);
  reg('view.cycleMode', T.cycleMode, 'Mod-/', cycleMode);
  reg('view.mode.edit', T.modeEdit, undefined, () => setMode('edit'));
  reg('view.mode.split', T.modeSplit, undefined, () => setMode('split'));
  reg('view.mode.preview', T.modePreview, undefined, () => setMode('preview'));
  reg('view.toggleToc', T.toggleToc, 'Mod-Shift-o', () => tocVis.set(!tocVis.shown()));
  reg('view.toggleTheme', T.toggleTheme, 'Mod-Shift-l', toggleTheme);
  reg('view.palette', T.palette, 'Mod-Shift-p', () => palette.open());
  reg('view.mountAll', T.mountAll, undefined, () => preview.mountAll());
  reg('view.togglePreviewEdit', PREVIEW_EDIT_T.toggle, 'Mod-Shift-e', () => {
    // Rule L3: the toast says what is true once it is (on: when the editing code is installed); a failure has its own.
    previewEdit.toggle((r) => {
      if (r !== 'failed') toast({ text: r === 'on' ? PREVIEW_EDIT_T.on : PREVIEW_EDIT_T.off, timeoutMs: 1600 });
    });
  });
  /** An editor-scope command that arrived from outside the editor — a native menu item, or its
   *  shortcut pressed while the preview has focus. Those commands live in CodeMirror's keymap and
   *  act on the view, so the editor has to be on screen and focused first; without this ⌘B in 预览
   *  did nothing at all while the 格式 menu kept showing it as available. (Mod-f has always worked
   *  this way: the preview evicts far-away blocks, so the browser's find would miss most of the
   *  document — SPEC §13.) */
  const runEditorCommand = (id: CommandId): void => {
    if (previewEdit.sessionActive() && routeToSession(id)) return;
    if (layout.getMode() === 'preview') setMode('split');
    editor.focus();
    registry.run(id);
  };
  const editingBlock = (): HTMLElement | null => els.preview.querySelector<HTMLElement>('section.md-block.is-editing');
  /** While a block is being edited in the preview (CONTRACT §11) an editor command that reached App — a
   *  native menu item, a toolbar button, its key pressed outside the contenteditable — must not yank the
   *  user into the editor mid-sentence. ⌘B / ⌘I / ⌘E / ⌘K are the session's own keys: hand it the same
   *  keydown (true = handled). Anything else (标题, 查找, 跳转到行 …) lives in the editor: commit the
   *  session, put CodeMirror's caret into the block that was being edited (unless it already is), and let
   *  the normal path run (false). */
  let forwarding = false;
  const routeToSession = (id: CommandId): boolean => {
    const el = editingBlock();
    if (SESSION_FORMAT_COMMANDS.has(id)) {
      const shortcut = registry.get(id)?.shortcut;
      const active = document.activeElement;
      const target = active instanceof HTMLElement && els.preview.contains(active) ? active : el;
      // Guarded: the synthetic keydown bubbles through the window-level shortcut listener again, which
      // must not bounce it back here when the target is not recognised as an editable host.
      if (shortcut && target && !forwarding) {
        forwarding = true;
        try {
          target.dispatchEvent(shortcutKeyEvent(shortcut));
        } finally {
          forwarding = false;
        }
      }
      return true;
    }
    const info = el ? preview.blockOfElement(el) : null;
    previewEdit.commit();
    if (info) {
      const { state } = editor.view;
      const line = state.doc.lineAt(state.selection.main.head).number;
      if (line < info.startLine || line >= info.startLine + info.lineCount) {
        editor.view.dispatch({ selection: { anchor: state.doc.line(Math.min(info.startLine, state.doc.lines)).from } });
      }
    }
    return false;
  };
  setToolbarEditorRouter(toolbar, (id) => {
    if (!previewEdit.sessionActive()) return false;
    runEditorCommand(id);
    return true;
  });
  /** A command id from the native menu: editor-scope ones go through `runEditorCommand`. */
  const runShellCommand = (id: CommandId): void => {
    if (registry.get(id)?.scope === 'editor') runEditorCommand(id);
    else registry.run(id);
  };
  /** CodeMirror's own history, for 编辑 → 撤销 / 重做 (electron/menu.mjs: Chromium's Redo command
   *  cannot reach it, so the menu items are ours). */
  const runHistory = (cmd: typeof undo): void => {
    // Inside a preview session the menu items do what ⌘Z / ⇧⌘Z do there (decision U1: the session flushes,
    // steps the source's history and shows the result): hand the session the same keydown, instead of
    // undoing CodeMirror underneath it.
    if (previewEdit.sessionActive()) {
      const el = editingBlock();
      const active = document.activeElement;
      const target = active instanceof HTMLElement && els.preview.contains(active) ? active : el;
      if (target) {
        target.dispatchEvent(shortcutKeyEvent(cmd === undo ? 'Mod-z' : 'Mod-Shift-z'));
        return;
      }
      previewEdit.commit();
    }
    if (layout.getMode() === 'preview') setMode('split');
    editor.focus();
    cmd(editor.view);
  };
  /** Decision U2 as amended (CONTRACT §11, OFFD-1, RVS-3): ⌘Z / ⇧⌘Z pressed outside the editor and outside a session
   *  (the preview after Esc, the toolbar, the TOC, nothing focused) run CodeMirror's own undo / redo on the editor
   *  view — what 0.1.1 reached through the browser's undo stack: the editor scrolls to its caret, and the cursor
   *  notification is announced as editor typing, so the focus line moves and (through the mark, which only a step
   *  that changed the document sets) the preview follows although the editor has no focus. No mode switch, no
   *  focus change. A session that is still live while the focus is elsewhere is committed first.
   *  Narrowed to the switch OFF (Checkpoint-D decisions): with 预览可编辑 on, the experimental feature keeps its quiet
   *  route (source.history: the place rule, no scroll, no mark) — CodeMirror's undo would put the caret where it stood
   *  before a session and throw both panes there. */
  const historyOutside = (redoIt: boolean): void => {
    previewEdit.commit();
    if (previewEdit.isOn()) { source.history?.(redoIt); return; }
    const before = editor.view.state.doc;
    (redoIt ? redo : undo)(editor.view);
    if (editor.view.state.doc !== before) historySteps.note();
  };
  /** Low finding: the editor-only shortcuts (标题 ⌘1–⌘6, 正文 ⌘0, 任务 ⌘⇧X, 查找 ⌘F, 跳转到行) pressed inside a
   *  preview session were silent no-ops. They stay editor-only — a session does not implement them — but
   *  now say so: a short toast naming the command and how to get it (Esc, then the key works on the source).
   *  ⌘B / ⌘I / ⌘E / ⌘K are the session's own keys and are left to it. */
  const editableCommand = (id: CommandId, el: Element): boolean => {
    if (!previewEdit.sessionActive() || !els.preview.contains(el) || SESSION_FORMAT_COMMANDS.has(id)) return false;
    const title = registry.get(id)?.title ?? '';
    toast({ text: `${title}${PREVIEW_EDIT_T.editorOnly}`, timeoutMs: 2400 });
    return true;
  };
  const offShortcuts = installShortcuts(registry, window, { editorCommand: runEditorCommand, history: historyOutside, editableCommand });

  // ---- window-level guards
  // With the desktop shell present this installs nothing: Electron would silently block the close
  // instead of prompting, and the shell runs its own guard through 'app.closeRequested' (CONTRACT §10).
  const isDirtyCommitted = (): boolean => {
    previewEdit.commit();
    return isDirty();
  };
  const offUnloadGuard = installUnloadGuard(window, isDirtyCommitted, native);
  const onVisibility = (): void => {
    // R4: only text changed since the document was loaded, restored or saved is worth a draft.
    if (document.visibilityState === 'hidden' && editor.version !== draftBase) w.draft('flush');
  };
  document.addEventListener('visibilitychange', onVisibility);
  // The desktop shell serves the renderer with a Content-Security-Policy that keeps a document off
  // the network (electron/protocol.mjs): a tracking pixel in someone else's Markdown must not be
  // able to report that it was read. Say once per document why an image stayed blank.
  const onCspViolation = (e: SecurityPolicyViolationEvent): void => {
    if (remoteBlockedShown || !/^https?:/i.test(e.blockedURI)) return;
    remoteBlockedShown = true;
    showDocToast({ text: REMOTE_BLOCKED_TOAST });
  };
  document.addEventListener('securitypolicyviolation', onCspViolation);

  // ---- drag & drop onto the app
  let dragDepth = 0;
  const hasFiles = (dt: DataTransfer | null): dt is DataTransfer => !!dt && Array.from(dt.types).includes('Files');
  /** The dropped file's absolute path (desktop), the key of its failure toast (G34). */
  const dropPath = (f: File | undefined): string | null => {
    if (!native || !f) return null;
    try {
      return native.pathForFile(f) || null;
    } catch {
      return null;
    }
  };
  const onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    root.classList.add('is-dragover');
  };
  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (): void => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      root.classList.remove('is-dragover');
    }
  };
  const onDrop = (e: DragEvent): void => {
    dragDepth = 0;
    root.classList.remove('is-dragover');
    if (!hasFiles(e.dataTransfer)) return;
    // U17: cancelled here, synchronously, before any element sees it (CodeMirror inserted the file's text).
    e.preventDefault();
    e.stopPropagation();
    // Refuse binaries before anything is read: opening a .png replaced the document with garbage.
    if (!isMarkdownDrop(e.dataTransfer)) {
      toast({ text: UNSUPPORTED_FILE, kind: 'error' });
      return;
    }
    // DataTransfer items are only readable synchronously inside the event: start reading now, confirm later.
    const pending = files.fromDrop(e.dataTransfer);
    const dropName = e.dataTransfer.files?.[0]?.name ?? '';
    const dropKey = dropPath(e.dataTransfer.files?.[0]) ?? nameKey(dropName);
    // Swallow a rejection now: it is reported when this drop's turn comes (it may wait for a question).
    pending.catch(() => undefined);
    // J25: the browser's NotReadableError text is English; say it in the app's own words.
    const dropFailure = (err: unknown): ToastSpec => {
      const spec = openFailureToast(err, { name: dropName, desktop: !!native });
      const unreadable = !native && err instanceof DOMException && err.name === 'NotReadableError';
      return unreadable ? { ...spec, text: `${OPEN_FAIL_T.title(dropName)}：${OPEN_FAIL_T.denied}` } : spec;
    };
    void docGuard.run(async () => {
      // G31: a file the shell refused (or nothing usable) is reported before any discard question — the
      // current document stays, whatever the answer would have been.
      let f: OpenedFile | null;
      try {
        f = await pending;
      } catch (err) {
        openFailed(dropKey, dropFailure(err));
        return;
      }
      if (!f) {
        toast({ text: UNSUPPORTED_FILE, kind: 'error' });
        return;
      }
      if (!(await confirmDiscard())) return;
      try {
        await openFile(f);
      } catch (err) {
        openFailed(dropKey, dropFailure(err));
      }
    });
  };
  root.addEventListener('dragenter', onDragEnter);
  // U17 (H2): a drop that carries files belongs to the app wherever in the window it lands. The window's
  // capture phase runs before every element's own handler, so CodeMirror's file drop (it reads the file and
  // inserts its text) and a contenteditable's default never see it; the matching dragover is cancelled the
  // same way, or the drop would not be allowed. A drag of text is left alone (hasFiles is false for it).
  window.addEventListener('dragover', onDragOver, true);
  root.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop, true);

  // ---- restore persisted UI state
  const modeParam = params.get('mode');
  const savedMode = readLocal(LS_MODE);
  applyMode(isMode(modeParam) ? modeParam : isMode(savedMode) ? savedMode : 'split', true);
  tocVis.restore(readLocal(LS_TOC) !== 'closed');
  const offSplit = installSplitResize(root, els, () => sync.syncNow('editor'));

  // ---- hooks / overlay
  // A document loaded by name (?doc=…, __mdr.loadText) is a named, unmodified document: 'legacy' makes
  // fileState() report 「已保存」 instead of 「未命名」 (which is reserved for the empty scratch buffer).
  const loadText = async (text: string, name: string = T.untitled): Promise<void> =>
    openFile({
      docId: `text:${name}`,
      name,
      text,
      lastModified: Date.now(),
      source: name === T.untitled ? 'new' : 'legacy',
    });
  const loadUrl = async (url: string): Promise<void> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    const name = decodeURIComponent(url.split('?')[0].split('/').pop() || '') || T.untitled;
    await loadText(await res.text(), name);
  };

  const handle: AppHandle = {
    editor, preview, bus, registry, worker: w, layout, theme,
    loadText,
    getText: () => editor.getText(),
    dispose() {
      offChanges();
      offCursor();
      focusLine.off();
      previewEdit.off();
      if (firstIdleTimer) clearTimeout(firstIdleTimer);
      afterFirstIdle = null;
      setToolbarEditorRouter(toolbar, null);
      for (const off of unsub) off();
      offShortcuts();
      offSplit();
      offUnloadGuard();
      nativeWiring?.dispose();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('securitypolicyviolation', onCspViolation);
      narrowMq?.removeEventListener('change', onNarrowChange);
      document.removeEventListener('keydown', onDocKeydown);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      root.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver, true);
      root.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop, true);
      if (statusFrame) cancelAnimationFrame(statusFrame);
      if (modeSettleRaf) cancelAnimationFrame(modeSettleRaf);
      perf?.dispose();
      fileMenu.dispose();
      toasts.dispose();
      sync.dispose();
      preview.dispose();
      disposeEditor(editor);
      disposeToc(toc);
      disposeToolbar(toolbar);
      disposePalette(palette);
      disposeStatusBar(statusbar);
      disposeTheme(theme);
      w.dispose();
      // Last: every module has released what it mounted INTO the layout, so the shell itself can go.
      // Without this the next createApp(root) builds a second toolbar / main / statusbar / overlay.
      disposeLayout(layout);
      if (window.__mdr?.app === handle) delete window.__mdr;
    },
  };

  if (hooksEnabled) {
    window.__mdr = {
      app: handle,
      loadText,
      loadUrl,
      marks: () => performance.getEntriesByType('mark').filter((e) => e.name.startsWith('mdr:')),
      samples: () => samples.slice(),
      // Resolves at the worker's idle, then lets two animation frames pass: CodeMirror measures and scrolls
      // the cursor into view a frame after the last keystroke, which can land after a fast worker round
      // trip — a script acting on "idle" must not race that scroll (the editor is the sync master then).
      waitIdle: () => (workerIdle ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))).then(framesSettled),
      mode: setMode,
      version: () => editor.version,
    };
  }
  if (perfMode) perf = createPerfOverlay({ parent: els.overlay, bus, preview, workerIdle: () => workerIdle });

  // ---- initial document
  const docParam = params.get('doc');
  if (docParam && import.meta.env.DEV) {
    try {
      await loadUrl(docParam);
    } catch (err) {
      toast({ text: `${T.fileOpen}失败：${errorMessage(err)}`, kind: 'error' });
      await openFile(files.newFile());
    }
  } else {
    await openFile(files.newFile());
  }

  // ---- desktop shell (CONTRACT §10)
  // Subscribed LAST on purpose: the bridge delivers the launch document (the file that was
  // double-clicked) as soon as `onOpenFile` has a listener, and the empty scratch buffer above
  // would otherwise overwrite it a moment later.
  if (native) {
    nativeWiring = installNative(native, {
      overlay: els.overlay,
      registry,
      docName: () => file.name,
      // The shell's close/quit guard: a session's pending keystrokes count as changes.
      isDirty: isDirtyCommitted,
      openPath: (p) => openNativePath(p),
      save: () => save(false),
      questions,
      discardDecided: () => docGuard.discardDecided(),
      discardDraft: discardDraftForClose,
      runCommand: runShellCommand,
      undo: () => runHistory(undo),
      redo: () => runHistory(redo),
    });
    refreshStatus(); // seed the shell with the current document state
  }
  return handle;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
