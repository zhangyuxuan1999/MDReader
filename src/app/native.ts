// src/app/native.ts — the renderer half of the Electron shell wiring (CONTRACT §10).
// Everything here is inert in the web build: App only calls it when `getNative()` returns a bridge.
// src/shared/i18n.ts is frozen, so the desktop-only zh-CN strings live in this module.
import type { MdrNative, NativeDocumentState } from '../shared/native';
import type { CommandId, CommandRegistry, OpenedFile, ToastSpec } from '../shared/types';
import { T } from '../shared/i18n';
import { chooseDialog, type QuestionGate } from './dialogs';

/** The `onCommand` ids that are not CommandIds (src/shared/types.ts is frozen). `app.closeRequested`
 *  is the shell asking whether it may close (CONTRACT §10); 撤销 / 重做 are menu items rather than
 *  AppKit roles because Chromium's own Redo command cannot drive CodeMirror's history
 *  (electron/menu.mjs explains the whole story). */
export const CLOSE_REQUESTED = 'app.closeRequested';
export const EDIT_UNDO = 'edit.undo';
export const EDIT_REDO = 'edit.redo';

/** zh-CN strings owned by this module. */
export const NATIVE_T = {
  save: '保存',
  dontSave: '不保存',
  cancel: '取消',
  closeDirty: (name: string): string => `文档「${name}」有未保存的更改，是否保存？`,
} as const;

// ---------------------------------------------------------------- open failures (CONTRACT §11, R3)

/** What went wrong when a document could not be opened. */
export type OpenFailure = 'missing' | 'denied' | 'folder' | 'notRegular' | 'undecodable' | 'other';

/** zh-CN reasons for a failed open (src/shared/i18n.ts is frozen, so they live here). */
export const OPEN_FAIL_T = {
  title: (name: string): string => (name ? `无法打开「${name}」` : '无法打开该文件'),
  missing: '找不到这个文件，它可能已被移动、重命名或删除',
  forgotRecent: '已从最近列表移除',
  denied: '没有读取这个文件的权限',
  /** macOS privacy protection (TCC) refused the read: the shell reports it as EACCES with a message
   *  that mentions 隐私与安全性 (see PRIVACY_MARK); today it merges EPERM into a plain EACCES. */
  deniedPrivacy: '没有读取这个文件的权限（macOS「隐私与安全性」设置不允许 MDReader 访问这个位置）',
  folder: '这是一个文件夹，不是文件',
  notRegular: '这不是普通文件（可能是管道、套接字或设备）',
  undecodable: '无法识别它的文本编码，它可能不是文本文件',
  unknown: '未知错误',
  /** G33: the browser refused to show the 打开… panel itself — no file was involved. */
  pickerTitle: '无法打开文件选择窗口',
  /** NotAllowedError: another file panel is still open, or the page may not show one now. */
  pickerBusy: '浏览器拒绝了这次请求（可能已有一个文件选择窗口打开着），请关闭它后再试',
  /** SecurityError: no user activation (the request did not follow a click or a key press). */
  pickerGesture: '浏览器只在点击或按键之后才允许打开它，请再点一次「打开」',
} as const;

/** Markers inside the shell's messages (electron/fileIO.mjs builds them; NativeFileError.code is
 *  frozen to five values and FIFO / undecodable both arrive as 'EIO'). Matched, not parsed. */
const FOLDER_MARK = '文件夹';
const NOT_REGULAR_MARK = '不是普通文件';
const UNDECODABLE_MARK = '无法识别该文件的文本编码';
const PRIVACY_MARK = '隐私与安全性';

function failureMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(err);
}

/** Classifies any rejection of an open: a DOMException from nativeBackend's toOpenError / the File
 *  System Access API, an Error carrying the shell's `code`, or a raw NativeFileError-shaped object. */
export function classifyOpenFailure(err: unknown): OpenFailure {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotFoundError') return 'missing';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES') return 'denied';
  const msg = failureMessage(err);
  if (code === 'EISDIR' || (msg.includes(FOLDER_MARK) && msg.includes('不是文件'))) return 'folder';
  if (msg.includes(NOT_REGULAR_MARK)) return 'notRegular';
  if (msg.includes(UNDECODABLE_MARK)) return 'undecodable';
  return 'other';
}

export interface OpenFailureContext {
  /** Basename of the file (empty when unknown, e.g. a failed 打开… panel pick). */
  name: string;
  /** The web build keeps its File System Access wording for a revoked permission (T.needReauth):
   *  there it is literally true. The desktop has nothing to re-authorise. */
  desktop: boolean;
  /** The entry was dropped from the recent list. */
  forgotRecent?: boolean;
  /** The rejection came from the web 打开… panel before any file was chosen (G33): a refusal there is the
   *  browser's, not a permission problem of a file. */
  picker?: boolean;
}

/** The text of a failed open: names the file and says what happened, in plain zh-CN. */
export function openFailureText(err: unknown, c: OpenFailureContext): string {
  const kind = classifyOpenFailure(err);
  if (c.picker && !c.desktop && kind === 'denied') {
    const security = err instanceof DOMException && err.name === 'SecurityError';
    return `${OPEN_FAIL_T.pickerTitle}：${security ? OPEN_FAIL_T.pickerGesture : OPEN_FAIL_T.pickerBusy}`;
  }
  let reason: string;
  switch (kind) {
    case 'missing':
      reason = OPEN_FAIL_T.missing + (c.forgotRecent ? `，${OPEN_FAIL_T.forgotRecent}` : '');
      break;
    case 'denied':
      reason = !c.desktop ? T.needReauth : failureMessage(err).includes(PRIVACY_MARK) ? OPEN_FAIL_T.deniedPrivacy : OPEN_FAIL_T.denied;
      break;
    case 'folder':
      reason = OPEN_FAIL_T.folder;
      break;
    case 'notRegular':
      reason = OPEN_FAIL_T.notRegular;
      break;
    case 'undecodable':
      reason = OPEN_FAIL_T.undecodable;
      break;
    default:
      reason = failureMessage(err) || OPEN_FAIL_T.unknown;
  }
  return `${OPEN_FAIL_T.title(c.name)}：${reason}`;
}

/** The toast of a failed open: it stays until the user dismisses it (×) — finding F4 / R3: an 8-second
 *  toast over the empty scratch buffer looked like "the file opened empty". */
export function openFailureToast(err: unknown, c: OpenFailureContext): ToastSpec {
  return { text: openFailureText(err, c), kind: 'error', timeoutMs: 0 };
}

/** Basename of an absolute path (POSIX or Windows separators). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ---------------------------------------------------------------- unload guard

/**
 * The web unsaved-changes guard. In Electron a `beforeunload` `returnValue` shows no prompt — it just
 * silently blocks the close, leaving the user with a window that will not go away. The shell owns the
 * close/quit guard there (it sends `app.closeRequested`), so with a bridge present nothing is installed.
 */
export function installUnloadGuard(win: Window, isDirty: () => boolean, native: MdrNative | undefined): () => void {
  if (native) return () => {};
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  win.addEventListener('beforeunload', onBeforeUnload);
  return () => win.removeEventListener('beforeunload', onBeforeUnload);
}

// ---------------------------------------------------------------- open by path

export interface NativeOpenerOptions {
  /** App's dirty guard (当前文档尚未保存，是否放弃更改？); false = the user kept the document.
   *  App runs the whole opener inside its DocumentGuard, so false really means 取消 — a second
   *  caller is never refused while the question is on screen (R1). */
  confirmDiscard(): Promise<boolean>;
  /** `openPath` from src/files/nativeBackend.ts (rejects NotFoundError when the file is gone). */
  readPath(path: string): Promise<OpenedFile>;
  /** App's `openFile`. */
  load(f: OpenedFile): Promise<void>;
  /** Drop a vanished file from the recent list; `docId` is known when the open came from that list.
   *  Resolves true when an entry was removed. */
  forgetRecent(path: string, docId?: string): Promise<boolean | void>;
  toast(spec: ToastSpec): void;
  /** G34: a failed open of `path` (one toast per path, replaced by a newer failure of it). Without it the
   *  failure goes through `toast`. */
  fail?(path: string, spec: ToastSpec): void;
}

/** The open-by-absolute-path flow shared by `onOpenFile` (double-click, Dock drop) and the recent list.
 *  A failure leaves the current document on screen and shows a message that stays until dismissed. */
export function createNativeOpener(o: NativeOpenerOptions): (path: string, docId?: string) => Promise<void> {
  return async (path, docId) => {
    const failed = (spec: ToastSpec): void => (o.fail ? o.fail(path, spec) : o.toast(spec));
    if (!(await o.confirmDiscard())) return;
    let f: OpenedFile;
    try {
      f = await o.readPath(path);
    } catch (err) {
      let forgot = false;
      if (classifyOpenFailure(err) === 'missing') {
        try {
          forgot = (await o.forgetRecent(path, docId)) === true;
        } catch {
          /* the recent store is best effort */
        }
      }
      failed(openFailureToast(err, { name: baseName(path), desktop: true, forgotRecent: forgot }));
      return;
    }
    try {
      await o.load(f);
    } catch (err) {
      failed(openFailureToast(err, { name: f.name || baseName(path), desktop: true }));
    }
  };
}

// ---------------------------------------------------------------- 编辑 → 撤销 / 重做 in a text field

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/** An `<input>` that takes typed text, or a `<textarea>`: the app's own UI fields (the palette, CodeMirror's
 *  find panel, the preview's link input). Not CodeMirror's content (a contenteditable div) and not a task
 *  checkbox. */
export function isUiTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
  if (el.tagName !== 'INPUT') return false;
  const i = el as HTMLInputElement;
  return TEXT_INPUT_TYPES.has((i.getAttribute('type') ?? '').toLowerCase()) && !i.readOnly && !i.disabled;
}

/** Undo / redo inside the focused UI text field (the browser's own editing history of that field).
 *  True when a text field had the focus — the step is then the field's, never the document's. */
function fieldHistory(redoIt: boolean, doc: Document = document): boolean {
  if (!isUiTextField(doc.activeElement)) return false;
  try {
    doc.execCommand(redoIt ? 'redo' : 'undo');
  } catch {
    /* nothing to step: the field keeps its text, the document is not touched either */
  }
  return true;
}

// ---------------------------------------------------------------- bridge subscription

export interface NativeHost {
  /** Where dialogs are mounted (LayoutEls.overlay). */
  overlay: HTMLElement;
  registry: CommandRegistry;
  /** Name of the current document, for the close dialog. */
  docName(): string;
  isDirty(): boolean;
  /** The opener from `createNativeOpener` (runs the dirty guard itself). */
  openPath(path: string): Promise<void>;
  /** The 保存 flow; true when the document is on disk afterwards (false = failed or the user cancelled). */
  save(): Promise<boolean>;
  /** Runs a command id the shell sent. App uses it to bring the editor back on screen for
   *  editor-scope commands; without it the id goes straight to the registry. */
  runCommand?(id: CommandId): void;
  /** CodeMirror's undo / redo, for the 编辑 menu items. */
  undo?(): void;
  redo?(): void;
  /** App's question gate (dialogs.ts): the close question waits for a discard question on screen and
   *  a discard question waits for the close question — never two at once (R1). */
  questions?: QuestionGate;
  /** True while the user has answered 丢弃 and the document that replaces it is still loading: a close
   *  request that waited for that answer closes without asking again. */
  discardDecided?(): boolean;
  /** The user threw the document away (不保存, or 丢弃 just before): delete its draft so the next
   *  window does not offer to restore it (R2). Bounded by the caller. */
  discardDraft?(): Promise<void>;
}

/** How long the close flow waits for the draft deletion before answering the shell anyway: an
 *  unanswered close request leaves a window that cannot be closed. */
const DISCARD_DRAFT_WAIT_MS = 1500;

export interface NativeWiring {
  /** Report the document identity / dirty flag to the shell (title, edited dot, close guard). Deduped. */
  setDocumentState(s: NativeDocumentState): void;
  dispose(): void;
}

export function installNative(bridge: MdrNative, host: NativeHost): NativeWiring {
  let disposed = false;
  let lastState = '';
  let closing = false;
  // Open-file events can arrive in bursts (a multi-file "Open With", a second launch forwarding argv):
  // run them one at a time so two dirty guards never stack.
  let chain: Promise<unknown> = Promise.resolve();

  const offOpen = bridge.onOpenFile((path) => {
    if (disposed || typeof path !== 'string' || path === '') return;
    chain = chain.then(
      () => host.openPath(path),
      () => host.openPath(path),
    ).catch(() => undefined);
  });

  const discardDraft = async (): Promise<void> => {
    if (!host.discardDraft) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        host.discardDraft(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DISCARD_DRAFT_WAIT_MS);
        }),
      ]);
    } catch {
      /* best effort: the close must be answered either way */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /** One close request → exactly one resolveClose. A repeated request while one is pending (waiting
   *  for its turn or on screen) is covered by that pending answer: the shell sends one per close. */
  const handleClose = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    let decision: 'save' | 'discard' | 'cancel' = 'cancel';
    const decide = async (): Promise<'save' | 'discard' | 'cancel'> => {
      // The shell only asks while dirty, but a stale question (the user saved in between, or the
      // discard question it waited for replaced the document) is answered at once.
      if (!host.isDirty()) return 'discard';
      if (host.discardDecided?.()) {
        await discardDraft();
        return 'discard';
      }
      const answer = await chooseDialog(host.overlay, {
        text: NATIVE_T.closeDirty(host.docName()),
        choices: [
          { id: 'discard', label: NATIVE_T.dontSave, kind: 'danger' },
          { id: 'cancel', label: NATIVE_T.cancel },
          { id: 'save', label: NATIVE_T.save, kind: 'primary' },
        ],
        defaultId: 'save',
        cancelId: 'cancel',
      });
      // 保存 only closes the window when the write actually happened: a cancelled 另存为 (or a failed
      // write) must keep the document — and the window — alive.
      if (answer === 'save') return (await host.save()) ? 'save' : 'cancel';
      if (answer === 'discard') {
        await discardDraft();
        return 'discard';
      }
      return 'cancel';
    };
    try {
      decision = host.questions ? await host.questions.ask(decide) : await decide();
    } catch {
      decision = 'cancel';
    } finally {
      closing = false;
      bridge.resolveClose(decision);
    }
  };

  const offCommand = bridge.onCommand((id) => {
    if (disposed || typeof id !== 'string') return;
    if (id === CLOSE_REQUESTED) {
      void handleClose();
      return;
    }
    if (id === EDIT_UNDO || id === EDIT_REDO) {
      // G39: a text field of the app (palette input, find field, link input) has the focus: the step is
      // that field's own, exactly what the role-based menu item would have done there.
      if (fieldHistory(id === EDIT_REDO)) return;
      if (id === EDIT_UNDO) host.undo?.();
      else host.redo?.();
      return;
    }
    // Unknown ids are ignored (registry.run returns false for them).
    if (host.runCommand) host.runCommand(id as CommandId);
    else host.registry.run(id as CommandId);
  });

  return {
    setDocumentState(s) {
      if (disposed) return;
      const key = `${s.path ?? ''}\u0000${s.name}\u0000${s.dirty ? 1 : 0}`;
      if (key === lastState) return;
      lastState = key;
      try {
        bridge.setDocumentState(s);
      } catch {
        /* the shell went away */
      }
    },
    dispose() {
      disposed = true;
      offOpen?.();
      offCommand?.();
    },
  };
}
