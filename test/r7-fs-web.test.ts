// @vitest-environment jsdom
// fix-save (round 7, rule R7 = N11): a replacement of the document waits for that document's own save, and a
// draft is never deleted while a save of its document is in flight. WEB flows over a fake file service whose
// disk is a Map and whose save waits on a gate; the worker is a fake that writes drafts only when the test
// says so (as the real worker's debounced write would). The table: every kind of replacement x the moment of
// the request (0, 50, 500 ms into the save; after the bound; the wait switched off, i.e. rule (c) alone) x the
// save's outcome (writes, fails, never settles) x the answer where a question is asked. In every row:
//   I1 the text typed before the save is on disk or in a draft at the end (except where the user answered
//      丢弃 to a question asked after the failure had been reported: R2, an informed discard);
//   I2 no draft of the saved document is left after a save that wrote;
//   I3 a document shown clean holds what its file holds (nothing is shown as saved that is not);
//   I4 no question is left on screen; with the wait on, a save that wrote leaves no question at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftRecord, OpenedFile, RecentEntry, SaveResult } from '../src/shared/types';
import { T } from '../src/shared/i18n';
import { redo, undo } from '@codemirror/commands';
import { installLayoutStubs } from './editor.helpers';

installLayoutStubs();

type Outcome = 'ok' | 'fail' | 'never';
const hoisted = vi.hoisted(() => ({
  disk: new Map<string, { text: string; mtime: number }>(),
  drafts: new Map<string, { docId: string; version: number; text: string; at: number }>(),
  log: [] as string[],
  wcb: null as null | { onDraftSaved(docId: string, version: number, at: number): void },
  cur: '' as string,
  mine: null as null | { docId: string; version: number; at: number },
  pick: '' as string,
  recentEntries: [] as RecentEntry[],
  gate: null as null | Promise<Outcome>,
  pendingSaves: 0,
}));

const H = (name: string): FileSystemFileHandle =>
  ({ kind: 'file', name, isSameEntry: async (o: { name?: string }) => !!o && o.name === name }) as unknown as FileSystemFileHandle;
const fileOf = (name: string): OpenedFile => {
  const d = hoisted.disk.get(name)!;
  return { docId: 'id:' + name, name, text: d.text, lastModified: d.mtime, source: 'fsa', handle: H(name) };
};

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
      blockOfElement: () => null, elementOfBlock: () => null,
      setPreviewEditable() {}, isPreviewEditable: () => false, endEditSession() {}, flushEditSession() {},
      lineToScrollTop: () => 0, scrollTopToLine: () => ({ line: 1, fraction: 0 }), topVisible: () => ({ line: 1, fraction: 0 }),
      isLineVisible: () => true, scrollToLine() {}, onScroll: () => () => {}, setFocusLine() {}, setVisible() {},
      mountAll: async () => {}, dispose() {},
    };
  },
}));
vi.mock('../src/preview/scrollSync', () => ({ createScrollSync: () => ({ setEnabled() {}, syncNow() {}, dispose() {} }) }));
vi.mock('../src/app/workerClient', () => ({
  createWorkerClient: (cb: { onDraftSaved(docId: string, version: number, at: number): void }) => {
    hoisted.wcb = cb;
    return {
      setDoc(docId: string) { hoisted.cur = docId; },
      edit() {}, viewport() {}, need() {}, setOptions() {},
      // the real saver: `clear` deletes the current document's record only while it is the one it wrote
      draft(action: string) {
        hoisted.log.push('worker.draft:' + action);
        if (action !== 'clear') return;
        const d = hoisted.drafts.get(hoisted.cur);
        const m = hoisted.mine;
        if (d && m && d.docId === m.docId && d.version === m.version && d.at === m.at) hoisted.drafts.delete(hoisted.cur);
      },
      exportHtml: async () => '', resync() {}, dispose() {},
    };
  },
}));
vi.mock('../src/files/drafts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/drafts')>();
  return {
    ...orig,
    putDraft: async (r: DraftRecord) => { hoisted.log.push('put:' + r.docId); hoisted.drafts.set(r.docId, { ...r }); return true; },
    createDraftStore: () => ({
      get: async (id: string) => hoisted.drafts.get(id),
      del: async (id: string) => { hoisted.log.push('del:' + id); hoisted.drafts.delete(id); },
    }),
  };
});
vi.mock('../src/files/recent', () => ({
  createRecentStore: () => ({
    list: async () => hoisted.recentEntries,
    push: async () => {}, remove: async () => {},
    findByHandle: async () => undefined, findByPath: async () => undefined,
  }),
}));
vi.mock('../src/files/fileService', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/files/fileService')>();
  const write = async (file: OpenedFile, text: string, name: string): Promise<SaveResult> => {
    hoisted.pendingSaves++;
    const outcome = hoisted.gate ? await hoisted.gate : 'ok';
    hoisted.pendingSaves--;
    if (outcome !== 'ok') return { ok: false, reason: 'error', message: 'disk full (test)' };
    const mtime = Date.now();
    hoisted.disk.set(name, { text, mtime });
    return { ok: true, savedAt: mtime, file: { ...file, docId: file.docId || 'id:' + name, name, text, lastModified: mtime, source: 'fsa', handle: H(name) } };
  };
  return {
    ...orig,
    createFileService: () => ({
      canSaveInPlace: true,
      newFile: () => ({ docId: orig.UNTITLED_ID, name: '未命名.md', text: '', lastModified: 0, source: 'new' as const }),
      open: async () => (hoisted.pick ? fileOf(hoisted.pick) : null),
      openHandle: async (h: FileSystemFileHandle) => fileOf(h.name), // read when asked
      // read at the moment of the drop (the browser reads it inside the event)
      fromDrop: (dt: DataTransfer) => Promise.resolve(fileOf(dt.files[0].name)),
      save: (file: OpenedFile, text: string) => write(file, text, file.name),
      saveAs: (text: string) => write({ docId: '', name: 'as.md', text: '', lastModified: 0, source: 'fsa' }, text, 'as.md'),
    }),
  };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await sleep(0); };
const until = async (fn: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(5); }
  return fn();
};

type App = Awaited<ReturnType<typeof import('../src/app/App').createApp>>;
let root: HTMLElement;
let app: App | null = null;
let saveWait: { ms: number; gestureMs: number };
let release: (o: Outcome) => void = () => {};

const start = async (): Promise<App> => {
  localStorage.clear();
  root = document.createElement('div');
  document.body.appendChild(root);
  const { createApp } = await import('../src/app/App');
  app = await createApp(root);
  await settle();
  return app;
};
const typeEnd = (a: App, text: string): void => {
  a.editor.view.dispatch({ changes: { from: a.editor.view.state.doc.length, insert: text }, userEvent: 'input.type' });
};
/** What the real worker's debounced write does: stores the current text and confirms it. */
const workerDraft = (a: App, docId: string): void => {
  const r = { docId, version: a.editor.version, text: a.getText(), at: Date.now() };
  hoisted.drafts.set(docId, r);
  hoisted.mine = { docId, version: r.version, at: r.at };
  hoisted.wcb!.onDraftSaved(docId, r.version, r.at);
};
const dialogUp = (): boolean => !!root.querySelector('.mdr-dialog');
const answer = (a: 'cancel' | 'discard'): void => {
  const btns = Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-dialog__btn'));
  const ok = btns.find((b) => /--danger|--primary/.test(b.className));
  const cancel = btns.find((b) => b !== ok);
  (a === 'discard' ? ok : cancel)!.click();
};
const toastTexts = (): string[] => Array.from(root.querySelectorAll('.mdr-toast__text')).map((e) => e.textContent ?? '');
const toastBtn = (label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-toast__btn')).find((b) => b.textContent === label);
const drop = (name: string): void => {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  const f = { name, type: 'text/markdown' };
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [f], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => f }] } });
  root.dispatchEvent(ev);
};
const clickRecent = async (name: string): Promise<void> => {
  hoisted.recentEntries = [{ docId: 'id:' + name, name, handle: H(name), openedAt: 1 }];
  root.querySelector<HTMLElement>('.mdr-toolbar__file')!.click();
  await settle(4);
  Array.from(root.querySelectorAll<HTMLElement>('.mdr-recent__item')).find((e) => e.textContent === name)!.click();
};

beforeEach(async () => {
  saveWait = (await import('../src/app/App')).SAVE_WAIT;
  document.body.replaceChildren();
  hoisted.disk.clear();
  hoisted.drafts.clear();
  hoisted.log.length = 0;
  hoisted.mine = null;
  hoisted.pick = '';
  hoisted.recentEntries = [];
  hoisted.gate = null;
  hoisted.pendingSaves = 0;
});
afterEach(() => {
  saveWait.ms = 10_000;
  saveWait.gestureMs = 4_000;
  release('ok');
  app?.dispose();
  app = null;
  root?.remove();
});

type Kind = 'open' | 'open-same' | 'recent' | 'recent-same' | 'new' | 'drop' | 'drop-same' | 'restore';
type Moment = 0 | 50 | 500 | 'bound' | 'off';
interface Row { kind: Kind; moment: Moment; outcome: Outcome; ans: 'cancel' | 'discard' | null }
const S = 'id:s.md';

const request = async (a: App, kind: Kind): Promise<void> => {
  switch (kind) {
    case 'open': hoisted.pick = 'o.md'; a.registry.run('file.open'); return;
    case 'open-same': hoisted.pick = 's.md'; a.registry.run('file.open'); return;
    case 'recent': return clickRecent('o.md');
    case 'recent-same': return clickRecent('s.md');
    case 'new': a.registry.run('file.new'); return;
    case 'drop': drop('o.md'); return;
    case 'drop-same': drop('s.md'); return;
    case 'restore': toastBtn(T.restore)!.click(); return;
  }
};

/** One row; returns what the invariants are checked on. */
async function runRow(r: Row): Promise<string[]> {
  const bad: string[] = [];
  hoisted.disk.set('s.md', { text: '# S\n', mtime: 1 });
  hoisted.disk.set('o.md', { text: '# O\n', mtime: 1 });
  // restore: a crash draft of s.md is offered when s.md opens
  if (r.kind === 'restore') hoisted.drafts.set(S, { docId: S, version: 4, text: '# S crash\n', at: Date.now() + 100_000 });
  const a = await start();
  hoisted.pick = 's.md';
  a.registry.run('file.open');
  await settle();
  if (a.getText() !== '# S\n') return ['setup: s.md not open'];
  if (r.kind === 'restore' && !toastBtn(T.restore)) return ['setup: no offer'];
  typeEnd(a, 'typed');
  workerDraft(a, S);
  const typed = '# S\ntyped';
  // the wait: on (10 s), shortened so that it runs out (never settles / after the bound), or off (rule (c) alone)
  const bound = r.moment === 'off' ? 0 : r.moment === 'bound' ? 100 : r.outcome === 'never' ? 150 : 10_000;
  saveWait.ms = bound;
  saveWait.gestureMs = Math.min(bound, 4_000);
  hoisted.gate = new Promise<Outcome>((res) => { release = res; });
  a.registry.run('file.save');
  await settle(2);
  if (hoisted.pendingSaves !== 1) return ['setup: save not in flight'];
  if (typeof r.moment === 'number') await sleep(r.moment);
  await request(a, r.kind);
  let asked = false;
  let askedWhileSaving = false;
  let failureShownFirst = false;
  const ask = async (ms: number): Promise<void> => {
    if (!(await until(dialogUp, ms))) return;
    asked = true;
    askedWhileSaving = hoisted.pendingSaves > 0;
    failureShownFirst = toastTexts().some((t) => t.startsWith(T.saveFailed));
    if (r.ans) answer(r.ans);
  };
  if (typeof r.moment === 'number' && r.outcome !== 'never') {
    await settle(4);
    if (dialogUp()) bad.push('asked while the save was in flight (wait on)');
    await sleep(40);
    release(r.outcome);
    await ask(300);
  } else {
    await ask(r.moment === 'bound' || r.moment === 'off' ? 600 : bound + 600);
    if (r.outcome !== 'never') { await sleep(30); release(r.outcome); }
  }
  await settle(20);
  await sleep(40);
  await settle(5);
  // the worker writes a draft of a dirty document after an edit (a restore replaced the text, say)
  if (document.title.startsWith('●') && (hoisted.mine?.docId !== hoisted.cur || hoisted.mine.version !== a.editor.version)) workerDraft(a, hoisted.cur);
  // ---- invariants
  const disk = hoisted.disk.get('s.md')!.text;
  const draft = hoisted.drafts.get(S)?.text ?? null;
  const informed = r.ans === 'discard' && asked && !askedWhileSaving && r.outcome === 'fail';
  // 恢复 over the typing replaced it as one undoable step (R4, asked first): the draft key now holds the restored
  // text, and the typed text is one undo away
  let inUndo = false;
  if (r.kind === 'restore' && r.ans === 'discard' && asked) {
    undo(a.editor.view);
    inUndo = a.getText().includes('typed');
    redo(a.editor.view);
  }
  if (!informed && !inUndo && !disk.includes('typed') && !(draft ?? '').includes('typed')) bad.push(`I1 typed nowhere: disk=${JSON.stringify(disk)} draft=${JSON.stringify(draft)}`);
  if (informed && !failureShownFirst) bad.push('the failure was not reported before the question');
  if (r.outcome === 'ok' && hoisted.pendingSaves === 0 && draft !== null && draft.includes('typed')) bad.push(`I2 draft left after a save that wrote: ${JSON.stringify(draft)}`);
  const title = document.title;
  const name = title.replace(/^● /, '');
  if (!title.startsWith('●') && hoisted.disk.has(name) && a.getText() !== hoisted.disk.get(name)!.text) bad.push(`I3 shown as saved: ${name} editor=${JSON.stringify(a.getText())} disk=${JSON.stringify(hoisted.disk.get(name)!.text)}`);
  if (dialogUp()) bad.push('I4 a question is left on screen');
  // with the wait on and a save that wrote, the replacement went through without a question
  if (typeof r.moment === 'number' && r.outcome === 'ok') {
    if (asked) bad.push('I4 asked although the save wrote');
    const want = r.kind === 'new' ? '' : r.kind === 'open' || r.kind === 'recent' || r.kind === 'drop' ? '# O\n' : r.kind === 'restore' ? '# S crash\n' : typed;
    if (a.getText() !== want) bad.push(`replacement: editor=${JSON.stringify(a.getText())} want ${JSON.stringify(want)}`);
  }
  // a failed save is reported first, then the question as for any unsaved document
  if (typeof r.moment === 'number' && r.outcome === 'fail' && (!asked || askedWhileSaving || !failureShownFirst)) bad.push(`fail: asked=${asked} whileSaving=${askedWhileSaving} reported=${failureShownFirst}`);
  return bad;
}

// the other four kinds are in test/r7-fs-web2.test.ts (one file would run too long)
const KINDS: Kind[] = ['open', 'open-same', 'recent', 'recent-same'];
const rows: Row[] = [];
for (const kind of KINDS) {
  for (const moment of [0, 50, 500, 'bound', 'off'] as Moment[]) {
    for (const outcome of ['ok', 'fail', 'never'] as Outcome[]) {
      const asks = !(typeof moment === 'number' && outcome === 'ok');
      for (const ans of asks ? (['cancel', 'discard'] as const) : [null]) rows.push({ kind, moment, outcome, ans });
    }
  }
}

describe('R7 (web): the table', () => {
  for (const kind of KINDS) {
    it(`${kind}: every moment x outcome x answer`, async () => {
      const failures: string[] = [];
      for (const r of rows.filter((x) => x.kind === kind)) {
        const bad = await runRow(r);
        if (bad.length) failures.push(`${r.kind} ${r.moment} ${r.outcome} ${r.ans ?? '-'}: ${bad.join('; ')}`);
        saveWait.ms = 10_000;
        saveWait.gestureMs = 4_000;
        release('ok');
        app?.dispose();
        app = null;
        root.remove();
        document.body.replaceChildren();
        hoisted.drafts.clear();
        hoisted.recentEntries = [];
        hoisted.mine = null;
        hoisted.gate = null;
        await settle(4);
        hoisted.pendingSaves = 0;
      }
      expect(failures).toEqual([]);
    }, 60_000);
  }
});

describe('R7 (web): single rules', () => {
  /** s.md open, 'typed' typed and its draft written, a save held on the gate. */
  const saving = async (): Promise<App> => {
    hoisted.disk.set('s.md', { text: '# S\n', mtime: 1 });
    hoisted.disk.set('o.md', { text: '# O\n', mtime: 1 });
    const a = await start();
    hoisted.pick = 's.md';
    a.registry.run('file.open');
    await settle();
    typeEnd(a, 'typed');
    workerDraft(a, S);
    hoisted.gate = new Promise<Outcome>((res) => { release = res; });
    a.registry.run('file.save');
    await settle(2);
    return a;
  };

  it('(c) alone, the wait switched off: 丢弃 during the save keeps the draft; the save wrote → it goes, failed → it stays', async () => {
    for (const outcome of ['ok', 'fail'] as const) {
      saveWait.ms = 0;
      const a = await saving();
      a.registry.run('file.new');
      expect(await until(dialogUp, 300)).toBe(true);
      answer('discard');
      await settle(20);
      expect(a.getText()).toBe('');
      expect(hoisted.log).not.toContain('worker.draft:clear');
      expect(hoisted.drafts.get(S)?.text).toBe('# S\ntyped'); // kept while the save is in flight
      release(outcome);
      await settle(30);
      if (outcome === 'ok') expect(hoisted.drafts.has(S)).toBe(false);
      else expect(hoisted.drafts.get(S)?.text).toBe('# S\ntyped');
      app!.dispose(); app = null; root.remove(); hoisted.drafts.clear(); hoisted.log.length = 0;
    }
  });

  it('(c) alone: the draft is written at the discard even when the worker had not written it yet', async () => {
    saveWait.ms = 0;
    hoisted.disk.set('s.md', { text: '# S\n', mtime: 1 });
    const a = await start();
    hoisted.pick = 's.md';
    a.registry.run('file.open');
    await settle();
    typeEnd(a, 'typed'); // no worker write: ⌘S and 新建 inside the debounce
    hoisted.gate = new Promise<Outcome>((res) => { release = res; });
    a.registry.run('file.save');
    await settle(2);
    a.registry.run('file.new');
    expect(await until(dialogUp, 300)).toBe(true);
    answer('discard');
    await settle(20);
    expect(hoisted.drafts.get(S)?.text).toBe('# S\ntyped');
    release('fail');
    await settle(30);
    expect(hoisted.drafts.get(S)?.text).toBe('# S\ntyped');
  });

  it('without a save in flight 丢弃 deletes the draft at once (R2 unchanged)', async () => {
    hoisted.disk.set('s.md', { text: '# S\n', mtime: 1 });
    const a = await start();
    hoisted.pick = 's.md';
    a.registry.run('file.open');
    await settle();
    typeEnd(a, 'typed');
    workerDraft(a, S);
    a.registry.run('file.new');
    expect(await until(dialogUp, 300)).toBe(true);
    answer('discard');
    await settle(20);
    expect(hoisted.log).toContain('worker.draft:clear');
    expect(hoisted.log).not.toContain('put:' + S);
    expect(hoisted.drafts.has(S)).toBe(false);
  });

  it('a save that never settles holds back only the first replacement, for the bound', async () => {
    saveWait.ms = 200;
    const a = await saving();
    const t0 = Date.now();
    a.registry.run('file.new');
    expect(await until(dialogUp, 1000)).toBe(true);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(180);
    answer('cancel');
    await settle(10);
    // the same save is still in flight: the next request asks at once
    const t1 = Date.now();
    a.registry.run('file.new');
    expect(await until(dialogUp, 1000)).toBe(true);
    expect(Date.now() - t1).toBeLessThan(120);
    answer('cancel');
    await settle(10);
    // typing and another save still work
    typeEnd(a, ' more');
    expect(a.getText()).toBe('# S\ntyped more');
  });

  it('text typed during the wait: the save wrote, the document is still dirty, so the question is asked', async () => {
    const a = await saving();
    a.registry.run('file.new');
    await settle(4);
    typeEnd(a, ' later');
    expect(dialogUp()).toBe(false);
    release('ok');
    expect(await until(dialogUp, 500)).toBe(true);
    expect(hoisted.disk.get('s.md')!.text).toBe('# S\ntyped');
    answer('cancel');
    await settle(10);
    expect(a.getText()).toBe('# S\ntyped later');
  });

  it('web 打开…: the wait for the panel is the gesture bound, not the full one', async () => {
    saveWait.ms = 10_000;
    saveWait.gestureMs = 150;
    const a = await saving();
    hoisted.pick = 'o.md';
    const t0 = Date.now();
    a.registry.run('file.open');
    expect(await until(dialogUp, 2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    answer('discard');
    await settle(20);
    expect(a.getText()).toBe('# O\n');
    expect(hoisted.drafts.get(S)?.text).toBe('# S\ntyped'); // (c): the save is still in flight
    release('ok');
    await settle(30);
    expect(hoisted.drafts.has(S)).toBe(false);
  });

  it('the same file reopened after the bound shows what was saved once the save wrote (read again)', async () => {
    saveWait.ms = 100;
    const a = await saving();
    hoisted.pick = 's.md';
    a.registry.run('file.open');
    expect(await until(dialogUp, 1000)).toBe(true);
    answer('discard');
    await settle(20);
    expect(a.getText()).toBe('# S\n'); // read while the write was on its way
    release('ok');
    await settle(40);
    expect(a.getText()).toBe('# S\ntyped');
    await sleep(40);
    expect(document.title).toBe('s.md');
  });

  it('…but not when it was changed since it was reopened', async () => {
    saveWait.ms = 100;
    const a = await saving();
    hoisted.pick = 's.md';
    a.registry.run('file.open');
    expect(await until(dialogUp, 1000)).toBe(true);
    answer('discard');
    await settle(20);
    typeEnd(a, 'NEW');
    release('ok');
    await settle(40);
    expect(a.getText()).toBe('# S\nNEW');
    await sleep(40);
    expect(document.title).toBe('● s.md');
  });
});
