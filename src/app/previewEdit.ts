// src/app/previewEdit.ts — the shell half of in-preview editing (CONTRACT §11).
//
// The preview module owns the session itself (src/preview/inlineEdit.ts: contenteditable block,
// serializer, keys). App only has to:
//   - give the preview a window onto the source (`createSourceAccess`, wired to CodeMirror),
//   - own the 「预览可编辑」 toggle (command, persistence in LS_PREVIEW_EDIT, bus 'previewEdit:changed'),
//   - know whether a session is live ('previewEdit:session') so the editor-command plumbing, ⌘S and
//     the document guards can commit it first / stay out of its way.
import { EditorSelection, type Annotation, type ChangeSet, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { redo, undo } from '@codemirror/commands';
import type { CommandId, EditorApi, EventBus, Line, PreviewApi, PreviewSourceAccess } from '../shared/types';
import { peerLineField, setPeerLineEffect } from '../editor/peerLine';
import { LS_PREVIEW_EDIT } from '../shared/types';
import { IS_MAC, parseShortcut } from '../shared/keys';

/** Transaction tag of a preview-originated write.
 *  CONTRACT §11 names it 'input.previewEdit' and asks that "consecutive edits group for undo". CodeMirror's
 *  history only ever joins events whose userEvent matches /^(input\.type|delete)($|\.)/ — with the literal
 *  'input.previewEdit' every rAF-coalesced write would be its own undo step (typing a sentence in the preview,
 *  then pressing ⌘Z in the editor 40 times). 'input.type.previewEdit' keeps the purpose of the contract:
 *  `tr.isUserEvent('input')` holds, the history joins bursts exactly like CodeMirror's own typing (500 ms,
 *  adjacent ranges), and the `.previewEdit` suffix still identifies the source. */
export const PREVIEW_EDIT_USER_EVENT = 'input.type.previewEdit';

/** 「预览可编辑」 — src/shared/i18n.ts is frozen, so the strings for this feature live here. */
export const PREVIEW_EDIT_T = {
  /** Release decision for 0.2.0 (CONTRACT §11): the switch is experimental wherever it is named. */
  toggle: '预览可编辑（实验性）',
  on: '预览可编辑（实验性）：开',
  off: '预览可编辑：关',
  editing: '预览编辑',
  /** Appended to a command title: an editor-only shortcut pressed inside a session (toast). */
  editorOnly: '：预览编辑中不可用，按 Esc 结束编辑后再按',
  /** Rule L4: the editing code (a chunk of its own) could not be loaded; the switch stays off. The browser does not
   *  fetch a failed dynamic import again, so only a reload (web) or a restart (desktop) helps. */
  loadFailed: '预览编辑功能加载失败，请刷新页面或重启应用后重试',
  /** Rule L3 (RL-2): the user turned editing on and its code has not arrived 300 ms later. */
  loading: '正在加载预览编辑功能…',
} as const;

/** The editor commands an active session implements itself (CONTRACT §11 keys: ⌘B / ⌘I / ⌘E / ⌘K). */
export const SESSION_FORMAT_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['edit.bold', 'edit.italic', 'edit.code', 'edit.link']);

const validRange = (doc: Text, startLine: Line, lineCount: number): boolean =>
  Number.isInteger(startLine) && Number.isInteger(lineCount) && startLine >= 1 && lineCount >= 1 && startLine + lineCount - 1 <= doc.lines;

/**
 * PreviewOptions.source wired to CodeMirror.
 * - read: exactly `lineCount` lines from `startLine`, '\n'-joined, no trailing newline (clamped to the
 *   document; an impossible range reads as '').
 * - replace: ONE transaction tagged PREVIEW_EDIT_USER_EVENT, no scrollIntoView, focus untouched. Only the
 *   part of the block that actually differs is changed (common prefix / suffix kept), so the history records
 *   what the user typed — undo restores exactly that and maps the rest of the document — and bursts join
 *   like CodeMirror's own typing (adjacent ranges, 500 ms). The editor's caret moves to the end of the
 *   written block's content (its trailing blank lines excluded), wherever it was: the user is editing THAT
 *   block, so the status bar, the TOC's active entry and the editor's own position all have to report it
 *   (finding high 1: CodeMirror's caret stayed on line 1 after opening a file). Exception (G14): while the
 *   editor has the focus the write is the end of a session the user left by clicking into the editor, and
 *   the user's own selection is mapped through the change instead (what they type next lands where they
 *   clicked). The cursor notification this
 *   causes is the preview's, not editor typing: App announces it with `typing: false` (see
 *   `previewWriteGate`), so neither the cursor-follow nor the focus line moves. The editor's mirror of the
 *   preview's focus line (peer line) survives the move. An identical text is not written (no empty version
 *   bump). A range that no longer fits the document — it cannot happen while the preview tracks the session
 *   through structure deltas, and App ends the session before every setDoc — is refused with a console.warn
 *   instead of writing into the wrong lines.
 * - history(redo): ONE step of CodeMirror's own undo / redo (the preview session routes ⌘Z / ⇧⌘Z here, where
 *   its writes are grouped like typing), dispatched WITHOUT scrollIntoView and without touching focus — the
 *   same as a write. The caret lands at the end of the last range the step changed (for undone typing: where
 *   the typing began; for redone typing: after it), which is what it returns as { line, col } (col = 0-based
 *   UTF-16 offset in the line). null when the history is empty or the step left the document unchanged.
 * - onWrite: called after every write and every history step that changed the document (App: the cursor
 *   notification it schedules is the preview's, not the user's — see `previewWriteGate`).
 */
export function createSourceAccess(editor: Pick<EditorApi, 'view'> & Partial<Pick<EditorApi, 'version' | 'lineNow'>>, onWrite?: () => void): PreviewSourceAccess {
  return {
    // P-B (CONTRACT §11): the editor's document version, the one the worker's structures carry (a refused write
    // changes none). Only when the editor has one (the tests' { view } fakes do not).
    ...(typeof editor.version === 'number' ? { version: () => editor.version as number } : {}),
    // U16 (Checkpoint-D decisions): the editor's lineNow, passed through when it has one.
    ...(typeof editor.lineNow === 'function' ? { lineNow: (line: Line, v: number) => editor.lineNow!(line, v) } : {}),
    read(startLine, lineCount) {
      const doc = editor.view.state.doc;
      if (!Number.isFinite(startLine) || !Number.isFinite(lineCount) || lineCount < 1) return '';
      const first = Math.max(1, Math.floor(startLine));
      const last = Math.min(doc.lines, Math.floor(startLine) + Math.floor(lineCount) - 1);
      if (last < first) return '';
      return doc.sliceString(doc.line(first).from, doc.line(last).to);
    },
    replace(startLine, lineCount, text) {
      const view = editor.view;
      const { state } = view;
      const doc = state.doc;
      if (!validRange(doc, startLine, lineCount)) {
        console.warn(`[mdr] previewEdit: stale range ${startLine}+${lineCount} (document has ${doc.lines} lines); write dropped`);
        return;
      }
      const from = doc.line(startLine).from;
      const to = doc.line(startLine + lineCount - 1).to;
      // Offsets are document offsets: CodeMirror normalises \r\n / \r to one break, so compare and measure
      // the normalised text.
      const norm = text.replace(/\r\n?/g, '\n');
      const old = doc.sliceString(from, to);
      if (old === norm) return;
      const content = norm.replace(/(?:\n[ \t]*)+$/, '');
      const [pre, suf] = commonEnds(old, norm);
      const changes = state.changes({ from: from + pre, to: to - suf, insert: norm.slice(pre, norm.length - suf) });
      // G14: a write while the editor has the focus is the end of a session the user left by clicking into
      // the editor (a focus-out end, an IME composition finishing after the click): the caret the user just
      // put there stays where it is (mapped through the change) instead of jumping back to the block.
      const keepUserCaret = view.hasFocus;
      view.dispatch({
        changes,
        selection: keepUserCaret ? state.selection.map(changes) : EditorSelection.cursor(from + content.length),
        effects: keptPeerLine(state, changes),
        userEvent: PREVIEW_EDIT_USER_EVENT,
        scrollIntoView: false,
      });
      onWrite?.();
    },
    history(redoIt) {
      const view = editor.view;
      const before = view.state;
      let step: Transaction | null = null;
      (redoIt ? redo : undo)({ state: before, dispatch: (tr) => { step = tr; } });
      if (!step) return null;
      const tr: Transaction = step;
      let caret = -1;
      tr.changes.iterChangedRanges((_fa, _ta, _fb, tb) => { caret = tb; });
      // CodeMirror's history step scrolls the editor to its selection. Re-issue it without the scroll and
      // with the caret on the change, keeping its annotations (the history's own bookkeeping, 'undo'/'redo').
      const annotations = (tr as unknown as { annotations?: readonly Annotation<unknown>[] }).annotations;
      if (Array.isArray(annotations) && caret >= 0) {
        view.dispatch(before.update({
          changes: tr.changes,
          selection: EditorSelection.cursor(caret),
          effects: [...tr.effects, ...keptPeerLine(before, tr.changes)],
          annotations,
          filter: false,
          scrollIntoView: false,
        }));
      } else {
        view.dispatch(tr);   // defensive: a CodeMirror without the field — still correct, only the editor scrolls
      }
      if (view.state.doc.eq(before.doc)) return null;
      onWrite?.();
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, col: head - line.from };
    },
  };
}

/** Lengths of the common prefix and suffix of `a` and `b` (not overlapping, never splitting a surrogate pair). */
export function commonEnds(a: string, b: string): [number, number] {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  if (pre > 0 && isHighSurrogate(a.charCodeAt(pre - 1))) pre--;
  let suf = 0;
  while (suf < max - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
  if (suf > 0 && isLowSurrogate(a.charCodeAt(a.length - suf))) suf--;
  return [pre, suf];
}
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The editor's peer line (the tint mirroring the preview's focus line) clears itself on any transaction that
 *  sets the selection; a preview-originated one re-sets it, mapped through `changes`. */
function keptPeerLine(state: EditorState, changes: ChangeSet): ReturnType<typeof setPeerLineEffect.of>[] {
  const field = state.field(peerLineField, false);
  if (!field || field.size === 0) return [];
  const it = field.iter();
  if (!it.value) return [];
  return [setPeerLineEffect.of(changes.apply(state.doc).lineAt(changes.mapPos(it.from, 1)).number)];
}

/** LS_PREVIEW_EDIT: '1' / 'true' / 'on' is on, '0' / 'false' / 'off' is off; anything else (nothing stored,
 *  a damaged value) is `fallback` (createPreviewEdit decides it: see `defaultOn`). */
export function parsePreviewEditPref(v: string | null, fallback: boolean): boolean {
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return fallback;
}

export interface PreviewEditOptions {
  bus: EventBus;
  preview: Pick<PreviewApi, 'setPreviewEditable' | 'endEditSession' | 'flushEditSession'>;
  /** localStorage get/set (App's try/catch wrappers). */
  read(key: string): string | null;
  write(key: string, value: string): void;
  /** Reflect the toggle (toolbar pressed state). */
  onToggle?(on: boolean): void;
  /** A session started (true) or ended (false) — status bar hint. */
  onSession?(active: boolean): void;
  /** The state when nothing valid is stored. App passes whether the test hooks of CONTRACT §4 are installed
   *  (the dev server, ?perf=1): ON there, so the test files keep exercising the editing code; OFF for a user
   *  (release decision for 0.2.0). Omitted: false. */
  defaultOn?: boolean;
  /** Rule L4: turning editing on failed because its code could not be loaded (at startup or by a toggle); the switch
   *  stays off. A failure of a set() / toggle() stores '0' (RL-1: the switch is off, and that is the truth); a failure
   *  of the startup's load stores nothing (a stored '1' survives a passing failure). App shows PREVIEW_EDIT_T.loadFailed. */
  onUnavailable?(err: unknown): void;
  /** Rule L3 (RL-2): a load of the editing chunk for a wish of on is on its way (`busy` true; called again when a set()
   *  joins it) or no longer (false: it settled, the wish was withdrawn, or the controller went off). `byUser`: that wish
   *  came from set() / toggle(), not from the startup's stored value. App: aria-busy on the toolbar button, and
   *  PREVIEW_EDIT_T.loading 300 ms after a user's press. */
  onLoading?(busy: boolean, byUser: boolean): void;
  /** Rule L8: when the stored preference says on, the startup asks for the editing chunk only when `run` is called
   *  (App: after the worker's first idle, so the chunk never competes with the worker script and the first render).
   *  Omitted (App with the test hooks, whose boot has the chunk already): at once. A set() before that cancels it. */
  deferStart?(run: () => void): void;
}

/** Rule L3: what a set() / toggle() ended in — 'on' / 'off' (true now), 'failed' (the editing code could not be loaded:
 *  off). A set() withdrawn by a later one before it settled reports nothing. */
export type PreviewEditOutcome = 'on' | 'off' | 'failed';

export interface PreviewEditController {
  /** What is TRUE (rule L3): on only once the editing module is installed and editable. */
  isOn(): boolean;
  /** Applies, persists and announces ('previewEdit:changed') — at once, or (on, before the editing chunk arrived) when it
   *  has arrived; `report` hears the outcome (synchronously when it applied at once). */
  set(on: boolean, report?: (r: PreviewEditOutcome) => void): void;
  /** Flips the last wish (a set still waiting for the chunk counts as that wish: on, off, on → on). */
  toggle(report?: (r: PreviewEditOutcome) => void): void;
  /** The id of the block being edited in the preview, or null. */
  sessionId(): number | null;
  sessionActive(): boolean;
  /** Ends the active session so its last serialization reaches the source, and drops a pending resume
   *  (cheap no-op otherwise). */
  commit(): void;
  /** Writes the active session's pending serialization to the source and keeps the session (⌘S). */
  flush(): void;
  off(): void;
}

export function createPreviewEdit(o: PreviewEditOptions): PreviewEditController {
  // THE DEFAULT RULE (release decision for 0.2.0, CONTRACT §11), decided here and nowhere else: a stored
  // '1' / 'true' / 'on' is on, '0' / 'false' / 'off' is off; nothing stored, or a damaged value, is OFF for a
  // user and ON only where the test hooks are installed (o.defaultOn: App passes hooksEnabled).
  const wanted = parsePreviewEditPref(o.read(LS_PREVIEW_EDIT), o.defaultOn === true);
  // Rule L3: `on` is what is TRUE — the editing module installed and editable. The pressed button, the stored value, the
  // toast and 'previewEdit:changed' follow it, never a wish still waiting for the editing chunk.
  let on = false;
  /** A set() still waiting for the chunk (its target); null when none. The startup's stored wish is not one: a toggle
   *  during the startup load flips what the button shows. */
  let wish: boolean | null = null;
  /** Rule L3: the last set wins — an older one still waiting is ignored when it settles. */
  let seq = 0;
  let session: number | null = null;
  let offed = false;
  const offSession = o.bus.on('previewEdit:session', (e) => {
    const next = e && typeof e.id === 'number' ? e.id : null;
    const was = session !== null;
    session = next;
    if (was !== (next !== null)) o.onSession?.(next !== null);
  });
  const settle = (next: boolean, persist: boolean): void => {
    on = next;
    if (persist) o.write(LS_PREVIEW_EDIT, next ? '1' : '0');
    o.onToggle?.(next);
    o.bus.emit('previewEdit:changed', next);
  };
  /** Rule L3 (RL-2): whether onLoading was last told that a load is on its way. */
  let loading = false;
  const setLoading = (busy: boolean, byUser: boolean): void => {
    if (!busy && !loading) return;
    loading = busy;
    o.onLoading?.(busy, byUser);
  };
  const apply = (next: boolean, persist: boolean, report?: (r: PreviewEditOutcome) => void): void => {
    const my = ++seq;
    const r = o.preview.setPreviewEditable(next);
    if (!r || typeof (r as Promise<boolean>).then !== 'function') {
      wish = null;
      setLoading(false, persist);
      settle(next, persist);
      report?.(next ? 'on' : 'off');
      return;
    }
    // The startup's wish waits for the chunk: until then the button, the bus and every reader see what is true (off).
    if (!persist && !started) settle(false, false);
    setLoading(true, persist);
    (r as Promise<boolean>).then(
      (ok) => {
        if (my !== seq) return;
        wish = null;
        setLoading(false, persist);
        if (ok) settle(true, persist);
        report?.(ok ? 'on' : 'off');
      },
      (err: unknown) => {
        if (my !== seq) return;
        wish = null;
        setLoading(false, persist);
        console.warn('[mdr] previewEdit: the editing code could not be loaded', err);
        // RL-1: a load the user asked for failed: the switch is off, and that is what is stored now (so a chunk that can
        // never load stops failing at every start); the startup's own failure writes nothing.
        if (persist) o.write(LS_PREVIEW_EDIT, '0');
        o.onUnavailable?.(err);
        report?.('failed');
      },
    );
  };
  /** A set() was made: a deferred startup wish is withdrawn (the last toggle wins). */
  let started = false;
  // Startup: apply the stored preference without writing it back (rule L4: a stored '1' stays when the chunk fails).
  if (wanted && o.deferStart) {
    settle(false, false);
    o.deferStart(() => { if (!started && !offed) apply(true, false); });
  } else apply(wanted, false);

  const ctl: PreviewEditController = {
    isOn: () => on,
    set(next, report) {
      started = true;
      if (!next) ctl.commit();
      wish = next;
      apply(next, true, report);
    },
    toggle(report) {
      ctl.set(!(wish ?? on), report);
    },
    sessionId: () => session,
    sessionActive: () => session !== null,
    // G16: unconditional — between two sessions (a Backspace merge, a ⌘Z step, a split) the preview may hold
    // a pending resume with queued keys and no live session; end() cancels it too. Both are cheap no-ops
    // when the preview has nothing pending.
    commit() {
      o.preview.endEditSession();
    },
    flush() {
      o.preview.flushEditSession();
    },
    off() {
      offed = true;
      offSession();
      seq++;                                       // a load still on its way changes nothing any more
      setLoading(false, false);
    },
  };
  return ctl;
}

/** A synthetic keydown for `shortcut` (CodeMirror notation), shaped so `matchShortcut` accepts it. Used to
 *  hand a native-menu / toolbar format command to the preview's session, whose key handler implements it. */
export function shortcutKeyEvent(shortcut: string, win: Window & typeof globalThis = window): KeyboardEvent {
  const p = parseShortcut(shortcut);
  const key = p.key;
  const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : '';
  return new win.KeyboardEvent('keydown', {
    key,
    code,
    metaKey: p.mod && IS_MAC,
    ctrlKey: p.ctrl || (p.mod && !IS_MAC),
    altKey: p.alt,
    shiftKey: p.shift,
    bubbles: true,
    cancelable: true,
  });
}

/** Marks the cursor notification a preview write causes (finding high 1). CodeMirror reports the caret
 *  rAF-coalesced, so the notification for a write arrives a frame later — possibly after the session already
 *  ended (Enter splits the block: the session ends, the write's notification fires next frame, the new
 *  session starts later). `note()` marks a write (source.replace / source.history call it); App's
 *  `editor.onCursor` wrapper calls `consume()` for EVERY notification, so the mark belongs to exactly the
 *  notification that write caused: that one is announced as `doc:cursor {typing:false}` and the focus-line
 *  wiring ignores it (CONTRACT §9 / §11) — neither the cursor-follow nor the focus line follows the
 *  editor's unfocused caret; the status bar and the TOC do (it sits in the edited block). */
export function previewWriteGate(): { note(): void; consume(): boolean } {
  let wrote = false;
  return {
    note() { wrote = true; },
    consume() { const w = wrote; wrote = false; return w; },
  };
}
