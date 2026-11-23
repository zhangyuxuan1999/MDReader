// @vitest-environment jsdom
// The native FileService (CONTRACT §10) against a fake window.mdrNative bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MdrNative, NativeFileError, NativeFileInfo } from '../src/shared/native';
import type { OpenedFile } from '../src/shared/types';
import {
  basename,
  createNativeFileService,
  encodingOf,
  fileFromNative,
  isLegacyEncoding,
  saveProblem,
  isNativeFileService,
  nativeDocId,
  openPath,
  toOpenError,
} from '../src/files/nativeBackend';
import { createFileService, UNTITLED_ID } from '../src/files/fileService';
import { legacyDocId } from '../src/files/legacyBackend';
import type { RecentStore } from '../src/shared/types';

const err = (code: NativeFileError['code'], message = code): NativeFileError => ({ code, message });

interface Fake extends MdrNative {
  disk: Map<string, string>;
  calls: string[];
  nextOpen: NativeFileInfo | null;
  nextSave: string | null;
  saveArgs: Array<[string, string | null]>;
  paths: Map<File, string>;
  recents: string[];
  states: unknown[];
  fail: NativeFileError | null;
}

function fakeNative(): Fake {
  const info = (path: string, text: string): NativeFileInfo => ({
    path,
    name: basename(path),
    text,
    lastModified: 1000,
  });
  const f: Fake = {
    platform: 'darwin',
    version: '0.1.0',
    disk: new Map([['/docs/a.md', '# A']]),
    calls: [],
    nextOpen: info('/docs/a.md', '# A'),
    nextSave: null,
    saveArgs: [],
    paths: new Map(),
    recents: [],
    states: [],
    fail: null,
    async openDialog() {
      f.calls.push('openDialog');
      return f.nextOpen;
    },
    async saveDialog(suggested, current) {
      f.calls.push('saveDialog');
      f.saveArgs.push([suggested, current]);
      return f.nextSave;
    },
    async readFile(path) {
      f.calls.push('readFile:' + path);
      if (f.fail) throw f.fail;
      const text = f.disk.get(path);
      if (text === undefined) throw err('ENOENT', '没有那个文件');
      return info(path, text);
    },
    async writeFile(path, text) {
      f.calls.push('writeFile:' + path);
      if (f.fail) throw f.fail;
      f.disk.set(path, text);
      return { lastModified: 2000 };
    },
    pathForFile: (file) => f.paths.get(file) ?? null,
    onOpenFile: () => () => {},
    onCommand: () => () => {},
    resolveClose: () => {},
    setDocumentState: (s) => {
      f.states.push(s);
    },
    addRecent: (p) => {
      f.recents.push(p);
    },
  };
  return f;
}

function dropOf(...files: File[]): DataTransfer {
  return { files, items: [] } as unknown as DataTransfer;
}

const memRecent = (): RecentStore => ({
  list: async () => [],
  push: async () => {},
  remove: async () => {},
  findByHandle: async () => undefined,
});

describe('nativeBackend helpers', () => {
  it('basename handles posix and windows separators', () => {
    expect(basename('/docs/a.md')).toBe('a.md');
    expect(basename('C:\\docs\\a.md')).toBe('a.md');
    expect(basename('a.md')).toBe('a.md');
  });

  it('docIds are native: + path', () => {
    expect(nativeDocId('/docs/a.md')).toBe('native:/docs/a.md');
  });

  it('maps ENOENT to a NotFoundError DOMException (what App removes recents on)', () => {
    const e = toOpenError(err('ENOENT'));
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe('NotFoundError');
  });

  it('maps EACCES to NotAllowedError and everything else to a plain Error', () => {
    expect((toOpenError(err('EACCES')) as DOMException).name).toBe('NotAllowedError');
    const io = toOpenError(err('EIO', 'disk on fire'));
    expect(io).toBeInstanceOf(Error);
    expect(io).not.toBeInstanceOf(DOMException);
    expect((io as Error).message).toBe('disk on fire');
  });

  it('keeps the shell code on the plain Error (EISDIR / EIO), so App can say what happened (R3)', () => {
    expect((toOpenError(err('EISDIR', '这是一个文件夹，不是文件')) as Error & { code?: string }).code).toBe('EISDIR');
    expect((toOpenError(err('EIO', 'x')) as Error & { code?: string }).code).toBe('EIO');
  });
});

describe('openPath', () => {
  it('returns a native OpenedFile with a path and a native: docId', async () => {
    const n = fakeNative();
    const f = await openPath('/docs/a.md', n);
    expect(f).toMatchObject({ docId: 'native:/docs/a.md', name: 'a.md', text: '# A', path: '/docs/a.md', source: 'native' });
  });

  it('rejects with NotFoundError for a missing file', async () => {
    const n = fakeNative();
    await expect(openPath('/gone.md', n)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects clearly without a bridge', async () => {
    await expect(openPath('/docs/a.md', undefined)).rejects.toThrow(/桌面桥接/);
  });
});

describe('createNativeFileService', () => {
  let n: Fake;
  beforeEach(() => {
    n = fakeNative();
  });

  it('saves in place and reports itself as a native service', () => {
    const svc = createNativeFileService(n);
    expect(svc.canSaveInPlace).toBe(true);
    expect(isNativeFileService(svc)).toBe(true);
  });

  it('newFile is the untitled scratch buffer', () => {
    expect(createNativeFileService(n).newFile()).toEqual({
      docId: UNTITLED_ID,
      name: '未命名.md',
      text: '',
      lastModified: 0,
      source: 'new',
    });
  });

  it('open() rejects with a real Error when the shell could not read the picked file (was: [object Object])', async () => {
    const svc = createNativeFileService(n);
    n.openDialog = async () => {
      throw err('EIO', '无法识别该文件的文本编码（可能是二进制文件）');
    };
    const e = await svc.open().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('无法识别该文件的文本编码（可能是二进制文件）');
    n.openDialog = async () => {
      throw err('ENOENT', 'gone');
    };
    await expect(svc.open()).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('open() reads the picked file; cancel yields null', async () => {
    const svc = createNativeFileService(n);
    expect(await svc.open()).toMatchObject({ path: '/docs/a.md', source: 'native', docId: 'native:/docs/a.md' });
    n.nextOpen = null;
    expect(await svc.open()).toBeNull();
  });

  it('openHandle is not applicable on the desktop build', async () => {
    await expect(createNativeFileService(n).openHandle({} as FileSystemFileHandle)).rejects.toThrow(/不支持文件句柄/);
  });

  it('save() writes back to the same path and refreshes lastModified', async () => {
    const svc = createNativeFileService(n);
    const file = (await svc.open())!;
    const r = await svc.save(file, '# B');
    expect(r.ok).toBe(true);
    expect(n.disk.get('/docs/a.md')).toBe('# B');
    if (r.ok) {
      expect(r.savedAt).toBe(2000);
      expect(r.file).toMatchObject({ path: '/docs/a.md', lastModified: 2000, source: 'native', docId: 'native:/docs/a.md' });
    }
  });

  it('save() on a document without a path falls back to saveAs', async () => {
    const svc = createNativeFileService(n);
    n.nextSave = '/docs/new.md';
    const r = await svc.save(svc.newFile(), 'hello');
    expect(n.calls).toContain('saveDialog');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toMatchObject({ path: '/docs/new.md', name: 'new.md', docId: 'native:/docs/new.md', source: 'native' });
    expect(n.disk.get('/docs/new.md')).toBe('hello');
  });

  it('saveAs cancelled → {ok:false, reason:"cancelled"} and nothing written', async () => {
    const svc = createNativeFileService(n);
    n.nextSave = null;
    const r = await svc.saveAs('x', 'a.md');
    expect(r).toEqual({ ok: false, reason: 'cancelled' });
    expect(n.calls).not.toContain('writeFile:/docs/a.md');
  });

  it('saveAs offers the current file as the starting point', async () => {
    const svc = createNativeFileService(n);
    await svc.open(); // notes /docs/a.md
    n.nextSave = '/docs/copy.md';
    await svc.saveAs('x', 'a.md');
    expect(n.saveArgs.at(-1)).toEqual(['a.md', '/docs/a.md']);
  });

  it('noteOpened seeds the save dialog for files opened by path', async () => {
    const svc = createNativeFileService(n);
    svc.noteOpened(await openPath('/docs/a.md', n));
    n.nextSave = '/docs/copy.md';
    await svc.saveAs('x', 'a.md');
    expect(n.saveArgs.at(-1)).toEqual(['a.md', '/docs/a.md']);
    svc.noteOpened(null);
    await svc.saveAs('x', 'a.md');
    expect(n.saveArgs.at(-1)).toEqual(['a.md', null]);
  });

  it('write errors become {ok:false, reason:"error"} carrying the message', async () => {
    const svc = createNativeFileService(n);
    const file = (await svc.open())!;
    n.fail = err('EACCES', '权限不足');
    expect(await svc.save(file, 'x')).toEqual({ ok: false, reason: 'error', message: '权限不足' });
  });

  it('fromDrop resolves the dropped file to a path so ⌘S writes back', async () => {
    const svc = createNativeFileService(n);
    const file = new File(['# A'], 'a.md');
    n.paths.set(file, '/docs/a.md');
    const opened = await svc.fromDrop(dropOf(file));
    expect(opened).toMatchObject({ path: '/docs/a.md', source: 'native', text: '# A' });
  });

  it('fromDrop falls back to the in-memory File when the path is unknown', async () => {
    const svc = createNativeFileService(n);
    const file = new File(['# mem'], 'mem.md');
    const opened = (await svc.fromDrop(dropOf(file))) as OpenedFile;
    expect(opened).toMatchObject({ name: 'mem.md', text: '# mem', source: 'legacy', docId: legacyDocId('mem.md') });
    expect(opened.path).toBeUndefined();
  });

  // G31 / R3: the shell's refusal of a dropped file's path is the answer — no File.text() fallback (binary
  // garbage, an English permission message, an empty document for a FIFO).
  it('fromDrop rejects with the shell\'s reason when the shell refuses the resolved path', async () => {
    const svc = createNativeFileService(n);
    const file = new File(['# mem'], 'mem.md');
    n.paths.set(file, '/gone.md');
    await expect(svc.fromDrop(dropOf(file))).rejects.toMatchObject({ name: 'NotFoundError' });
    n.fail = err('EIO', '无法识别该文件的文本编码（可能是二进制文件）');
    n.paths.set(file, '/docs/a.md');
    await expect(svc.fromDrop(dropOf(file))).rejects.toMatchObject({ code: 'EIO', message: '无法识别该文件的文本编码（可能是二进制文件）' });
    n.fail = err('EACCES', '权限不足');
    await expect(svc.fromDrop(dropOf(file))).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('fromDrop still falls back to the in-memory File when the bridge itself breaks (not a shell verdict)', async () => {
    const svc = createNativeFileService(n);
    const file = new File(['# mem'], 'mem.md');
    n.paths.set(file, '/docs/a.md');
    n.readFile = async () => { throw new TypeError('bridge gone'); };
    const opened = (await svc.fromDrop(dropOf(file))) as OpenedFile;
    expect(opened).toMatchObject({ source: 'legacy', text: '# mem' });
  });

  it('fromDrop skips non-Markdown files and returns null when none are left', async () => {
    const svc = createNativeFileService(n);
    const png = new File([''], 'shot.png', { type: 'image/png' });
    const md = new File(['# ok'], 'ok.md');
    expect(await svc.fromDrop(dropOf(png))).toBeNull();
    expect(await svc.fromDrop(dropOf(png, md))).toMatchObject({ name: 'ok.md' });
  });
});

describe('createFileService backend choice', () => {
  afterEach(() => {
    delete window.mdrNative;
    vi.unstubAllGlobals();
  });

  it('picks the native backend first when the bridge is present', () => {
    window.mdrNative = fakeNative();
    expect(isNativeFileService(createFileService(memRecent()))).toBe(true);
  });

  it('is the unchanged web service without a bridge', () => {
    expect(window.mdrNative).toBeUndefined();
    const svc = createFileService(memRecent());
    expect(isNativeFileService(svc)).toBe(false);
    expect(svc.newFile().docId).toBe(UNTITLED_ID);
  });
});

// ---------------------------------------------------------------- fix round 2: encoding + conflicts
describe('encoding side table and save problems', () => {
  it('remembers the encoding the shell decoded a file with', () => {
    expect(encodingOf('/tmp/never-opened.md')).toBeUndefined();
    fileFromNative({ path: '/tmp/gbk.md', name: 'gbk.md', text: '# 中文', lastModified: 1, encoding: 'gbk' } as never);
    fileFromNative({ path: '/tmp/plain.md', name: 'plain.md', text: '# 中文', lastModified: 1 } as never);
    expect(encodingOf('/tmp/gbk.md')).toBe('gbk');
    expect(encodingOf('/tmp/plain.md')).toBeUndefined();
    expect(isLegacyEncoding(encodingOf('/tmp/gbk.md'))).toBe(true);
    expect(isLegacyEncoding('utf-8')).toBe(false);
    expect(isLegacyEncoding(undefined)).toBe(false);
  });

  it('classifies the two save failures App can act on', () => {
    const fail = (message: string) => ({ ok: false as const, reason: 'error' as const, message });
    expect(saveProblem(fail('文件已被其他程序修改，保存会覆盖对方的改动'))).toBe('conflict');
    expect(saveProblem(fail('文档包含 GBK 编码无法表示的字符「😀」，请用「另存为」保存为 UTF-8'))).toBe('encoding');
    expect(saveProblem(fail('磁盘已满'))).toBeNull();
    expect(saveProblem({ ok: false, reason: 'cancelled' })).toBeNull();
    expect(saveProblem({ ok: true, savedAt: 1, file: { docId: 'x', name: 'x', text: '', lastModified: 1, source: 'native' } })).toBeNull();
  });
});
