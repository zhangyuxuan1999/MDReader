// @vitest-environment jsdom
// fix-save (round 7, rule R7 = N11) on the DESKTOP flows: the REAL native file service over a fake bridge whose
// disk is a Map and whose writeFile waits on a gate (as test/r4-p-r6.test.ts does). The same table and the same
// invariants as test/r7-fs-web.test.ts, for the replacements the shell hands over: another file (open-file), the
// same file again (open-file of the file being saved: OFFK-1), a drop of that file, 重新载入 while 覆盖保存 is
// writing, and the close question's 不保存 (not a replacement, but rule (c) holds there too).
//   I1 the text typed before the save is on disk or in a draft at the end (except an informed 丢弃: a question
//      asked after the failure had been reported, R2);
//   I2 no draft of the saved document is left after a save that wrote;
//   I3 a document shown clean holds what its file holds;
//   I4 no question is left on screen; with the wait on, a save that wrote leaves no question at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftRecord } from '../src/shared/types';
import type { MdrNative } from '../src/shared/native';
import { T } from '../src/shared/i18n';
import { CLOSE_REQUESTED, NATIVE_T } from '../src/app/native';
import { CONFLICT_MARK } from '../src/files/nativeBackend';
import { installLayoutStubs } from './editor.helpers';

installLayoutStubs();

type Outcome = 'ok' | 'fail' | 'never';
const hoisted = vi.hoisted(() => ({
  drafts: new Map<string, { docId: string; version: number; text: string; at: number }>(),
  log: [] as string[],
  wcb: null as null | { onDraftSaved(docId: string, version: number, at: number): void },
  cur: '' as string,
  mine: null as null | { docId: string; version: number; at: number },
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
    list: async () => [], push: async () => {}, remove: async () => {},
    findByHandle: async () => undefined, findByPath: async () => undefined,
  }),
}));

interface Bridge extends MdrNative {
  emitOpen(p: string): void;
  emitCommand(id: string): void;
  closes: string[];
  pending: number;
  conflictNext: boolean;
  gate: Promise<Outcome> | null;
}
function bridge(disk: Map<string, string>): Bridge {
  const openCbs: Array<(p: string) => void> = [];
  const cmdCbs: Array<(id: string) => void> = [];
  const b: Bridge = {
    platform: 'darwin',
    version: '0.2.0',
    closes: [],
    pending: 0,
    conflictNext: false,
    gate: null,
    openDialog: async () => null,
    saveDialog: async () => null,
    // read at the moment it is asked
    readFile: (p: string) => {
      const text = disk.get(p);
      return text === undefined ? Promise.reject({ code: 'ENOENT', message: '文件不存在或已被移动' }) : Promise.resolve({ path: p, name: p.split('/').pop()!, text, lastModified: 1 });
    },
    writeFile: async (path: string, text: string) => {
      if (b.conflictNext) { b.conflictNext = false; throw { code: 'EIO', message: CONFLICT_MARK }; }
      b.pending++;
      const outcome = b.gate ? await b.gate : 'ok';
      b.pending--;
      if (outcome !== 'ok') throw { code: 'EIO', message: 'EIO: disk full (test)' };
      disk.set(path, text);
      return { lastModified: Date.now() };
    },
    pathForFile: (f: File) => (f as File & { path?: string }).path ?? null,
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
const disk = new Map<string, string>();
let b: Bridge;
const S = 'native:/d/s.md';

const start = async (): Promise<App> => {
  localStorage.clear();
  b = bridge(disk);
  (window as { mdrNative?: unknown }).mdrNative = b;
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
const workerDraft = (a: App, docId: string): void => {
  const r = { docId, version: a.editor.version, text: a.getText(), at: Date.now() };
  hoisted.drafts.set(docId, r);
  hoisted.mine = { docId, version: r.version, at: r.at };
  hoisted.wcb!.onDraftSaved(docId, r.version, r.at);
};
const dialogUp = (): boolean => !!root.querySelector('.mdr-dialog');
const btn = (label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-dialog__btn')).find((x) => x.textContent === label);
const answer = (a: 'cancel' | 'discard'): void => {
  (a === 'discard' ? btn(T.discard) ?? btn(NATIVE_T.dontSave) : btn(NATIVE_T.cancel))!.click();
};
const toastTexts = (): string[] => Array.from(root.querySelectorAll('.mdr-toast__text')).map((e) => e.textContent ?? '');
const toastBtn = (label: string): HTMLButtonElement | undefined =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.mdr-toast__btn')).find((x) => x.textContent === label);
const drop = (path: string): void => {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  const f = { name: path.split('/').pop(), type: 'text/markdown', path };
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [f], items: [{ kind: 'file', type: 'text/markdown', getAsFile: () => f }] } });
  root.dispatchEvent(ev);
};

beforeEach(async () => {
  saveWait = (await import('../src/app/App')).SAVE_WAIT;
  document.body.replaceChildren();
  disk.clear();
  hoisted.drafts.clear();
  hoisted.log.length = 0;
  hoisted.mine = null;
});
afterEach(() => {
  saveWait.ms = 10_000;
  saveWait.gestureMs = 4_000;
  release('ok');
  app?.dispose();
  app = null;
  root?.remove();
  delete (window as { mdrNative?: unknown }).mdrNative;
});

type Kind = 'desk-open' | 'desk-same' | 'desk-drop-same' | 'desk-reload' | 'desk-close';
type Moment = 0 | 50 | 500 | 'bound' | 'off';
interface Row { kind: Kind; moment: Moment; outcome: Outcome; ans: 'cancel' | 'discard' | null }

async function runRow(r: Row): Promise<string[]> {
  const bad: string[] = [];
  disk.set('/d/s.md', '# S\n');
  disk.set('/d/o.md', '# O\n');
  const a = await start();
  b.emitOpen('/d/s.md');
  await settle(20);
  if (a.getText() !== '# S\n') return ['setup: s.md not open'];
  typeEnd(a, 'typed');
  workerDraft(a, S);
  const typed = '# S\ntyped';
  const bound = r.moment === 'off' ? 0 : r.moment === 'bound' ? 100 : r.outcome === 'never' ? 150 : 10_000;
  saveWait.ms = bound;
  // 重新载入 comes from the conflict toast: a first ⌘S is refused as a conflict, then 覆盖保存 is the save in flight
  let reload: HTMLButtonElement | undefined;
  if (r.kind === 'desk-reload') {
    b.conflictNext = true;
    a.registry.run('file.save');
    await settle(20);
    reload = toastBtn('重新载入');
    if (!reload || !toastBtn('覆盖保存')) return ['setup: no conflict toast'];
  }
  b.gate = new Promise<Outcome>((res) => { release = res; });
  if (r.kind === 'desk-reload') toastBtn('覆盖保存')!.click();
  else a.registry.run('file.save');
  await settle(4);
  if (b.pending !== 1) return ['setup: save not in flight'];
  if (typeof r.moment === 'number') await sleep(r.moment);
  switch (r.kind) {
    case 'desk-open': b.emitOpen('/d/o.md'); break;
    case 'desk-same': b.emitOpen('/d/s.md'); break;
    case 'desk-drop-same': drop('/d/s.md'); break;
    case 'desk-reload': reload!.click(); break;
    case 'desk-close': b.emitCommand(CLOSE_REQUESTED); break;
  }
  let asked = false;
  let askedWhileSaving = false;
  let failureShownFirst = false;
  const ask = async (ms: number): Promise<void> => {
    if (!(await until(dialogUp, ms))) return;
    asked = true;
    askedWhileSaving = b.pending > 0;
    failureShownFirst = toastTexts().some((t) => t.startsWith(T.saveFailed));
    if (r.ans) answer(r.ans);
  };
  // the close question is not a replacement: it is asked at once, during the save, at every moment
  const waits = r.kind !== 'desk-close';
  if (waits && typeof r.moment === 'number' && r.outcome !== 'never') {
    await settle(4);
    if (dialogUp()) bad.push('asked while the save was in flight (wait on)');
    await sleep(40);
    release(r.outcome);
    await ask(300);
  } else {
    await ask(!waits ? 300 : r.moment === 'bound' || r.moment === 'off' ? 600 : bound + 600);
    if (r.outcome !== 'never') { await sleep(30); release(r.outcome); }
  }
  await settle(20);
  await sleep(40);
  await settle(5);
  if (document.title.startsWith('●') && (hoisted.mine?.docId !== hoisted.cur || hoisted.mine.version !== a.editor.version)) workerDraft(a, hoisted.cur);
  // ---- invariants
  const onDisk = disk.get('/d/s.md')!;
  const draft = hoisted.drafts.get(S)?.text ?? null;
  const informed = r.ans === 'discard' && asked && !askedWhileSaving && r.outcome === 'fail';
  if (!informed && !onDisk.includes('typed') && !(draft ?? '').includes('typed')) bad.push(`I1 typed nowhere: disk=${JSON.stringify(onDisk)} draft=${JSON.stringify(draft)}`);
  if (informed && !failureShownFirst) bad.push('the failure was not reported before the question');
  if (r.outcome === 'ok' && b.pending === 0 && draft !== null && draft.includes('typed')) bad.push(`I2 draft left after a save that wrote: ${JSON.stringify(draft)}`);
  const title = document.title;
  const name = title.replace(/^● /, '');
  const path = '/d/' + name;
  if (!title.startsWith('●') && disk.has(path) && a.getText() !== disk.get(path)) bad.push(`I3 shown as saved: ${name} editor=${JSON.stringify(a.getText())} disk=${JSON.stringify(disk.get(path))}`);
  if (dialogUp()) bad.push('I4 a question is left on screen');
  if (waits && typeof r.moment === 'number' && r.outcome === 'ok') {
    if (asked) bad.push('I4 asked although the save wrote');
    const want = r.kind === 'desk-open' ? '# O\n' : typed;
    if (a.getText() !== want) bad.push(`replacement: editor=${JSON.stringify(a.getText())} want ${JSON.stringify(want)}`);
  }
  if (waits && r.kind !== 'desk-reload' && typeof r.moment === 'number' && r.outcome === 'fail' && (!asked || askedWhileSaving || !failureShownFirst)) bad.push(`fail: asked=${asked} whileSaving=${askedWhileSaving} reported=${failureShownFirst}`);
  if (r.kind === 'desk-close' && r.ans === 'discard' && b.closes.join() !== 'discard') bad.push('close: ' + b.closes.join());
  return bad;
}

const KINDS: Kind[] = ['desk-open', 'desk-same', 'desk-drop-same', 'desk-reload', 'desk-close'];
const rows: Row[] = [];
for (const kind of KINDS) {
  for (const moment of [0, 50, 500, 'bound', 'off'] as Moment[]) {
    for (const outcome of ['ok', 'fail', 'never'] as Outcome[]) {
      const asks = kind === 'desk-close' || (kind !== 'desk-reload' && !(typeof moment === 'number' && outcome === 'ok'));
      for (const ans of asks ? (['cancel', 'discard'] as const) : [null]) rows.push({ kind, moment, outcome, ans });
    }
  }
}

describe('R7 (desktop): the table', () => {
  for (const kind of KINDS) {
    it(`${kind}: every moment x outcome x answer`, async () => {
      const failures: string[] = [];
      for (const r of rows.filter((x) => x.kind === kind)) {
        const bad = await runRow(r);
        if (bad.length) failures.push(`${r.kind} ${r.moment} ${r.outcome} ${r.ans ?? '-'}: ${bad.join('; ')}`);
        saveWait.ms = 10_000;
        release('ok');
        app?.dispose();
        app = null;
        root.remove();
        delete (window as { mdrNative?: unknown }).mdrNative;
        document.body.replaceChildren();
        hoisted.drafts.clear();
        hoisted.mine = null;
        await settle(4);
      }
      expect(failures).toEqual([]);
    }, 60_000);
  }
});

describe('R7 (desktop): OFFK-1 as the verifier saw it', () => {
  it('the same file opened again while its own save is writing shows what was saved, clean; the next save keeps it', async () => {
    disk.set('/d/r1.md', '# R1\n');
    const a = await start();
    b.emitOpen('/d/r1.md');
    await settle(20);
    typeEnd(a, 'typed');
    b.gate = new Promise<Outcome>((res) => { release = res; });
    a.registry.run('file.save');
    await sleep(200);
    b.emitOpen('/d/r1.md');
    await settle(10);
    expect(dialogUp()).toBe(false); // waits for the save, no question yet
    release('ok');
    await settle(30);
    expect(dialogUp()).toBe(false);
    expect(a.getText()).toBe('# R1\ntyped');
    await sleep(40);
    expect(document.title).toBe('r1.md');
    b.gate = null;
    typeEnd(a, 'more');
    a.registry.run('file.save');
    await settle(30);
    expect(disk.get('/d/r1.md')).toBe('# R1\ntypedmore');
  });
});
