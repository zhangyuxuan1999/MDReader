// @vitest-environment jsdom
// fix-flows (0.2.0 stage 2e, decision R6, finding J4): a save that completes after another document (or a
// restored draft) replaced the one it saved changes nothing of the open document: not the file it is
// bound to, not the saved version, not the title or dirty mark, not its draft, not its recent entry.
// What it wrote stays; a toast names the saved file; a late failure is reported against the saved file.
// App level, as in test/fix2-p1-drafts.test.ts: preview, scroll sync, worker and stores are fakes. The web
// cases use a fake file service whose save waits on a gate; the desktop cases use the REAL native file
// service over a fake bridge whose writeFile waits on the gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MdrNative } from '../src/shared/native';
import type { OpenedFile, RecentEntry, SaveResult } from '../src/shared/types';
import { T } from '../src/shared/i18n';
import { CLOSE_REQUESTED, NATIVE_T } from '../src/app/native';
import { CONFLICT_MARK } from '../src/files/nativeBackend';
import { installLayoutStubs } from './editor.helpers';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

installLayoutStubs();

const hoisted = vi.hoisted(() => ({
  log: [] as string[],
  drafts: new Map<string, { docId: string; version: number; text: string; at: number }>(),
  /** Every save the fake service received: the file it was asked to write and the text. */
  saves: [] as Array<{ file: OpenedFile; text: string }>,
  saveGate: null as null | Promise<void>,
  saveResult: null as null | ((file: OpenedFile, text: string) => SaveResult),
  open: null as null | OpenedFile,
  dropFile: null as null | OpenedFile,
  dropError: null as unknown,
  recentEntries: [] as RecentEntry[],
  recentPushes: [] as string[],
  handleFile: null as null | OpenedFile,
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
vi.mock('../src/files/drafts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/drafts')>();
  return {
    ...orig,
    createDraftStore: () => ({
      get: async (id: string) => hoisted.drafts.get(id),
      del: async (id: string) => { hoisted.log.push(`drafts.del:${id}`); hoisted.drafts.delete(id); },
    }),
  };
});
vi.mock('../src/files/recent', () => ({
  createRecentStore: () => ({
    list: async () => hoisted.recentEntries,
    push: async (e: RecentEntry) => { hoisted.recentPushes.push(e.path ?? e.name); },
    remove: async () => {},
    findByHandle: async () => undefined, findByPath: async () => undefined,
  }),
}));
vi.mock('../src/files/fileService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/fileService')>();
  return {
    ...orig,
    createFileService: (recent: Parameters<typeof orig.createFileService>[0]) =>
      (window as { mdrNative?: unknown }).mdrNative
        ? orig.createFileService(recent) // desktop: the real native service over the fake bridge
        : {
            canSaveInPlace: true,
            newFile: () => ({ docId: orig.UNTITLED_ID, name: '未命名.md', text: '', lastModified: 0, source: 'new' as const }),
            open: async () => hoisted.open,
            openHandle: async () => hoisted.handleFile!,
            fromDrop: async () => {
              if (hoisted.dropError) throw hoisted.dropError;
              return hoisted.dropFile;
            },
            save: async (file: OpenedFile, text: string): Promise<SaveResult> => {
              hoisted.saves.push({ file, text });
              if (hoisted.saveGate) await hoisted.saveGate;
              if (hoisted.saveResult) return hoisted.saveResult(file, text);
              return { ok: true, savedAt: Date.now(), file: { ...file, text, lastModified: 77 } };
            },
            saveAs: async (text: string, name: string): Promise<SaveResult> => {
              hoisted.saves.push({ file: { docId: '', name, text: '', lastModified: 0, source: 'new' }, text });
              if (hoisted.saveGate) await hoisted.saveGate;
              return { ok: true, savedAt: Date.now(), file: { docId: 'as:' + name, name: 'picked.md', text, lastModified: 0, source: 'fsa' } };
            },
          },
  };
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

type App = Awaited<ReturnType<typeof import('../src/app/App').createApp>>;
let root: HTMLElement;
let app: App | null = null;

const doc = (name: string, text: string, extra: Partial<OpenedFile> = {}): OpenedFile =>
  ({ docId: 'id:' + name, name, text, lastModified: 1, source: 'fsa', handle: {} as FileSystemFileHandle, ...extra });

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
const dialogBtn = (label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-dialog__btn')).find((b) => b.textContent === label);
const toastBtn = (label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-toast__btn')).find((b) => b.textContent === label);
const toastTexts = (): string[] => Array.from(root.querySelectorAll('.mdr-toast__text')).map((e) => e.textContent ?? '');
let release: () => void = () => {};
const gate = (): void => { hoisted.saveGate = new Promise<void>((r) => { release = r; }); };

/** Opens `s.md` through the 打开… flow (the doc is clean), types, and starts a save that waits on the gate. */
const openTypeAndSave = async (a: App): Promise<void> => {
  hoisted.open = doc('s.md', '# S\n');
  a.registry.run('file.open');
  await settle();
  expect(document.title).toBe('s.md');
  type(a, 'typed');
  gate();
  a.registry.run('file.save');
  await settle();
  expect(hoisted.saves).toHaveLength(1);
};
/** After the replacement and the late completion: what the open document looks like. */
const expectUntouched = async (a: App, name: string, text: string, dirty: boolean): Promise<void> => {
  expect(a.getText()).toBe(text);
  await new Promise((r) => setTimeout(r, 60)); // the status refresh runs on the next frame
  expect(document.title).toBe((dirty ? '● ' : '') + name);
  // the next ⌘S writes the open document, bound to ITS file, not to s.md
  hoisted.saveGate = null;
  hoisted.saves.length = 0;
  a.registry.run('file.save');
  await settle(20);
  expect(hoisted.saves).toHaveLength(1);
  expect(hoisted.saves[0].file.name).toBe(name);
  expect(hoisted.saves[0].text).toBe(text);
};

// Round 7, rule R7 (b): a replacement now waits for the document's own save first; these cases are what happens
// once that wait has run out (the question is asked during the save, as before), so the wait is switched off here.
// The wait itself is tested in test/r7-fs-save.test.ts.
let saveWait: { ms: number; gestureMs: number } | null = null;
beforeEach(async () => {
  saveWait = (await import('../src/app/App')).SAVE_WAIT;
  saveWait.ms = 0;
  document.body.replaceChildren();
  hoisted.log.length = 0;
  hoisted.drafts.clear();
  hoisted.saves.length = 0;
  hoisted.saveGate = null;
  hoisted.saveResult = null;
  hoisted.open = null;
  hoisted.dropFile = null;
  hoisted.dropError = null;
  hoisted.recentEntries = [];
  hoisted.recentPushes.length = 0;
  hoisted.handleFile = null;
});
afterEach(() => {
  if (saveWait) saveWait.ms = 10_000;
  release();
  app?.dispose();
  app = null;
  root?.remove();
  delete (window as { mdrNative?: unknown }).mdrNative;
});

describe('R6 (web): a save that completes after the document was replaced', () => {
  it('control: a save with no replacement binds the saved file as before', async () => {
    const a = await start();
    await openTypeAndSave(a);
    release();
    await settle(20);
    expect(document.title).toBe('s.md');
    hoisted.saves.length = 0;
    a.registry.run('file.save');
    await settle(20);
    expect(hoisted.saves[0].file.lastModified).toBe(77); // r.file became the open file
  });

  it('新建 (丢弃) while the save is in flight', async () => {
    const a = await start();
    await openTypeAndSave(a);
    a.registry.run('file.new');
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    hoisted.log.length = 0;
    hoisted.recentPushes.length = 0;
    release();
    await settle(20);
    expect(hoisted.log).toEqual([]); // no worker.setDoc / draft clear / drafts.del for the new document
    expect(hoisted.recentPushes).toEqual([]);
    expect(toastTexts()).toContain(`${T.saved_ok}：s.md`);
    type(a, 'NEW DOC TEXT');
    await expectUntouched(a, '未命名.md', 'NEW DOC TEXT', true);
  });

  it('打开… a clean document right after the save started (no question)', async () => {
    const a = await start();
    hoisted.open = doc('s.md', '# S\n');
    a.registry.run('file.open');
    await settle();
    gate();
    a.registry.run('file.save'); // a habitual ⌘S on the clean document
    await settle();
    hoisted.open = doc('b.md', '# B\n');
    a.registry.run('file.open');
    await settle(20);
    expect(document.title).toBe('b.md');
    release();
    await settle(20);
    expect(document.title).toBe('b.md');
    type(a, 'more');
    await expectUntouched(a, 'b.md', '# B\nmore', true);
  });

  it('a dropped file while the save is in flight', async () => {
    const a = await start();
    await openTypeAndSave(a);
    hoisted.dropFile = doc('drop.md', '# D\n');
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    const f = { name: 'drop.md', type: 'text/markdown' };
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [f], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => f }] },
    });
    root.dispatchEvent(ev);
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    expect(a.getText()).toBe('# D\n');
    release();
    await settle(20);
    // was: '● s.md' over the dropped text, and the next ⌘S wrote it into s.md
    expect(document.title).toBe('drop.md');
    type(a, 'more');
    await expectUntouched(a, 'drop.md', '# D\nmore', true);
  });

  it('a recent entry opened while the save is in flight', async () => {
    const a = await start();
    await openTypeAndSave(a);
    hoisted.recentEntries = [{ docId: 'id:r.md', name: 'r.md', handle: {} as FileSystemFileHandle, openedAt: 1 }];
    hoisted.handleFile = doc('r.md', '# R\n');
    root.querySelector<HTMLElement>('.mdr-toolbar__file')!.click();
    await settle();
    Array.from(root.querySelectorAll<HTMLElement>('.mdr-recent__item')).find((e) => e.textContent === 'r.md')!.click();
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    expect(a.getText()).toBe('# R\n');
    hoisted.recentPushes.length = 0;
    release();
    await settle(20);
    expect(hoisted.recentPushes).toEqual([]);
    expect(document.title).toBe('r.md');
    await expectUntouched(a, 'r.md', '# R\n', false);
  });

  it('a document loaded by name (__mdr.loadText) while the save is in flight', async () => {
    const a = await start();
    await openTypeAndSave(a);
    const p = a.loadText('# L\n', 'l.md');
    await settle(20);
    await p;
    release();
    await settle(20);
    expect(document.title).toBe('l.md');
    await expectUntouched(a, 'l.md', '# L\n', false);
  });

  it('a restored draft while the save is in flight: the saved version and the draft state stay', async () => {
    hoisted.drafts.set('id:s.md', { docId: 'id:s.md', version: 4, text: '# S crash text\n', at: Date.now() + 1000 });
    const a = await start();
    await openTypeAndSave(a); // the offer is on screen; 'typed' is newer work
    toastBtn(T.restore)!.click();
    await settle();
    dialogBtn(T.restore)!.click(); // 恢复 over the typing asks first
    await settle(20);
    expect(a.getText()).toBe('# S crash text\n');
    hoisted.log.length = 0;
    release();
    await settle(20);
    expect(hoisted.log).toEqual([]); // the restored text keeps its draft
    // R4's draft base stays at the restore: hiding the tab writes nothing (was: flushed, the base had
    // been moved back to the version the save started from)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as { visibilityState?: unknown }).visibilityState;
    expect(hoisted.log).not.toContain('worker.draft:flush');
    // was: savedVersion moved to the pre-restore version — still dirty, but the R4 draft base was reset
    expect(document.title).toBe('● s.md');
    await expectUntouched(a, 's.md', '# S crash text\n', true);
  });

  it('a save that FAILS late reports the saved file, not the open document (no 覆盖保存 for it)', async () => {
    const a = await start();
    await openTypeAndSave(a);
    hoisted.saveResult = () => ({ ok: false, reason: 'error', message: `${CONFLICT_MARK}，已拒绝写入` });
    hoisted.open = doc('b.md', '# B\n');
    a.registry.run('file.open');
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    release();
    await settle(20);
    expect(toastTexts().some((t) => t.startsWith(`${T.saveFailed}：s.md：`))).toBe(true);
    expect(toastBtn('覆盖保存')).toBeUndefined();
    hoisted.saveResult = null;
    await expectUntouched(a, 'b.md', '# B\n', false);
  });
});

// ------------------------------------------------------------------ desktop: the real native service
interface Bridge extends MdrNative {
  emitOpen(p: string): void;
  emitCommand(id: string): void;
  closes: string[];
  writes: Array<{ path: string; text: string }>;
}
function bridge(files: Map<string, string>): Bridge {
  const openCbs: Array<(p: string) => void> = [];
  const cmdCbs: Array<(id: string) => void> = [];
  const b: Bridge = {
    platform: 'darwin',
    version: '0.2.0',
    closes: [],
    writes: [],
    openDialog: async () => null,
    saveDialog: async () => null,
    readFile: async (p: string) => {
      const text = files.get(p);
      if (text === undefined) throw { code: 'ENOENT', message: '文件不存在或已被移动' };
      return { path: p, name: p.split('/').pop()!, text, lastModified: 1 };
    },
    writeFile: async (path: string, text: string) => {
      b.writes.push({ path, text });
      if (hoisted.saveGate) await hoisted.saveGate;
      if (hoisted.saveResult) {
        const r = hoisted.saveResult({ docId: '', name: '', text, lastModified: 0, source: 'native' }, text);
        if (!r.ok) throw { code: 'EIO', message: r.message };
      }
      files.set(path, text);
      return { lastModified: 5 };
    },
    pathForFile: () => null,
    onOpenFile(cb) { openCbs.push(cb); return () => { openCbs.splice(openCbs.indexOf(cb), 1); }; },
    onCommand(cb) { cmdCbs.push(cb); return () => { cmdCbs.splice(cmdCbs.indexOf(cb), 1); }; },
    resolveClose: (d) => { b.closes.push(d); },
    setDocumentState: () => {},
    addRecent: () => {},
    emitOpen: (p) => openCbs.slice().forEach((cb) => cb(p)),
    emitCommand: (id) => cmdCbs.slice().forEach((cb) => cb(id)),
  };
  return b;
}

describe('R6 (desktop native service): a save that completes after the document was replaced', () => {
  const disk = new Map<string, string>();
  let b: Bridge;
  const startDesk = async (): Promise<App> => {
    disk.clear();
    disk.set('/docs/a.md', '# A\n');
    disk.set('/docs/b.md', '# B\n');
    b = bridge(disk);
    (window as { mdrNative?: unknown }).mdrNative = b;
    const a = await start();
    b.emitOpen('/docs/a.md');
    await settle(20);
    expect(a.getText()).toBe('# A\n');
    return a;
  };

  it('a document the OS opens while ⌘S is writing: the next ⌘S writes it into ITS file', async () => {
    const a = await startDesk();
    type(a, 'typed');
    gate();
    a.registry.run('file.save');
    await settle();
    b.emitOpen('/docs/b.md');
    await settle();
    dialogBtn(T.discard)!.click();
    await settle(20);
    expect(a.getText()).toBe('# B\n');
    release();
    await settle(20);
    expect(disk.get('/docs/a.md')).toBe('# A\ntyped'); // what it wrote stays
    expect(document.title).toBe('b.md');
    hoisted.saveGate = null;
    type(a, 'more');
    a.registry.run('file.save');
    await settle(20);
    expect(disk.get('/docs/a.md')).toBe('# A\ntyped');
    expect(disk.get('/docs/b.md')).toBe('# B\nmore');
  });

  it('重新载入 after a conflict while 覆盖保存 is writing: the reloaded text stays clean', async () => {
    const a = await startDesk();
    type(a, 'typed');
    hoisted.saveResult = () => ({ ok: false, reason: 'error', message: `${CONFLICT_MARK}` });
    a.registry.run('file.save');
    await settle(20);
    expect(toastBtn('覆盖保存')).toBeDefined();
    hoisted.saveResult = null;
    disk.set('/docs/a.md', '# A from another program\n');
    gate();
    const reload = toastBtn('重新载入')!;
    toastBtn('覆盖保存')!.click();
    await settle();
    reload.click();
    await settle(20);
    expect(a.getText()).toBe('# A from another program\n');
    release();
    await settle(20);
    expect(document.title).toBe('a.md');
    expect(disk.get('/docs/a.md')).toBe('# A\ntyped'); // the 覆盖保存 the user asked for happened
  });

  it('the close question’s 保存 still closes the window (no replacement: unchanged)', async () => {
    const a = await startDesk();
    type(a, 'typed');
    b.emitCommand(CLOSE_REQUESTED);
    await settle();
    dialogBtn(NATIVE_T.save)!.click();
    await settle(20);
    expect(disk.get('/docs/a.md')).toBe('# A\ntyped');
    expect(b.closes).toEqual(['save']);
    expect(document.title).toBe('a.md');
  });
});

describe('J25 (web): a dropped file the browser cannot read', () => {
  it('says so in zh-CN, not with the browser NotReadableError text', async () => {
    const a = await start();
    a.loadText('keep\n', 'base.md');
    await settle();
    hoisted.dropError = new DOMException('The requested file could not be read, typically due to permission problems', 'NotReadableError');
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    const f = { name: 'locked.md', type: 'text/markdown' };
    Object.defineProperty(ev, 'dataTransfer', {
      value: { types: ['Files'], files: [f], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => f }] },
    });
    root.dispatchEvent(ev);
    await settle(20);
    expect(toastTexts()).toContain('无法打开「locked.md」：没有读取这个文件的权限');
    expect(a.getText()).toBe('keep\n');
  });
});
