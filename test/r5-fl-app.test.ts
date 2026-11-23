// @vitest-environment jsdom
// test/r5-fl-app.test.ts — fix-lazy (0.2.0 stage 2f, the lead's final rule L), the App half:
//   RL-2 while a load of the editing chunk for a wish of on is on its way the toolbar button is aria-busy; 300 ms after
//        the user's press without the module the toast 正在加载预览编辑功能… (once per load); neither changes aria-pressed
//        or the stored value; both end when the load settles or the wish is withdrawn (the loading toast goes with it);
//        the startup's own load (stored '1', a real user) is busy but shows no loading toast.
//   RL-1 + L4 wording, through App: a failed press shows 预览编辑功能加载失败，请刷新页面或重启应用后重试 (error, 6 s) and
//        stores '0'.
//   RL-3 with the test hooks and the switch on at start, the chunk is asked for at the top of createApp and awaited just
//        before createPreviewEdit: the editor exists while it is on its way, the hooks and the preview's first
//        setPreviewEditable come after it; with '0' stored nothing asks for it and nothing waits.
// The preview, the worker, the stores and the loader are fakes; App, CodeMirror, the toolbar and the toasts are real.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r5-fl-app.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LS_PREVIEW_EDIT, type OpenedFile, type PreviewApi, type PreviewOptions, type SaveResult } from '../src/shared/types';
import { installLayoutStubs } from './editor.helpers';

installLayoutStubs();

interface Pending { resolve(v: boolean): void; reject(e: unknown): void }
const hoisted = vi.hoisted(() => ({
  calls: [] as string[],
  /** the fake preview's chunk: false until a load resolved; the fake answers on synchronously once true */
  chunkHere: false,
  pending: [] as Pending[],
  editable: false,
  /** the fake loader (App's RL-3 boot load) */
  loaderCalls: 0,
  loader: null as null | { promise: Promise<unknown>; resolve(): void; reject(e: unknown): void },
  workerHooks: null as null | { onIdle(v: number): void },
}));

vi.mock('../src/preview/inlineEditLoader', () => ({
  loadInlineEdit: () => {
    hoisted.loaderCalls++;
    hoisted.calls.push('loader');
    if (!hoisted.loader) {
      let resolve!: () => void, reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((rs, rj) => { resolve = () => rs({}); reject = rj; });
      hoisted.loader = { promise, resolve, reject };
    }
    return hoisted.loader.promise;
  },
  inlineEditLoaded: () => null,
  INLINE_EDIT_OFF: {},
}));
vi.mock('../src/preview/createPreview', () => ({
  createPreview: (o: PreviewOptions) => {
    const el = document.createElement('div');
    el.className = 'mdr-preview';
    o.parent.appendChild(el);
    hoisted.calls.push('createPreview');
    const p = {
      el,
      applyStructure() {}, applyStructureDelta() {}, applyHtml() {}, applyOutline() {},
      blockCount: () => 1,
      blockAtLine: (line: number) => ({ index: 0, id: 1, startLine: line, lineCount: 1, kind: 0 as const }),
      blockOfElement: () => null,
      elementOfBlock: () => null,
      setPreviewEditable(on: boolean): void | Promise<boolean> {
        hoisted.calls.push(`editable:${on}`);
        if (!on) { hoisted.editable = false; return; }
        if (hoisted.chunkHere) { hoisted.editable = true; return; }
        return new Promise<boolean>((resolve, reject) => hoisted.pending.push({
          resolve: (v) => { hoisted.chunkHere = true; hoisted.editable = v; resolve(v); },
          reject,
        }));
      },
      isPreviewEditable: () => hoisted.editable,
      endEditSession() {}, flushEditSession() {},
      lineToScrollTop: () => 0,
      scrollTopToLine: () => ({ line: 1, fraction: 0 }),
      topVisible: () => ({ line: 1, fraction: 0 }),
      isLineVisible: () => true,
      scrollToLine() {},
      onScroll: () => () => {},
      setFocusLine() {},
      setVisible() {},
      mountAll: async () => {},
      dispose() {},
    };
    return p as unknown as PreviewApi;
  },
}));
vi.mock('../src/preview/scrollSync', () => ({
  createScrollSync: () => ({ setEnabled() {}, syncNow() {}, dispose() {} }),
}));
vi.mock('../src/app/workerClient', () => ({
  createWorkerClient: (h: { onIdle(v: number): void }) => {
    hoisted.workerHooks = h;
    return { setDoc() {}, edit() {}, viewport() {}, need() {}, setOptions() {}, draft() {}, exportHtml: async () => '', resync() {}, dispose() {} };
  },
}));
vi.mock('../src/files/drafts', () => ({
  createDraftStore: () => ({ get: async () => undefined, del: async () => {} }),
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
      newFile: (): OpenedFile => ({ docId: orig.UNTITLED_ID, name: '未命名.md', text: '', lastModified: 0, source: 'new' }),
      open: async () => null,
      openHandle: async () => { throw new Error('unused'); },
      fromDrop: async () => null,
      save: async (file: OpenedFile, text: string): Promise<SaveResult> => ({ ok: true, savedAt: Date.now(), file: { ...file, text } }),
      saveAs: async (text: string, name: string): Promise<SaveResult> => ({ ok: true, savedAt: Date.now(), file: { docId: 'x', name, text, lastModified: 0, source: 'fsa' } }),
    }),
  };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOADING = '正在加载预览编辑功能…';
const FAILED = '预览编辑功能加载失败，请刷新页面或重启应用后重试';

describe('rule L in App (fix-lazy: RL-1, RL-2, RL-3)', () => {
  let root: HTMLElement;
  let app: Awaited<ReturnType<typeof import('../src/app/App').createApp>> | null = null;
  const boot = (ls: Record<string, string> = {}) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
    root = document.createElement('div');
    document.body.appendChild(root);
    return import('../src/app/App').then(({ createApp }) => createApp(root));
  };
  const btn = () => root.querySelector<HTMLButtonElement>('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]')!;
  const texts = () => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent ?? '');
  const count = (needle: string) => texts().filter((t) => t.includes(needle)).length;

  beforeEach(() => {
    document.body.replaceChildren();
    hoisted.calls.length = 0;
    hoisted.chunkHere = false;
    hoisted.pending.length = 0;
    hoisted.editable = false;
    hoisted.loaderCalls = 0;
    hoisted.loader = null;
    hoisted.workerHooks = null;
  });
  afterEach(() => {
    app?.dispose();
    app = null;
    root?.remove();
    vi.unstubAllEnvs();
  });

  it('RL-2: a press while the chunk is held: aria-busy at once, the loading toast after 300 ms, both gone when it arrives', async () => {
    vi.stubEnv('DEV', false);
    app = await boot({ [LS_PREVIEW_EDIT]: '0' });
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    btn().click();
    expect(hoisted.pending.length).toBe(1);
    expect(btn().getAttribute('aria-busy')).toBe('true');
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('0');
    await sleep(150);
    expect(count(LOADING)).toBe(0);                    // not before 300 ms
    await sleep(250);
    expect(count(LOADING)).toBe(1);                    // once
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('0');
    await sleep(350);
    expect(count(LOADING)).toBe(1);                    // still once, not repeated
    hoisted.pending[0].resolve(true);
    await sleep(0);
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    expect(count(LOADING)).toBe(0);                    // the load settled: the loading toast goes
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('1');
    expect(count('预览可编辑（实验性）：开')).toBe(1);
  });

  it('RL-2: a fast load shows no loading toast; a withdrawal ends the busy state and the timer at once', async () => {
    vi.stubEnv('DEV', false);
    app = await boot({ [LS_PREVIEW_EDIT]: '0' });
    btn().click();
    hoisted.pending[0].resolve(true);
    await sleep(0);
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    await sleep(350);
    expect(count(LOADING)).toBe(0);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    // withdraw: back to a held chunk with a fresh preview state
    btn().click();                                     // off (installed: at once)
    hoisted.chunkHere = false;
    btn().click();                                     // on: held again
    expect(btn().getAttribute('aria-busy')).toBe('true');
    btn().click();                                     // withdrawn before 300 ms
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    await sleep(400);
    expect(count(LOADING)).toBe(0);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('0');
  });

  it('RL-1 + L4: a failed press: the error toast with the reload / restart text, not pressed, stored 0, busy ended', async () => {
    vi.stubEnv('DEV', false);
    app = await boot();
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    btn().click();
    await sleep(350);
    expect(count(LOADING)).toBe(1);
    hoisted.pending[0].reject(new TypeError('Failed to fetch dynamically imported module'));
    await sleep(0);
    warn.mockRestore();
    expect(texts()).toContain(FAILED);
    const errEl = [...document.querySelectorAll('.mdr-toast')].find((t) => t.textContent?.includes(FAILED));
    expect(errEl?.classList.contains('mdr-toast--error')).toBe(true);
    expect(count(LOADING)).toBe(0);
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('0');
    expect(count('：开')).toBe(0);
  });

  it('RL-2: a real user with stored 1: the startup load is busy without a toast; a press during it joins with the toast', async () => {
    vi.stubEnv('DEV', false);
    app = await boot({ [LS_PREVIEW_EDIT]: '1' });
    expect(hoisted.pending.length).toBe(0);            // L8: deferred until the worker's first idle
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    hoisted.workerHooks!.onIdle(1);
    await sleep(0);                                    // (jsdom: no requestIdleCallback, a microtask)
    expect(hoisted.pending.length).toBe(1);
    expect(btn().getAttribute('aria-busy')).toBe('true');
    await sleep(400);
    expect(count(LOADING)).toBe(0);                    // nobody pressed anything
    btn().click();                                     // the button shows off: the press turns it on and joins
    expect(btn().getAttribute('aria-busy')).toBe('true');
    await sleep(400);
    expect(count(LOADING)).toBe(1);
    hoisted.pending[1].resolve(true);
    hoisted.pending[0].resolve(true);
    await sleep(0);
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    expect(count(LOADING)).toBe(0);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBe('1');
  });

  it('RL-3: test hooks, switch on at start: the chunk is asked for first, the editor is built while it is on its way, the hooks after it', async () => {
    let done = false;
    const p = boot().then((a) => { done = true; app = a; return a; });
    await sleep(50);
    expect(hoisted.loaderCalls).toBe(1);
    expect(hoisted.calls[0]).toBe('loader');           // asked for before anything is built
    expect(done).toBe(false);                          // createApp waits for it ...
    expect(root.querySelector('.cm-content')).not.toBeNull();   // ... with the editor and the preview built
    expect(hoisted.calls).toContain('createPreview');
    expect(hoisted.calls.some((c) => c.startsWith('editable:'))).toBe(false);   // the controller not yet
    expect(window.__mdr).toBeUndefined();
    hoisted.chunkHere = true;                          // (the real preview finds the loaded module synchronously)
    hoisted.loader!.resolve();
    await p;
    expect(hoisted.calls.filter((c) => c.startsWith('editable:'))).toEqual(['editable:true']);
    expect(hoisted.pending.length).toBe(0);            // installed at once, nothing waits after it
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(btn().hasAttribute('aria-busy')).toBe(false);
    expect(window.__mdr).toBeDefined();
  });

  it('RL-3: a failed boot load is swallowed: createApp completes and the controller reports the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = boot();
    await sleep(20);
    hoisted.loader!.reject(new TypeError('Failed to fetch dynamically imported module'));
    app = await p;
    hoisted.pending[0].reject(new TypeError('Failed to fetch dynamically imported module'));
    await sleep(0);
    warn.mockRestore();
    expect(texts()).toContain(FAILED);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem(LS_PREVIEW_EDIT)).toBeNull();   // the startup's failure writes nothing
    expect(window.__mdr).toBeDefined();
  });

  it('RL-3: test hooks with 0 stored: nothing asks for the chunk and nothing waits', async () => {
    app = await boot({ [LS_PREVIEW_EDIT]: '0' });
    expect(hoisted.loaderCalls).toBe(0);
    expect(hoisted.calls.filter((c) => c.startsWith('editable:'))).toEqual(['editable:false']);
    expect(btn().hasAttribute('aria-busy')).toBe(false);
  });

  it('a real user never waits for the chunk in createApp (the boot load is test mode only)', async () => {
    vi.stubEnv('DEV', false);
    app = await boot({ [LS_PREVIEW_EDIT]: '1' });
    expect(hoisted.loaderCalls).toBe(0);
    expect(window.__mdr).toBeUndefined();
  });
});
