// @vitest-environment jsdom
// App's shell wiring (src/app/native.ts, CONTRACT §10) driven through a fake bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MdrNative, NativeDocumentState } from '../src/shared/native';
import type { OpenedFile, ToastSpec } from '../src/shared/types';
import { createCommandRegistry } from '../src/app/registry';
import { confirmDialog, createDocumentGuard, createQuestionGate } from '../src/app/dialogs';
import { T } from '../src/shared/i18n';
import {
  CLOSE_REQUESTED,
  EDIT_REDO,
  EDIT_UNDO,
  NATIVE_T,
  classifyOpenFailure,
  createNativeOpener,
  installNative,
  installUnloadGuard,
  isUiTextField,
  openFailureText,
  type NativeHost,
} from '../src/app/native';
import { toOpenError } from '../src/files/nativeBackend';
import { nativeErrorFor } from '../electron/paths.mjs';
import { NOT_REGULAR_MESSAGE, UNDECODABLE_MESSAGE } from '../electron/fileIO.mjs';
import { installLayoutStubs } from './editor.helpers';
import type { DraftRecord, SaveResult } from '../src/shared/types';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

installLayoutStubs();

interface Fake extends MdrNative {
  emitOpen(path: string): void;
  emitCommand(id: string): void;
  closes: Array<'save' | 'discard' | 'cancel'>;
  states: NativeDocumentState[];
  openSubs: number;
  commandSubs: number;
}

function fakeBridge(): Fake {
  const openCbs: Array<(p: string) => void> = [];
  const cmdCbs: Array<(id: string) => void> = [];
  const f: Fake = {
    platform: 'darwin',
    version: '0.1.0',
    openSubs: 0,
    commandSubs: 0,
    closes: [],
    states: [],
    openDialog: async () => null,
    saveDialog: async () => null,
    readFile: async () => {
      throw new Error('unused');
    },
    writeFile: async () => ({ lastModified: 0 }),
    pathForFile: () => null,
    onOpenFile(cb) {
      openCbs.push(cb);
      f.openSubs++;
      return () => {
        openCbs.splice(openCbs.indexOf(cb), 1);
        f.openSubs--;
      };
    },
    onCommand(cb) {
      cmdCbs.push(cb);
      f.commandSubs++;
      return () => {
        cmdCbs.splice(cmdCbs.indexOf(cb), 1);
        f.commandSubs--;
      };
    },
    resolveClose: (d) => {
      f.closes.push(d);
    },
    setDocumentState: (s) => {
      f.states.push(s);
    },
    addRecent: () => {},
    emitOpen: (p) => openCbs.slice().forEach((cb) => cb(p)),
    emitCommand: (id) => cmdCbs.slice().forEach((cb) => cb(id)),
  };
  return f;
}

/** The dialog rendered into `overlay`, addressed the way a user would: by its button labels. */
function dialogButton(overlay: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(overlay.querySelectorAll<HTMLButtonElement>('.mdr-dialog__btn')).find((b) => b.textContent === label);
}
const dialogText = (overlay: HTMLElement): string | null => overlay.querySelector('.mdr-dialog__text')?.textContent ?? null;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function host(overlay: HTMLElement, over: Partial<NativeHost> = {}): NativeHost & { opened: string[]; saves: number } {
  const h = {
    overlay,
    registry: createCommandRegistry(),
    opened: [] as string[],
    saves: 0,
    docName: () => 'a.md',
    isDirty: () => true,
    openPath: async (p: string) => {
      h.opened.push(p);
    },
    save: async () => {
      h.saves++;
      return true;
    },
    ...over,
  };
  return h;
}

describe('installUnloadGuard', () => {
  it('installs the web beforeunload guard when there is no bridge', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const off = installUnloadGuard(window, () => true, undefined);
    expect(add.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    off();
    add.mockRestore();
  });

  it('does not block the close while clean', () => {
    const off = installUnloadGuard(window, () => false, undefined);
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    off();
  });

  it('installs NOTHING when the desktop bridge is present (Electron blocks silently)', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const off = installUnloadGuard(window, () => true, fakeBridge());
    expect(add.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(false);
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    off();
    add.mockRestore();
  });
});

describe('createNativeOpener', () => {
  const opened: OpenedFile = { docId: 'native:/a.md', name: 'a.md', text: '#', path: '/a.md', lastModified: 1, source: 'native' };

  function opener(over: Partial<Parameters<typeof createNativeOpener>[0]> = {}) {
    const calls = { loaded: [] as OpenedFile[], forgot: [] as Array<[string, string | undefined]>, toasts: [] as ToastSpec[] };
    const run = createNativeOpener({
      confirmDiscard: async () => true,
      readPath: async () => opened,
      load: async (f) => {
        calls.loaded.push(f);
      },
      forgetRecent: async (p, id) => {
        calls.forgot.push([p, id]);
      },
      toast: (t) => calls.toasts.push(t),
      ...over,
    });
    return { run, calls };
  }

  it('runs the dirty guard before loading', async () => {
    const order: string[] = [];
    const { run, calls } = opener({
      confirmDiscard: async () => {
        order.push('guard');
        return true;
      },
      readPath: async () => {
        order.push('read');
        return opened;
      },
    });
    await run('/a.md');
    expect(order).toEqual(['guard', 'read']);
    expect(calls.loaded).toHaveLength(1);
  });

  it('a declined guard keeps the current document', async () => {
    const { run, calls } = opener({ confirmDiscard: async () => false });
    await run('/a.md');
    expect(calls.loaded).toHaveLength(0);
  });

  it('a vanished file is dropped from recents; the message names it, says so and stays (R3)', async () => {
    const { run, calls } = opener({
      readPath: async () => {
        throw new DOMException('gone', 'NotFoundError');
      },
      forgetRecent: async (p, id) => {
        calls.forgot.push([p, id]);
        return true;
      },
    });
    await run('/docs/gone.md', 'native:/docs/gone.md');
    expect(calls.forgot).toEqual([['/docs/gone.md', 'native:/docs/gone.md']]);
    expect(calls.toasts[0]).toEqual({
      text: '无法打开「gone.md」：找不到这个文件，它可能已被移动、重命名或删除，已从最近列表移除',
      kind: 'error',
      timeoutMs: 0,
    });
    expect(calls.loaded).toHaveLength(0);
  });

  it('a double-clicked file that is gone does not claim a recent entry it never had', async () => {
    const { run, calls } = opener({
      readPath: async () => {
        throw new DOMException('gone', 'NotFoundError');
      },
      forgetRecent: async () => false,
    });
    await run('/x/新建.md');
    expect(calls.toasts[0].text).toBe('无法打开「新建.md」：找不到这个文件，它可能已被移动、重命名或删除');
    expect(calls.toasts[0].text).not.toContain('最近列表');
  });

  it('a dirty document gets App\u2019s real discard dialog before the new file loads', async () => {
    // The same guard App installs (confirmDialog + T.discardChanges), driven end to end.
    document.body.innerHTML = '';
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const calls: OpenedFile[] = [];
    const run = createNativeOpener({
      confirmDiscard: () => confirmDialog(overlay, { text: T.discardChanges, ok: T.discard, danger: true }),
      readPath: async () => opened,
      load: async (f) => {
        calls.push(f);
      },
      forgetRecent: async () => {},
      toast: () => {},
    });
    const pending = run('/a.md');
    await tick();
    expect(overlay.querySelector('.mdr-dialog__text')!.textContent).toBe('\u5f53\u524d\u6587\u6863\u5c1a\u672a\u4fdd\u5b58\uff0c\u662f\u5426\u653e\u5f03\u66f4\u6539\uff1f');
    expect(calls).toHaveLength(0);
    Array.from(overlay.querySelectorAll<HTMLButtonElement>('.mdr-dialog__btn')).find((b) => b.textContent === T.discard)!.click();
    await pending;
    expect(calls).toHaveLength(1);
  });

  it('other errors surface as an open-failed toast and keep the recent entry', async () => {
    const { run, calls } = opener({
      readPath: async () => {
        throw new Error('disk on fire');
      },
    });
    await run('/a.md');
    expect(calls.forgot).toHaveLength(0);
    expect(calls.toasts[0]).toEqual({ text: '无法打开「a.md」：disk on fire', kind: 'error', timeoutMs: 0 });
  });
});

describe('installNative', () => {
  let overlay: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    overlay = document.createElement('div');
    document.body.appendChild(overlay);
  });

  it('forwards onOpenFile paths to the opener, one at a time', async () => {
    const b = fakeBridge();
    const order: string[] = [];
    let release: (() => void) | null = null;
    const h = host(overlay, {
      openPath: async (p) => {
        order.push('start:' + p);
        if (p === '/1.md') await new Promise<void>((r) => (release = r));
        order.push('done:' + p);
      },
    });
    const w = installNative(b, h);
    b.emitOpen('/1.md');
    b.emitOpen('/2.md');
    await tick();
    expect(order).toEqual(['start:/1.md']);
    release!();
    await tick();
    await tick();
    expect(order).toEqual(['start:/1.md', 'done:/1.md', 'start:/2.md', 'done:/2.md']);
    w.dispose();
  });

  it('ignores empty paths and anything after dispose', async () => {
    const b = fakeBridge();
    const h = host(overlay);
    const w = installNative(b, h);
    b.emitOpen('');
    await tick();
    expect(h.opened).toEqual([]);
    w.dispose();
    expect(b.openSubs).toBe(0);
    expect(b.commandSubs).toBe(0);
  });

  it('sends 撤销 / 重做 to CodeMirror instead of the registry', () => {
    // The 编辑 menu items are custom (not AppKit roles): Chromium's Redo editor command cannot drive
    // CodeMirror 6's history, so the item used to do nothing at all.
    const b = fakeBridge();
    const undo = vi.fn();
    const redo = vi.fn();
    const run = vi.fn();
    const h = host(overlay, { undo, redo });
    h.registry.register({ id: 'file.new', title: '新建', scope: 'global', run });
    const w = installNative(b, h);
    b.emitCommand(EDIT_UNDO);
    b.emitCommand(EDIT_REDO);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    w.dispose();
  });

  // G39: with an app text field focused (palette input, find field, link input) the menu step is the field's.
  it('leaves 撤销 / 重做 to a focused UI text field (execCommand), never the document', () => {
    const b = fakeBridge();
    const undo = vi.fn();
    const redo = vi.fn();
    const h = host(overlay, { undo, redo });
    const w = installNative(b, h);
    const exec = vi.fn(() => true);
    const orig = document.execCommand;
    document.execCommand = exec as unknown as typeof document.execCommand;
    try {
      const input = document.createElement('input');
      overlay.appendChild(input);
      input.focus();
      b.emitCommand(EDIT_UNDO);
      b.emitCommand(EDIT_REDO);
      expect(exec.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['undo', 'redo']);
      expect(undo).not.toHaveBeenCalled();
      expect(redo).not.toHaveBeenCalled();
      const area = document.createElement('textarea');
      overlay.appendChild(area);
      area.focus();
      b.emitCommand(EDIT_UNDO);
      expect(exec).toHaveBeenCalledTimes(3);
      // A task checkbox (an <input> too) and a plain element are not text fields: the document steps.
      const box = document.createElement('input');
      box.type = 'checkbox';
      overlay.appendChild(box);
      box.focus();
      b.emitCommand(EDIT_UNDO);
      const div = document.createElement('div');
      div.tabIndex = 0;
      overlay.appendChild(div);
      div.focus();
      b.emitCommand(EDIT_REDO);
      expect(undo).toHaveBeenCalledTimes(1);
      expect(redo).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(3);
    } finally {
      document.execCommand = orig;
      w.dispose();
    }
  });

  it('isUiTextField: text-like inputs and textareas only', () => {
    const mk = (tag: string, type?: string): Element => {
      const e = document.createElement(tag);
      if (type !== undefined) e.setAttribute('type', type);
      return e;
    };
    expect(isUiTextField(mk('input'))).toBe(true);
    expect(isUiTextField(mk('input', 'search'))).toBe(true);
    expect(isUiTextField(mk('input', 'TEXT'))).toBe(true);
    expect(isUiTextField(mk('textarea'))).toBe(true);
    expect(isUiTextField(mk('input', 'checkbox'))).toBe(false);
    expect(isUiTextField(mk('input', 'button'))).toBe(false);
    expect(isUiTextField(mk('div'))).toBe(false);
    expect(isUiTextField(null)).toBe(false);
    const ro = mk('input') as HTMLInputElement;
    ro.readOnly = true;
    expect(isUiTextField(ro)).toBe(false);
  });

  it('prefers host.runCommand over the registry when App provides one', () => {
    const b = fakeBridge();
    const runCommand = vi.fn();
    const run = vi.fn();
    const h = host(overlay, { runCommand });
    h.registry.register({ id: 'edit.bold', title: '加粗', scope: 'editor', run });
    const w = installNative(b, h);
    b.emitCommand('edit.bold');
    expect(runCommand).toHaveBeenCalledWith('edit.bold');
    expect(run).not.toHaveBeenCalled();
    w.dispose();
  });

  it('routes menu command ids through the registry and ignores unknown ones', () => {
    const b = fakeBridge();
    const h = host(overlay);
    const run = vi.fn();
    h.registry.register({ id: 'file.new', title: '新建', scope: 'global', run });
    const w = installNative(b, h);
    b.emitCommand('file.new');
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => b.emitCommand('nope.not.a.command')).not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    w.dispose();
  });

  describe('app.closeRequested', () => {
    it('shows the three-button zh-CN dialog with 保存 focused', async () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay, { docName: () => '笔记.md' }));
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      expect(dialogText(overlay)).toBe('文档「笔记.md」有未保存的更改，是否保存？');
      const labels = Array.from(overlay.querySelectorAll('.mdr-dialog__btn')).map((b2) => b2.textContent);
      expect(new Set(labels)).toEqual(new Set([NATIVE_T.save, NATIVE_T.dontSave, NATIVE_T.cancel]));
      expect(document.activeElement).toBe(dialogButton(overlay, NATIVE_T.save));
      dialogButton(overlay, NATIVE_T.cancel)!.click();
      await tick();
      w.dispose();
    });

    it('保存 → saves, then resolveClose("save")', async () => {
      const b = fakeBridge();
      const h = host(overlay);
      const w = installNative(b, h);
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      dialogButton(overlay, NATIVE_T.save)!.click();
      await tick();
      expect(h.saves).toBe(1);
      expect(b.closes).toEqual(['save']);
      expect(overlay.querySelector('.mdr-dialog')).toBeNull();
      w.dispose();
    });

    it('保存 that fails or is cancelled keeps the window open', async () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay, { save: async () => false }));
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      dialogButton(overlay, NATIVE_T.save)!.click();
      await tick();
      expect(b.closes).toEqual(['cancel']);
      w.dispose();
    });

    it('不保存 → resolveClose("discard")', async () => {
      const b = fakeBridge();
      const h = host(overlay);
      const w = installNative(b, h);
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      dialogButton(overlay, NATIVE_T.dontSave)!.click();
      await tick();
      expect(h.saves).toBe(0);
      expect(b.closes).toEqual(['discard']);
      w.dispose();
    });

    it('取消 → resolveClose("cancel")', async () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay));
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      dialogButton(overlay, NATIVE_T.cancel)!.click();
      await tick();
      expect(b.closes).toEqual(['cancel']);
      w.dispose();
    });

    it('Escape means 取消', async () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay));
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      overlay
        .querySelector('.mdr-dialog')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await tick();
      expect(b.closes).toEqual(['cancel']);
      w.dispose();
    });

    it('Enter on the focused 保存 button saves', async () => {
      const b = fakeBridge();
      const h = host(overlay);
      const w = installNative(b, h);
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      overlay
        .querySelector('.mdr-dialog')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
      expect(h.saves).toBe(1);
      expect(b.closes).toEqual(['save']);
      w.dispose();
    });

    it('a clean document closes immediately without a dialog', async () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay, { isDirty: () => false }));
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      expect(overlay.querySelector('.mdr-dialog')).toBeNull();
      expect(b.closes).toEqual(['discard']);
      w.dispose();
    });

    it('a repeated request while the dialog is up does not stack a second one', async () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay));
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      b.emitCommand(CLOSE_REQUESTED);
      await tick();
      expect(overlay.querySelectorAll('.mdr-dialog')).toHaveLength(1);
      dialogButton(overlay, NATIVE_T.dontSave)!.click();
      await tick();
      expect(b.closes).toEqual(['discard']);
      w.dispose();
    });
  });

  describe('setDocumentState', () => {
    it('reports path, name and dirty, and skips unchanged repeats', () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay));
      w.setDocumentState({ path: '/a.md', name: 'a.md', dirty: false });
      w.setDocumentState({ path: '/a.md', name: 'a.md', dirty: false });
      w.setDocumentState({ path: '/a.md', name: 'a.md', dirty: true });
      w.setDocumentState({ path: null, name: '未命名.md', dirty: false });
      expect(b.states).toEqual([
        { path: '/a.md', name: 'a.md', dirty: false },
        { path: '/a.md', name: 'a.md', dirty: true },
        { path: null, name: '未命名.md', dirty: false },
      ]);
      w.dispose();
    });

    it('is silent after dispose', () => {
      const b = fakeBridge();
      const w = installNative(b, host(overlay));
      w.dispose();
      w.setDocumentState({ path: null, name: 'x', dirty: true });
      expect(b.states).toEqual([]);
    });
  });
});


// ===================================================================================== fix round R1–R3
// CONTRACT §11 "Fix-round decisions": R1 (one question at a time, no request dropped), R2 (不保存 /
// 丢弃 delete the draft), R3 (a failed open names the file and stays). Findings F4 / F4b / F7 in
// docs/open-empty/lifecycle.md and the open-failure finding in docs/open-empty/files.md.

const dialogs = (overlay: ParentNode): number => overlay.querySelectorAll('.mdr-dialog').length;
const settle = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

describe('createQuestionGate / createDocumentGuard (R1)', () => {
  let overlay: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    overlay = document.createElement('div');
    document.body.appendChild(overlay);
  });

  it('a question asked while another is on screen waits for it instead of stacking', async () => {
    const gate = createQuestionGate();
    const order: string[] = [];
    const a = gate.ask(async () => {
      order.push('a');
      return confirmDialog(overlay, { text: 'A', ok: 'ok' });
    });
    const b = gate.ask(async () => {
      order.push('b');
      return confirmDialog(overlay, { text: 'B', ok: 'ok' });
    });
    await settle();
    expect(order).toEqual(['a']);
    expect(dialogs(overlay)).toBe(1);
    expect(gate.busy()).toBe(true);
    dialogButton(overlay, 'ok')!.click();
    expect(await a).toBe(true);
    await settle();
    expect(order).toEqual(['a', 'b']);
    expect(dialogText(overlay)).toBe('B');
    dialogButton(overlay, '取消')!.click();
    expect(await b).toBe(false);
    expect(gate.busy()).toBe(false);
  });

  it('a second operation waits for the first one — question AND load — and re-checks dirty', async () => {
    let dirty = true;
    const guard = createDocumentGuard({
      isDirty: () => dirty,
      ask: () => confirmDialog(overlay, { text: T.discardChanges, ok: T.discard, danger: true }),
    });
    const loaded: string[] = [];
    let releaseLoad: (() => void) | null = null;
    const op = (name: string, slow = false) =>
      guard.run(async () => {
        if (!(await guard.confirmDiscard())) return 'kept';
        if (slow) await new Promise<void>((r) => (releaseLoad = r));
        dirty = false; // the replacement document is clean
        loaded.push(name);
        return 'loaded';
      });
    const first = op('new', true);
    await settle();
    const second = op('a.md');
    await settle();
    expect(dialogs(overlay)).toBe(1); // never two questions
    dialogButton(overlay, T.discard)!.click();
    await settle();
    expect(guard.discardDecided()).toBe(true); // between 丢弃 and the end of that operation
    expect(loaded).toEqual([]); // the second one has not jumped the slow load
    releaseLoad!();
    expect(await first).toBe('loaded');
    expect(await second).toBe('loaded'); // nothing dropped
    expect(loaded).toEqual(['new', 'a.md']);
    expect(dialogs(overlay)).toBe(0); // the clean replacement needed no second question
    expect(guard.discardDecided()).toBe(false);
  });

  it('取消 on the first question: the waiting operation then asks its OWN question', async () => {
    const guard = createDocumentGuard({
      isDirty: () => true,
      ask: () => confirmDialog(overlay, { text: T.discardChanges, ok: T.discard, danger: true }),
    });
    const op = () => guard.run(async () => guard.confirmDiscard());
    const first = op();
    const second = op();
    await settle();
    expect(dialogs(overlay)).toBe(1);
    dialogButton(overlay, '取消')!.click();
    expect(await first).toBe(false);
    await settle();
    expect(dialogs(overlay)).toBe(1); // asked again, one at a time
    dialogButton(overlay, T.discard)!.click();
    expect(await second).toBe(true);
  });

  it('an operation that throws does not wedge the ones behind it', async () => {
    const guard = createDocumentGuard({ isDirty: () => false, ask: async () => true });
    await expect(guard.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await guard.run(async () => 7)).toBe(7);
  });
});

describe('installNative close request vs the discard question (R1 / F4b)', () => {
  let overlay: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    overlay = document.createElement('div');
    document.body.appendChild(overlay);
  });

  function setup(over: Partial<NativeHost> = {}) {
    const b = fakeBridge();
    let dirty = true;
    const questions = createQuestionGate();
    const guard = createDocumentGuard({
      gate: questions,
      isDirty: () => dirty,
      ask: () => confirmDialog(overlay, { text: T.discardChanges, ok: T.discard, danger: true }),
    });
    const draftDeletes: number[] = [];
    const h = host(overlay, {
      isDirty: () => dirty,
      questions,
      discardDecided: () => guard.discardDecided(),
      discardDraft: async () => {
        draftDeletes.push(b.closes.length);
      },
      ...over,
    });
    const w = installNative(b, h);
    let releaseRead: (() => void) | null = null;
    const replace = () =>
      guard.run(async () => {
        if (!(await guard.confirmDiscard())) return;
        await new Promise<void>((r) => (releaseRead = r));
        dirty = false;
      });
    return { b, w, guard, replace, draftDeletes, release: () => releaseRead?.(), setDirty: (d: boolean) => (dirty = d) };
  }

  it('close during the discard question waits; 丢弃 then answers the shell once, without a second question', async () => {
    const t = setup();
    const op = t.replace();
    await settle();
    t.b.emitCommand(CLOSE_REQUESTED);
    await settle();
    expect(dialogs(overlay)).toBe(1); // NOT 不保存 / 取消 / 保存 on top of 取消 / 丢弃
    expect(dialogText(overlay)).toBe(T.discardChanges);
    expect(t.b.closes).toEqual([]);
    dialogButton(overlay, T.discard)!.click();
    await settle();
    expect(dialogs(overlay)).toBe(0);
    expect(t.b.closes).toEqual(['discard']); // the user already threw the text away
    expect(t.draftDeletes).toEqual([0]); // its draft went before the answer (R2)
    t.release();
    await op;
    expect(t.b.closes).toEqual(['discard']); // exactly once
    t.w.dispose();
  });

  it('close during the discard question; 取消 there → the close question comes next, alone', async () => {
    const t = setup();
    const op = t.replace();
    await settle();
    t.b.emitCommand(CLOSE_REQUESTED);
    await settle();
    dialogButton(overlay, '取消')!.click();
    await op;
    await settle();
    expect(dialogs(overlay)).toBe(1);
    expect(dialogText(overlay)).toBe(NATIVE_T.closeDirty('a.md'));
    dialogButton(overlay, NATIVE_T.cancel)!.click();
    await settle();
    expect(t.b.closes).toEqual(['cancel']);
    expect(t.draftDeletes).toEqual([]); // nothing was discarded: the draft stays (crash recovery)
    t.w.dispose();
  });

  it('a discard question never stacks on the close question; it is asked after 取消', async () => {
    const t = setup();
    t.b.emitCommand(CLOSE_REQUESTED);
    await settle();
    const op = t.replace();
    await settle();
    expect(dialogs(overlay)).toBe(1);
    expect(dialogText(overlay)).toBe(NATIVE_T.closeDirty('a.md'));
    dialogButton(overlay, NATIVE_T.cancel)!.click();
    await settle();
    expect(t.b.closes).toEqual(['cancel']);
    expect(dialogs(overlay)).toBe(1);
    expect(dialogText(overlay)).toBe(T.discardChanges);
    dialogButton(overlay, '取消')!.click();
    await op;
    t.w.dispose();
  });

  it('不保存 on the close question deletes the draft before answering', async () => {
    const t = setup();
    t.b.emitCommand(CLOSE_REQUESTED);
    await settle();
    dialogButton(overlay, NATIVE_T.dontSave)!.click();
    await settle();
    expect(t.draftDeletes).toEqual([0]);
    expect(t.b.closes).toEqual(['discard']);
    t.w.dispose();
  });

  it('a draft deletion that never settles cannot keep the window from closing', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ discardDraft: () => new Promise<void>(() => {}) });
      t.b.emitCommand(CLOSE_REQUESTED);
      await vi.advanceTimersByTimeAsync(10);
      dialogButton(overlay, NATIVE_T.dontSave)!.click();
      await vi.advanceTimersByTimeAsync(2000);
      expect(t.b.closes).toEqual(['discard']);
      t.w.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a close request while the question it waits for is answered with 保存 elsewhere: clean → closes at once', async () => {
    const t = setup();
    const op = t.replace();
    await settle();
    t.b.emitCommand(CLOSE_REQUESTED);
    t.b.emitCommand(CLOSE_REQUESTED); // repeated while pending: covered by the one answer
    await settle();
    t.setDirty(false); // e.g. saved in between
    dialogButton(overlay, '取消')!.click();
    await op;
    await settle();
    expect(dialogs(overlay)).toBe(0);
    expect(t.b.closes).toEqual(['discard']);
    t.w.dispose();
  });
});

describe('open failures (R3)', () => {
  const shell = (code: string, message?: string) => toOpenError(nativeErrorFor(Object.assign(new Error(message ?? code), { code })));
  const io = (message: string) => toOpenError({ code: 'EIO', message });

  it('classifies every failure the shell reports, through the same mapping the renderer uses', () => {
    expect(classifyOpenFailure(shell('ENOENT'))).toBe('missing');
    expect(classifyOpenFailure(shell('ENOTDIR'))).toBe('missing');
    expect(classifyOpenFailure(shell('EACCES'))).toBe('denied');
    expect(classifyOpenFailure(shell('EPERM'))).toBe('denied');
    expect(classifyOpenFailure(shell('EISDIR'))).toBe('folder');
    // electron/fileIO.mjs readFileInfo: a directory, a FIFO, an undecodable file
    expect(classifyOpenFailure(toOpenError({ code: 'EISDIR', message: '这是一个文件夹，不是文件' }))).toBe('folder');
    expect(classifyOpenFailure(io('这是一个文件夹，不是文件'))).toBe('folder');
    expect(classifyOpenFailure(io(NOT_REGULAR_MESSAGE))).toBe('notRegular');
    expect(classifyOpenFailure(io(UNDECODABLE_MESSAGE))).toBe('undecodable');
    expect(classifyOpenFailure(io('磁盘已满'))).toBe('other');
    // a raw NativeFileError (the 打开… panel's rejection is not mapped by toOpenError)
    expect(classifyOpenFailure({ code: 'EIO', message: UNDECODABLE_MESSAGE })).toBe('undecodable');
    expect(classifyOpenFailure({ code: 'ENOENT', message: 'x' })).toBe('missing');
  });

  it('names the file and says what happened in plain zh-CN; no re-authorising on the desktop', () => {
    const d = { name: 'note.md', desktop: true };
    expect(openFailureText(shell('ENOENT'), d)).toBe('无法打开「note.md」：找不到这个文件，它可能已被移动、重命名或删除');
    expect(openFailureText(shell('EACCES'), d)).toBe('无法打开「note.md」：没有读取这个文件的权限');
    // EPERM (macOS privacy protection, TCC): the shell's message carries 隐私与安全性 (integrator, fixer-F request)
    expect(openFailureText(shell('EPERM'), d)).toBe('无法打开「note.md」：没有读取这个文件的权限（macOS「隐私与安全性」设置不允许 MDReader 访问这个位置）');
    expect(openFailureText(shell('EISDIR'), d)).toBe('无法打开「note.md」：这是一个文件夹，不是文件');
    expect(openFailureText(io(NOT_REGULAR_MESSAGE), d)).toBe('无法打开「note.md」：这不是普通文件（可能是管道、套接字或设备）');
    expect(openFailureText(io(UNDECODABLE_MESSAGE), d)).toBe('无法打开「note.md」：无法识别它的文本编码，它可能不是文本文件');
    expect(openFailureText({ code: 'EIO', message: '[object Object]' }, { name: '', desktop: true })).toBe('无法打开该文件：[object Object]');
    for (const e of [shell('EACCES'), shell('EPERM')]) expect(openFailureText(e, d)).not.toContain('授权');
    // Ready for a shell that tells a privacy (TCC) refusal apart: EACCES + a message naming 隐私与安全性.
    expect(openFailureText(toOpenError({ code: 'EACCES', message: '没有访问该文件的权限（被系统的隐私与安全性设置拒绝）' }), d))
      .toBe('无法打开「note.md」：没有读取这个文件的权限（macOS「隐私与安全性」设置不允许 MDReader 访问这个位置）');
    // The web build's File System Access permission really can be re-granted.
    expect(openFailureText(new DOMException('x', 'NotAllowedError'), { name: 'w.md', desktop: false })).toBe(`无法打开「w.md」：${T.needReauth}`);
  });

  // G33: the web 打开… panel itself refused (already open / no user activation): not a file's permission.
  it('a rejected web 打开… panel says what is true, in zh-CN, without 需要重新授权', () => {
    const busy = openFailureText(new DOMException('File picker already active.', 'NotAllowedError'), { name: '', desktop: false, picker: true });
    const gesture = openFailureText(new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError'), { name: '', desktop: false, picker: true });
    expect(busy).toBe('无法打开文件选择窗口：浏览器拒绝了这次请求（可能已有一个文件选择窗口打开着），请关闭它后再试');
    expect(gesture).toBe('无法打开文件选择窗口：浏览器只在点击或按键之后才允许打开它，请再点一次「打开」');
    for (const t of [busy, gesture]) expect(t).not.toContain(T.needReauth);
    // On the desktop the 打开… flow reads the picked file: EACCES there is the file's permission.
    expect(openFailureText(shell('EACCES'), { name: '', desktop: true, picker: true })).toBe('无法打开该文件：没有读取这个文件的权限');
    // A picker that failed for another reason keeps the real message.
    expect(openFailureText(new DOMException('boom', 'AbortError'), { name: '', desktop: false, picker: true })).toBe('无法打开该文件：boom');
  });

  // G34: the opener reports a failure under the path it was asked for.
  it('createNativeOpener reports a failure through fail(path, spec) when App provides it', async () => {
    const toast = vi.fn();
    const fail = vi.fn();
    const run = createNativeOpener({
      confirmDiscard: async () => true,
      readPath: async () => { throw new DOMException('gone', 'NotFoundError'); },
      load: async () => {},
      forgetRecent: async () => false,
      toast,
      fail,
    });
    await run('/docs/missing-0.md');
    expect(toast).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0]).toBe('/docs/missing-0.md');
    expect((fail.mock.calls[0][1] as ToastSpec).text).toContain('missing-0.md');
  });
});

// ------------------------------------------------------------------------------- App level (R1–R3)
// createApp with the preview, scroll sync, the worker and the stores replaced by fakes (the same seams
// as test/app.previewEdit.test.ts); App's guard, open, draft and close flows run for real.

const hoisted = vi.hoisted(() => ({
  log: [] as string[],
  drafts: new Map<string, { docId: string; version: number; text: string; at: number }>(),
  dropFile: null as null | { docId: string; name: string; text: string; lastModified: number; source: 'legacy' },
  dropError: null as unknown,
  open: null as null | (() => Promise<OpenedFile | null>),
}));

vi.mock('../src/preview/createPreview', () => ({
  createPreview: (o: { parent: HTMLElement }) => {
    const el = document.createElement('div');
    el.className = 'mdr-preview';
    o.parent.appendChild(el);
    return {
      el,
      applyStructure() {}, applyStructureDelta() {}, applyHtml() {}, applyOutline() {},
      blockCount: () => 1,
      blockAtLine: (line: number) => ({ index: 0, id: 1, startLine: line, lineCount: 1, kind: 0 as const }),
      blockOfElement: () => null,
      elementOfBlock: () => null,
      setPreviewEditable() {}, isPreviewEditable: () => false, endEditSession() {}, flushEditSession() {},
      lineToScrollTop: () => 0,
      scrollTopToLine: () => ({ line: 1, fraction: 0 }),
      topVisible: () => ({ line: 1, fraction: 0 }),
      isLineVisible: () => true,
      scrollToLine() {}, onScroll: () => () => {}, setFocusLine() {}, setVisible() {},
      mountAll: async () => {},
      dispose() {},
    };
  },
}));
vi.mock('../src/preview/scrollSync', () => ({
  createScrollSync: () => ({ setEnabled() {}, syncNow() {}, dispose() {} }),
}));
vi.mock('../src/app/workerClient', () => ({
  createWorkerClient: () => ({
    setDoc(docId: string) { hoisted.log.push(`worker.setDoc:${docId}`); },
    edit() {}, viewport() {}, need() {}, setOptions() {},
    draft(action: string) { hoisted.log.push(`worker.draft:${action}`); },
    exportHtml: async () => '', resync() {}, dispose() {},
  }),
}));
vi.mock('../src/files/drafts', () => ({
  createDraftStore: () => ({
    get: async (id: string) => {
      hoisted.log.push(`drafts.get:${id}`);
      return hoisted.drafts.get(id);
    },
    del: async (id: string) => {
      hoisted.log.push(`drafts.del:${id}`);
      hoisted.drafts.delete(id);
    },
  }),
}));
vi.mock('../src/files/recent', () => ({
  createRecentStore: () => ({
    list: async () => [], push: async () => {}, remove: async () => {},
    findByHandle: async () => undefined, findByPath: async () => undefined,
  }),
}));
vi.mock('../src/files/fileService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/fileService')>();
  return {
    ...orig,
    createFileService: () => ({
      canSaveInPlace: true,
      newFile: () => ({ docId: orig.UNTITLED_ID, name: '未命名.md', text: '', lastModified: 0, source: 'new' as const }),
      open: () => (hoisted.open ? hoisted.open() : Promise.resolve(null)),
      openHandle: async () => { throw new Error('unused'); },
      fromDrop: async () => {
        if (hoisted.dropError) throw hoisted.dropError;
        return hoisted.dropFile;
      },
      save: async (file: OpenedFile, text: string): Promise<SaveResult> => ({ ok: true, savedAt: Date.now(), file: { ...file, text } }),
      saveAs: async (text: string, name: string): Promise<SaveResult> =>
        ({ ok: true, savedAt: Date.now(), file: { docId: 'x', name, text, lastModified: 0, source: 'fsa' } }),
    }),
  };
});

describe('App guard flows (R1–R3, App level)', () => {
  type App = Awaited<ReturnType<typeof import('../src/app/App').createApp>>;
  let root: HTMLElement;
  let app: App | null = null;
  let bridge: Fake | null = null;
  const files = new Map<string, string>();

  const start = async (desktop: boolean): Promise<App> => {
    localStorage.clear();
    root = document.createElement('div');
    document.body.appendChild(root);
    if (desktop) {
      bridge = fakeBridge();
      bridge.readFile = async (p: string) => {
        const text = files.get(p);
        if (text === undefined) throw { code: 'ENOENT', message: '文件不存在或已被移动' };
        if (text === '<dir>') throw { code: 'EISDIR', message: '这是一个文件夹，不是文件' };
        return { path: p, name: p.split('/').pop()!, text, lastModified: 1 };
      };
      window.mdrNative = bridge;
    }
    const { createApp } = await import('../src/app/App');
    app = await createApp(root);
    await settle();
    return app;
  };
  const overlay = (): HTMLElement => root.querySelector<HTMLElement>('.mdr-overlay') ?? root;
  const type = (a: App, text: string): void => {
    a.editor.view.dispatch({ changes: { from: a.editor.view.state.doc.length, insert: text } });
  };
  const toastTexts = (): string[] => Array.from(root.querySelectorAll('.mdr-toast__text')).map((e) => e.textContent ?? '');
  const click = (label: string): void => {
    const b = dialogButton(root, label);
    if (!b) throw new Error(`no dialog button ${label}; dialogs: ${dialogs(root)} ${dialogText(root)}`);
    b.click();
  };

  beforeEach(() => {
    document.body.replaceChildren();
    hoisted.log.length = 0;
    hoisted.drafts.clear();
    hoisted.dropFile = null;
    hoisted.dropError = null;
    hoisted.open = null;
    files.clear();
    files.set('/docs/a.md', '# A\n\nalpha');
    files.set('/docs/b.md', '# B\n\nbeta');
    files.set('/docs/folder.md', '<dir>');
  });
  afterEach(() => {
    app?.dispose();
    app = null;
    root?.remove();
    delete window.mdrNative;
    bridge = null;
  });

  it('F1: a document double-clicked while 新建 asks 取消 / 丢弃 is opened after 丢弃 (was: silently dropped)', async () => {
    const a = await start(true);
    type(a, 'typed text');
    a.registry.run('file.new');
    await settle();
    expect(dialogs(root)).toBe(1);
    bridge!.emitOpen('/docs/a.md');
    await settle();
    expect(dialogs(root)).toBe(1); // never two questions
    click(T.discard);
    await settle(20);
    expect(a.getText()).toBe('# A\n\nalpha');
    expect(dialogs(root)).toBe(0); // the fresh untitled document needed no second question
  });

  it('F1: 取消 on 新建 keeps the text; the waiting document then asks its own question', async () => {
    const a = await start(true);
    type(a, 'keep me');
    a.registry.run('file.new');
    await settle();
    bridge!.emitOpen('/docs/a.md');
    await settle();
    click('取消');
    await settle(20);
    expect(a.getText()).toBe('keep me');
    expect(dialogs(root)).toBe(1);
    expect(dialogText(root)).toBe(T.discardChanges);
    click(T.discard);
    await settle(20);
    expect(a.getText()).toBe('# A\n\nalpha');
  });

  it('F1 (web): a file dropped while the question is up is opened after 丢弃 (was: dropped)', async () => {
    const a = await start(false);
    type(a, 'web text');
    a.registry.run('file.new');
    await settle();
    hoisted.dropFile = { docId: 'legacy:b.md', name: 'b.md', text: 'dropped B', lastModified: 1, source: 'legacy' };
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    const file = { name: 'b.md', type: 'text/markdown' };
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [file], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => file }] },
    });
    root.dispatchEvent(ev);
    await settle();
    expect(dialogs(root)).toBe(1);
    click(T.discard);
    await settle(20);
    expect(a.getText()).toBe('dropped B');
    expect(dialogs(root)).toBe(0);
  });

  it('F1: an 打开… panel left open does not hold back a document the OS sends meanwhile', async () => {
    const a = await start(true);
    hoisted.open = () => new Promise<OpenedFile | null>(() => {}); // the panel never closes
    a.registry.run('file.open');
    await settle();
    bridge!.emitOpen('/docs/a.md');
    await settle(20);
    expect(a.getText()).toBe('# A\n\nalpha');
  });

  it('打开… on a dirty document: 丢弃, pick, load — one question; asked again only if the document changed', async () => {
    const a = await start(true);
    type(a, 'dirty');
    let pick: ((f: OpenedFile | null) => void) | null = null;
    hoisted.open = () => new Promise<OpenedFile | null>((r) => (pick = r));
    a.registry.run('file.open');
    await settle();
    click(T.discard);
    await settle();
    pick!({ docId: 'native:/docs/p.md', name: 'p.md', text: 'picked', path: '/docs/p.md', lastModified: 1, source: 'native' });
    await settle(20);
    expect(a.getText()).toBe('picked');
    expect(dialogs(root)).toBe(0);
    // Changed while the panel was up (a document arrived and was edited): ask before replacing it.
    type(a, ' more');
    a.registry.run('file.open');
    await settle();
    click(T.discard);
    await settle();
    bridge!.emitOpen('/docs/b.md');
    await settle();
    // Still the same dirty document: the OS document asks its own question (that 丢弃 was for 打开…).
    expect(dialogText(root)).toBe(T.discardChanges);
    click(T.discard);
    await settle(20);
    expect(a.getText()).toBe('# B\n\nbeta');
    type(a, '!');
    pick!({ docId: 'native:/docs/q.md', name: 'q.md', text: 'q', path: '/docs/q.md', lastModified: 1, source: 'native' });
    await settle();
    expect(dialogText(root)).toBe(T.discardChanges);
    click('取消');
    await settle(20);
    expect(a.getText()).toBe('# B\n\nbeta!');
  });

  it('F2: a close request during the discard question waits for it; 丢弃 answers the shell once, no second modal', async () => {
    const a = await start(true);
    type(a, 'dirty');
    bridge!.emitOpen('/docs/a.md');
    await settle();
    bridge!.emitCommand(CLOSE_REQUESTED);
    await settle();
    expect(dialogs(root)).toBe(1);
    expect(dialogText(root)).toBe(T.discardChanges);
    click(T.discard);
    await settle(20);
    expect(dialogs(root)).toBe(0);
    expect(bridge!.closes).toEqual(['discard']);
    expect(a.getText()).toBe('# A\n\nalpha');
  });

  it('F2: 取消 on the discard question → the close question follows alone; 取消 → cancel, text kept', async () => {
    const a = await start(true);
    type(a, 'dirty');
    bridge!.emitOpen('/docs/a.md');
    await settle();
    bridge!.emitCommand(CLOSE_REQUESTED);
    await settle();
    expect(dialogs(root)).toBe(1); // was: 不保存 / 取消 / 保存 stacked on 取消 / 丢弃
    expect(dialogText(root)).toBe(T.discardChanges);
    click('取消');
    await settle(20);
    expect(dialogs(root)).toBe(1);
    expect(dialogText(root)).toBe(NATIVE_T.closeDirty('未命名.md'));
    click(NATIVE_T.cancel);
    await settle(20);
    expect(bridge!.closes).toEqual(['cancel']);
    expect(a.getText()).toBe('dirty');
    expect(dialogs(root)).toBe(0);
  });

  it('F2: 新建 from the menu while the close question is up waits behind it', async () => {
    const a = await start(true);
    type(a, 'dirty');
    bridge!.emitCommand(CLOSE_REQUESTED);
    await settle();
    bridge!.emitCommand('file.new');
    await settle();
    expect(dialogs(root)).toBe(1);
    expect(dialogText(root)).toBe(NATIVE_T.closeDirty('未命名.md'));
    click(NATIVE_T.cancel);
    await settle(20);
    expect(bridge!.closes).toEqual(['cancel']);
    expect(dialogText(root)).toBe(T.discardChanges);
    click('取消');
    await settle(20);
    expect(a.getText()).toBe('dirty');
  });

  it('F3: 新建 → 丢弃 deletes the untitled draft before the new untitled document looks for one', async () => {
    const a = await start(true);
    await new Promise((r) => setTimeout(r, 450)); // past the launch window (LAUNCH_SETTLE_MS)
    type(a, 'thrown away');
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 2, text: 'thrown away', at: Date.now() });
    hoisted.log.length = 0;
    a.registry.run('file.new');
    await settle();
    click(T.discard);
    await settle(20);
    expect(toastTexts().filter((t) => t.includes(T.draftFound))).toEqual([]); // was: 发现未保存的草稿
    expect(hoisted.drafts.has('untitled')).toBe(false);
    const log = hoisted.log;
    expect(log.indexOf('worker.draft:clear')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('worker.draft:clear')).toBeLessThan(log.indexOf('worker.setDoc:untitled'));
    // R4: the discard first reads the record to check it is this tab's; the NEW document's lookup is the last read.
    expect(log.indexOf('drafts.del:untitled')).toBeLessThan(log.lastIndexOf('drafts.get:untitled'));
  });

  it('F3: 不保存 on the close question deletes the draft and stops draft writes before answering', async () => {
    const a = await start(true);
    type(a, 'bye');
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 2, text: 'bye', at: Date.now() });
    hoisted.log.length = 0;
    bridge!.emitCommand(CLOSE_REQUESTED);
    await settle();
    click(NATIVE_T.dontSave);
    await settle(20);
    expect(bridge!.closes).toEqual(['discard']);
    expect(hoisted.drafts.has('untitled')).toBe(false);
    expect(hoisted.log).toContain('worker.draft:disable');
    // The page going hidden as the window closes must not write it again.
    document.dispatchEvent(new Event('visibilitychange'));
    // If the window survives after all, the next edit re-enables drafts.
    type(a, '!');
    expect(hoisted.log.slice(-1)[0]).toBe('worker.draft:enable');
  });

  it('F3: drafts of documents the user did NOT discard survive (clean switch, 取消, cancelled close)', async () => {
    const a = await start(true);
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 1, text: 'crash text', at: Date.now() });
    bridge!.emitOpen('/docs/a.md'); // clean scratch buffer → no question, nothing discarded
    await settle(20);
    expect(a.getText()).toBe('# A\n\nalpha');
    hoisted.drafts.set('native:/docs/a.md', { docId: 'native:/docs/a.md', version: 3, text: 'A edited', at: Date.now() });
    type(a, ' edited');
    bridge!.emitOpen('/docs/b.md');
    await settle();
    click('取消');
    await settle(20);
    bridge!.emitCommand(CLOSE_REQUESTED);
    await settle();
    click(NATIVE_T.cancel);
    await settle(20);
    expect(hoisted.drafts.has('untitled')).toBe(true);
    expect(hoisted.drafts.has('native:/docs/a.md')).toBe(true);
    expect(hoisted.log.filter((l) => l.startsWith('drafts.del'))).toEqual([]);
  });

  it('F4: a failed open keeps the current document and shows a message that names the file and stays', async () => {
    const a = await start(true);
    type(a, 'mine');
    bridge!.emitOpen('/docs/gone.md');
    await settle();
    click(T.discard);
    await settle(20);
    expect(a.getText()).toBe('mine'); // it simply stays
    expect(toastTexts()).toContain('无法打开「gone.md」：找不到这个文件，它可能已被移动、重命名或删除');
    bridge!.emitOpen('/docs/folder.md');
    await settle();
    click(T.discard);
    await settle(20);
    expect(toastTexts()).toContain('无法打开「folder.md」：这是一个文件夹，不是文件');
    expect(toastTexts().join('\n')).not.toContain('授权');
    expect(a.getText()).toBe('mine');
  });
  // Check item 7: the shell's close guard reads ITS copy of the dirty flag; it must not lag a frame behind.
  it('an editor change reports dirty to the shell at once, before any frame', async () => {
    const a = await start(true);
    await a.loadText('clean', 'c.md');
    await settle();
    const n = bridge!.states.length;
    type(a, 'x');
    expect(bridge!.states.slice(n).map((s) => s.dirty)).toEqual([true]);
  });

  it('input in a preview session reports dirty to the shell at once; the session end without a write clears it', async () => {
    const a = await start(true);
    await a.loadText('clean', 'c.md');
    await settle();
    const host = document.createElement('section');
    host.setAttribute('contenteditable', 'true');
    root.querySelector('.mdr-preview')!.appendChild(host);
    a.bus.emit('previewEdit:session', { id: 1 });
    const n = bridge!.states.length;
    host.dispatchEvent(new Event('input', { bubbles: true }));
    expect(bridge!.states.slice(n).map((s) => s.dirty)).toEqual([true]);
    // A checkbox or the link input (not contenteditable) does not count.
    a.bus.emit('previewEdit:session', { id: null });
    await settle();
    expect(bridge!.states.at(-1)!.dirty).toBe(false);
    const box = document.createElement('input');
    box.type = 'checkbox';
    root.querySelector('.mdr-preview')!.appendChild(box);
    const m = bridge!.states.length;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(bridge!.states.length).toBe(m);
  });

  // G34: one failure toast per path; a successful open of that path removes it.
  it('a failed open of a path is replaced by its next failure and removed when the path opens', async () => {
    const a = await start(true);
    bridge!.emitOpen('/docs/gone.md');
    await settle(20);
    bridge!.emitOpen('/docs/gone.md');
    await settle(20);
    expect(toastTexts().filter((t) => t.includes('gone.md'))).toHaveLength(1);
    files.set('/docs/gone.md', '# back');
    bridge!.emitOpen('/docs/gone.md');
    await settle(20);
    expect(a.getText()).toBe('# back');
    expect(toastTexts().filter((t) => t.includes('gone.md'))).toEqual([]);
  });

  // G31: a dropped file the shell refused is reported with its reason; no discard question, the document stays.
  it('a refused drop shows the reason and keeps the dirty document without asking', async () => {
    const a = await start(true);
    type(a, 'mine');
    hoisted.dropError = Object.assign(new Error('无法识别该文件的文本编码（可能是二进制文件）'), { code: 'EIO' });
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    const file = { name: 'bin.md', type: 'text/markdown' };
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [file], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => file }] },
    });
    root.dispatchEvent(ev);
    await settle(20);
    expect(dialogs(root)).toBe(0);
    expect(a.getText()).toBe('mine');
    expect(toastTexts()).toContain('无法打开「bin.md」：无法识别它的文本编码，它可能不是文本文件');
  });

  // U17 (H2, fix round 3): a drop carrying files is cancelled in the window's capture phase, before any
  // element (CodeMirror's content DOM included) sees it; a text drag reaches the element untouched.
  const dragEvent = (type: string, dt: Record<string, unknown>): Event => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    return ev;
  };
  it('U17: a file drop on the editor never reaches CodeMirror and opens the file; a text drop does', async () => {
    const a = await start(false);
    type(a, 'mine');
    const content = root.querySelector<HTMLElement>('.cm-content')!;
    const seen: Array<{ type: string; prevented: boolean }> = [];
    const spy = (e: Event): void => { seen.push({ type: e.type, prevented: e.defaultPrevented }); };
    content.addEventListener('dragover', spy);
    content.addEventListener('drop', spy);
    hoisted.dropFile = { docId: 'legacy:b.md', name: 'b.md', text: 'dropped B', lastModified: 1, source: 'legacy' };
    const file = { name: 'b.md', type: 'text/markdown' };
    const files = { types: ['Files'], files: [file], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => file }], dropEffect: 'none' };
    const over = dragEvent('dragover', files);
    content.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true); // the drop is allowed
    const drop = dragEvent('drop', files);
    content.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(seen.filter((x) => x.type === 'drop')).toEqual([]); // CodeMirror's file drop never ran
    expect(a.getText()).toBe('mine'); // nothing inserted, synchronously or later
    await settle();
    expect(a.getText()).toBe('mine');
    expect(dialogs(root)).toBe(1); // dirty: G31's order, the question after the read
    click(T.discard);
    await settle(20);
    expect(a.getText()).toBe('dropped B');
    // A text drag is not a file drop: it reaches the element, not cancelled.
    seen.length = 0;
    const text = { types: ['text/plain'], files: [], items: [{ kind: 'string', type: 'text/plain' }], getData: () => '', dropEffect: 'none' };
    content.dispatchEvent(dragEvent('dragover', text));
    content.dispatchEvent(dragEvent('drop', text));
    expect(seen).toEqual([{ type: 'dragover', prevented: false }, { type: 'drop', prevented: false }]);
    content.removeEventListener('dragover', spy);
    content.removeEventListener('drop', spy);
  });
  it('U17: a file dropped outside the app root (on the body) is still the app\'s', async () => {
    const a = await start(false);
    hoisted.dropFile = { docId: 'legacy:c.md', name: 'c.md', text: 'dropped C', lastModified: 1, source: 'legacy' };
    const file = { name: 'c.md', type: 'text/markdown' };
    const drop = dragEvent('drop', { types: ['Files'], files: [file], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => file }] });
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await settle(20);
    expect(a.getText()).toBe('dropped C');
  });

  // R5 (H5, fix round 3): with a recovery offer unanswered, text taken back to the loaded text pauses the
  // worker's draft writes (the offered record stays) and deletes only this tab's own write; other text resumes.
  it('R5: typing taken back under an unanswered offer keeps the offered draft; 丢弃 ends the rule', async () => {
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 7, text: 'crash text', at: Date.now() + 3_600_000 });
    const a = await start(false);
    await settle();
    expect(toastTexts().filter((t) => t.includes(T.draftFound)).length).toBe(1);
    hoisted.log.length = 0;
    const view = a.editor.view;
    type(a, 'x');
    expect(hoisted.log.filter((l) => l.startsWith('worker.draft:'))).toEqual([]);
    view.dispatch({ changes: { from: 0, to: 1 } }); // back to the loaded text ('')
    expect(hoisted.log.filter((l) => l.startsWith('worker.draft:'))).toEqual(['worker.draft:clear', 'worker.draft:disable']);
    type(a, 'abc');
    expect(hoisted.log.filter((l) => l.startsWith('worker.draft:')).slice(-1)).toEqual(['worker.draft:enable']);
    hoisted.log.length = 0;
    view.dispatch({ changes: { from: 0, to: 3 } });
    expect(hoisted.log).toEqual(['worker.draft:clear', 'worker.draft:disable']);
    await settle();
    expect(hoisted.drafts.get('untitled')?.text).toBe('crash text'); // App deleted nothing either
    // 丢弃 answers the offer: R4 as before (no pause on the next round trip).
    const discard = Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-toast__btn')).find((b) => b.textContent === T.discard)!;
    hoisted.log.length = 0;
    discard.click();
    await settle();
    expect(hoisted.log).toContain('worker.draft:enable');
    expect(hoisted.drafts.has('untitled')).toBe(false);
    hoisted.log.length = 0;
    type(a, 'z');
    view.dispatch({ changes: { from: 0, to: 1 } });
    expect(hoisted.log.filter((l) => l.startsWith('worker.draft:'))).toEqual([]);
  });
  it('R5: a save under an unanswered offer moves the guard to the saved text; a new docId ends it', async () => {
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 7, text: 'crash text', at: Date.now() + 3_600_000 });
    const a = await start(false);
    await settle();
    type(a, 'kept');
    a.registry.run('file.save'); // the fake save keeps the docId
    await settle(20);
    hoisted.log.length = 0;
    const view = a.editor.view;
    view.dispatch({ changes: { from: 0, to: 4 } }); // back to the LOADED text, which is no longer on disk
    expect(hoisted.log.filter((l) => l.startsWith('worker.draft:'))).toEqual([]); // its draft is written
    type(a, 'kept'); // the saved text again: no draft needed, the offered one stays
    expect(hoisted.log.filter((l) => l.startsWith('worker.draft:'))).toEqual(['worker.draft:clear', 'worker.draft:disable']);
    a.registry.run('file.saveAs'); // docId 'x': the offer belongs to the old document
    await settle(20);
    expect(hoisted.log).toContain('worker.draft:enable');
    hoisted.log.length = 0;
    type(a, '!');
    view.dispatch({ changes: { from: 4, to: 5 } });
    expect(hoisted.log.filter((l) => l === 'worker.draft:disable')).toEqual([]);
  });
});
