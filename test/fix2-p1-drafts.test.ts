// @vitest-environment jsdom
// fix-flows-1 (0.2.0 stage 2b, decision R4): drafts are written only for changed text, deleted only by
// the tab that wrote them, offered once, and restored with a question (when the document changed since
// the offer) as one undoable step. Unit level: src/files/drafts.ts, src/worker/draft.ts; App level:
// createApp with the preview, scroll sync, worker and stores replaced by fakes (the seams of
// test/native.wiring.test.ts), App's own draft flows running for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import type { OpenedFile, SaveResult } from '../src/shared/types';
import { T } from '../src/shared/i18n';
import { installLayoutStubs } from './editor.helpers';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

installLayoutStubs();

const hoisted = vi.hoisted(() => ({
  log: [] as string[],
  /** The App-level store (createDraftStore is mocked). */
  drafts: new Map<string, { docId: string; version: number; text: string; at: number }>(),
  /** The idb-keyval level store (for delDraftIfMine / createDraftSaver). */
  idb: new Map<string, unknown>(),
  onDraftSaved: null as null | ((docId: string, version: number, at: number) => void),
  saveGate: null as null | Promise<void>,
}));

// ---- idb-keyval: an in-memory store with the transaction shape delDraftIfMine uses.
vi.mock('idb-keyval', () => {
  const request = <R>(fn: () => R) => {
    const req: { result?: R; onsuccess?: () => void; onerror?: () => void; error?: unknown } = {};
    queueMicrotask(() => { req.result = fn(); req.onsuccess?.(); });
    return req;
  };
  return {
    set: async (k: string, v: unknown) => { hoisted.idb.set(k, v); },
    get: async (k: string) => hoisted.idb.get(k),
    del: async (k: string) => { hoisted.idb.delete(k); },
    promisifyRequest: (r: { oncomplete?: () => void; onsuccess?: () => void }) =>
      new Promise((res) => { r.oncomplete = r.onsuccess = () => res(undefined); queueMicrotask(() => r.oncomplete?.()); }),
    createStore: () => async (_mode: string, cb: (s: unknown) => unknown) => {
      const store = {
        transaction: {} as Record<string, unknown>,
        get: (k: string) => request(() => hoisted.idb.get(k)),
        delete: (k: string) => { hoisted.idb.delete(k); },
      };
      return cb(store);
    },
  };
});

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
  createWorkerClient: (h: { onDraftSaved(docId: string, version: number, at: number): void }) => {
    hoisted.onDraftSaved = (d, v, at) => h.onDraftSaved(d, v, at);
    return {
      setDoc(docId: string) { hoisted.log.push(`worker.setDoc:${docId}`); },
      edit() {}, viewport() {}, need() {}, setOptions() {},
      draft(action: string) { hoisted.log.push(`worker.draft:${action}`); },
      exportHtml: async () => '', resync() {}, dispose() {},
    };
  },
}));
vi.mock('../src/files/drafts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/drafts')>();
  return {
    ...orig,
    createDraftStore: () => ({
      get: async (id: string) => { hoisted.log.push(`drafts.get:${id}`); return hoisted.drafts.get(id); },
      del: async (id: string) => { hoisted.log.push(`drafts.del:${id}`); hoisted.drafts.delete(id); },
    }),
  };
});
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
      open: async () => null,
      openHandle: async () => { throw new Error('unused'); },
      fromDrop: async () => null,
      save: async (file: OpenedFile, text: string): Promise<SaveResult> => {
        if (hoisted.saveGate) await hoisted.saveGate;
        return { ok: true, savedAt: Date.now(), file: { ...file, text } };
      },
      saveAs: async (text: string, name: string): Promise<SaveResult> =>
        ({ ok: true, savedAt: Date.now(), file: { docId: 'x', name, text, lastModified: 0, source: 'fsa' } }),
    }),
  };
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

// ------------------------------------------------------------------ unit: delDraftIfMine / createDraftSaver
describe('delDraftIfMine / createDraftSaver (R4, G30)', () => {
  beforeEach(() => {
    hoisted.idb.clear();
    (globalThis as { indexedDB?: unknown }).indexedDB = {};
  });
  afterEach(() => { delete (globalThis as { indexedDB?: unknown }).indexedDB; });

  it('deletes the record only while it is the stamped write', async () => {
    const { delDraftIfMine } = await import('../src/files/drafts');
    hoisted.idb.set('mdr.draft:untitled', { docId: 'untitled', version: 3, text: 'other tab', at: 200 });
    expect(await delDraftIfMine('untitled', { docId: 'untitled', version: 3, at: 100 })).toBe(false);
    expect(await delDraftIfMine('untitled', null)).toBe(false);
    expect(hoisted.idb.has('mdr.draft:untitled')).toBe(true);
    expect(await delDraftIfMine('untitled', { docId: 'untitled', version: 3, at: 200 })).toBe(true);
    expect(hoisted.idb.has('mdr.draft:untitled')).toBe(false);
  });

  it('the worker saver clears its own write, not a record another tab wrote over it', async () => {
    const { createDraftSaver } = await import('../src/worker/draft');
    let rec = { docId: 'untitled', version: 1, text: 'tab one', at: 10 };
    const saved: number[] = [];
    const s = createDraftSaver(() => rec, (_d, v) => saved.push(v));
    s.enable();
    s.flush();
    await settle();
    expect(saved).toEqual([1]);
    // another tab writes the same key
    hoisted.idb.set('mdr.draft:untitled', { docId: 'untitled', version: 1, text: 'tab two', at: 11 });
    s.clear();
    await settle();
    expect((hoisted.idb.get('mdr.draft:untitled') as { text: string }).text).toBe('tab two');
    // its own latest write goes
    rec = { docId: 'untitled', version: 2, text: 'tab one again', at: 12 };
    s.flush();
    await settle();
    s.clear();
    await settle();
    expect(hoisted.idb.has('mdr.draft:untitled')).toBe(false);
  });
});

// ------------------------------------------------------------------ App level
describe('App draft flows (R4)', () => {
  type App = Awaited<ReturnType<typeof import('../src/app/App').createApp>>;
  let root: HTMLElement;
  let app: App | null = null;

  const start = async (): Promise<App> => {
    localStorage.clear();
    root = document.createElement('div');
    document.body.appendChild(root);
    const { createApp } = await import('../src/app/App');
    app = await createApp(root);
    await settle();
    return app;
  };
  const type = (a: App, text: string): void => {
    a.editor.view.dispatch({ changes: { from: a.editor.view.state.doc.length, insert: text }, userEvent: 'input.type' });
  };
  const offers = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('.mdr-toast')).filter((t) => t.textContent?.includes(T.draftFound));
  const toastBtn = (label: string): HTMLButtonElement =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-toast__btn')).find((b) => b.textContent === label)!;
  const dialogBtn = (label: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-dialog__btn')).find((b) => b.textContent === label);
  const dialogCount = (): number => root.querySelectorAll('.mdr-dialog').length;
  const hide = (): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as { visibilityState?: unknown }).visibilityState;
  };
  const crashDraft = () => ({ docId: 'untitled', version: 4, text: 'old crash text', at: Date.now() });

  beforeEach(() => {
    document.body.replaceChildren();
    hoisted.log.length = 0;
    hoisted.drafts.clear();
    hoisted.saveGate = null;
  });
  afterEach(() => {
    app?.dispose();
    app = null;
    root?.remove();
  });

  it('G28: hiding the tab with an unanswered offer writes no draft; after an edit it does', async () => {
    hoisted.drafts.set('untitled', crashDraft());
    const a = await start();
    expect(offers()).toHaveLength(1);
    hoisted.log.length = 0;
    hide();
    expect(hoisted.log).not.toContain('worker.draft:flush');
    type(a, 'x');
    hide();
    expect(hoisted.log).toContain('worker.draft:flush');
  });

  it('G36: 新建 twice on the clean untitled document keeps ONE offer', async () => {
    hoisted.drafts.set('untitled', crashDraft());
    const a = await start();
    a.registry.run('file.new');
    await settle();
    a.registry.run('file.new');
    await settle();
    expect(offers()).toHaveLength(1);
  });

  it('G30: 丢弃 deletes the draft this tab wrote, not one another tab wrote over it', async () => {
    const a = await start();
    type(a, 'tab one text');
    // this tab's worker wrote version v ...
    hoisted.drafts.set('untitled', { docId: 'untitled', version: a.editor.version, text: 'tab one text', at: 500 });
    hoisted.onDraftSaved!('untitled', a.editor.version, 500);
    // ... then another tab overwrote the shared key
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 9, text: 'tab two text', at: 600 });
    a.registry.run('file.new');
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    expect(hoisted.drafts.get('untitled')?.text).toBe('tab two text');
  });

  it('G30: 丢弃 still deletes this tab’s own confirmed draft', async () => {
    const a = await start();
    type(a, 'mine, then more');
    hoisted.drafts.set('untitled', { docId: 'untitled', version: 1, text: 'mine', at: 500 });
    hoisted.onDraftSaved!('untitled', 1, 500);
    a.registry.run('file.new');
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    expect(hoisted.drafts.has('untitled')).toBe(false);
  });

  it('G29: 恢复 after typing asks first; 恢复 replaces as one undoable step', async () => {
    hoisted.drafts.set('untitled', crashDraft());
    const a = await start();
    type(a, 'brand new typing');
    toastBtn(T.restore).click();
    await settle();
    expect(dialogCount()).toBe(1);
    expect(a.getText()).toBe('brand new typing');
    dialogBtn(T.restore)!.click();
    await settle();
    expect(a.getText()).toBe('old crash text');
    undo(a.editor.view);
    expect(a.getText()).toBe('brand new typing');
  });

  it('G29: 取消 keeps the typing and the offer', async () => {
    hoisted.drafts.set('untitled', crashDraft());
    const a = await start();
    type(a, 'brand new typing');
    toastBtn(T.restore).click();
    await settle();
    dialogBtn('取消')!.click();
    await settle();
    expect(a.getText()).toBe('brand new typing');
    expect(offers()).toHaveLength(1);
  });

  it('G29: 恢复 with nothing typed asks nothing and is still undoable', async () => {
    hoisted.drafts.set('untitled', crashDraft());
    const a = await start();
    toastBtn(T.restore).click();
    await settle();
    expect(dialogCount()).toBe(0);
    expect(a.getText()).toBe('old crash text');
    undo(a.editor.view);
    expect(a.getText()).toBe('');
  });

  it('the offer’s 丢弃 deletes only the offered record', async () => {
    hoisted.drafts.set('untitled', crashDraft());
    const a = await start();
    type(a, 'newer');
    hoisted.drafts.set('untitled', { docId: 'untitled', version: a.editor.version, text: 'newer', at: Date.now() + 5 });
    toastBtn(T.discard).click();
    await settle();
    expect(hoisted.drafts.get('untitled')?.text).toBe('newer');
  });

  it('check item: text typed while a save is in flight keeps its draft', async () => {
    const a = await start();
    a.editor.view.dispatch({ changes: { from: 0, insert: 'saved' } });
    let release!: () => void;
    hoisted.saveGate = new Promise<void>((r) => { release = r; });
    hoisted.log.length = 0;
    a.registry.run('file.save');
    await settle();
    type(a, ' and more');
    release();
    await settle(20);
    expect(hoisted.log).not.toContain('worker.draft:clear');
    // a save of the current text clears it
    hoisted.saveGate = null;
    a.registry.run('file.save');
    await settle(20);
    expect(hoisted.log).toContain('worker.draft:clear');
    // and a hide right after that clean save writes nothing
    hoisted.log.length = 0;
    hide();
    expect(hoisted.log).not.toContain('worker.draft:flush');
  });
});
