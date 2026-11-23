// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileServiceWith, isMarkdownDrop, isMarkdownFile, UNTITLED_ID } from '../src/files/fileService';
import type { FileBackend } from '../src/files/fsaBackend';
import { legacyDocId } from '../src/files/legacyBackend';
import type { OpenedFile, RecentEntry, RecentStore, SaveResult } from '../src/shared/types';

type FakeHandle = FileSystemFileHandle & { path: string; perm: PermissionState };

function fakeHandle(path: string, content = '# hi', perm: PermissionState = 'granted'): FakeHandle {
  const name = path.split('/').pop()!;
  const h = {
    kind: 'file', name, path, perm,
    isSameEntry: async (o: FakeHandle) => o.path === path,
    getFile: async () => new File([content], name, { lastModified: 42 }),
    queryPermission: async () => h.perm,
    requestPermission: async () => h.perm,
  };
  return h as unknown as FakeHandle;
}

function memRecent(): RecentStore & { entries: RecentEntry[] } {
  const entries: RecentEntry[] = [];
  return {
    entries,
    list: async () => entries,
    push: async (e) => { entries.unshift(e); },
    remove: async (id) => { entries.splice(0, entries.length, ...entries.filter((e) => e.docId !== id)); },
    findByHandle: async (h) => {
      for (const e of entries) if (e.handle && (await h.isSameEntry(e.handle))) return e;
      return undefined;
    },
  };
}

function fakeBackend(canSaveInPlace = true): FileBackend & { picked: { handle?: FileSystemFileHandle; file: File } | null } {
  const b = {
    canSaveInPlace,
    picked: null as { handle?: FileSystemFileHandle; file: File } | null,
    pick: async () => b.picked,
    save: async (file: OpenedFile, text: string): Promise<SaveResult> =>
      file.handle ? { ok: true, savedAt: 1, file: { ...file, text, lastModified: 1 } } : b.saveAs(text, file.name),
    saveAs: async (text: string, name: string): Promise<SaveResult> => ({
      ok: true, savedAt: 1,
      file: { docId: '', name, text, handle: canSaveInPlace ? fakeHandle('/saved/' + name) : undefined, lastModified: 1, source: canSaveInPlace ? 'fsa' : 'legacy' },
    }),
  };
  return b;
}

describe('createFileService docId rules', () => {
  let recent: ReturnType<typeof memRecent>;
  beforeEach(() => {
    recent = memRecent();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  });

  it('newFile is untitled with lastModified 0', () => {
    const svc = createFileServiceWith(fakeBackend(), recent);
    expect(svc.newFile()).toEqual({ docId: UNTITLED_ID, name: '未命名.md', text: '', lastModified: 0, source: 'new' });
  });

  it('open(): reuses the recent docId for the same handle, else a fresh UUID; null when cancelled', async () => {
    const backend = fakeBackend();
    const svc = createFileServiceWith(backend, recent);
    expect(await svc.open()).toBeNull();
    recent.entries.push({ docId: 'known', name: 'a.md', handle: fakeHandle('/x/a.md'), openedAt: 1 });
    backend.picked = { handle: fakeHandle('/x/a.md', 'text'), file: new File(['text'], 'a.md', { lastModified: 7 }) };
    const a = await svc.open();
    expect(a).toMatchObject({ docId: 'known', name: 'a.md', text: 'text', lastModified: 7, source: 'fsa' });
    backend.picked = { handle: fakeHandle('/x/b.md'), file: new File(['b'], 'b.md') };
    expect((await svc.open())?.docId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('legacy picks get legacy:<name>', async () => {
    const backend = fakeBackend(false);
    const svc = createFileServiceWith(backend, recent);
    backend.picked = { file: new File(['x'], 'notes.md') };
    const f = await svc.open();
    expect(f).toMatchObject({ docId: legacyDocId('notes.md'), source: 'legacy', handle: undefined });
    expect(svc.canSaveInPlace).toBe(false);
  });

  it('openHandle() reads with permission and rejects NotAllowedError when denied', async () => {
    const svc = createFileServiceWith(fakeBackend(), recent);
    const f = await svc.openHandle(fakeHandle('/x/c.md', 'content'), 'given-id');
    expect(f).toMatchObject({ docId: 'given-id', text: 'content', source: 'fsa' });
    await expect(svc.openHandle(fakeHandle('/x/d.md', '', 'denied'))).rejects.toMatchObject({ name: 'NotAllowedError' });
  });

  it('save(): untitled documents get a new id on save-as, named documents keep theirs', async () => {
    const svc = createFileServiceWith(fakeBackend(), recent);
    const r1 = await svc.save(svc.newFile(), 'text');
    expect(r1.ok && r1.file.docId).toBe('11111111-1111-4111-8111-111111111111');
    const named: OpenedFile = { docId: 'keep-me', name: 'k.md', text: '', lastModified: 0, source: 'fsa' };
    const r2 = await svc.saveAs('t', 'k.md');
    expect(r2.ok && r2.file.docId).toBe('11111111-1111-4111-8111-111111111111');
    const r3 = await svc.save(named, 'new text');
    expect(r3.ok && r3.file.docId).toBe('keep-me');
    const withHandle: OpenedFile = { ...named, handle: fakeHandle('/x/k.md') };
    const r4 = await svc.save(withHandle, 'in place');
    expect(r4.ok && r4.file).toMatchObject({ docId: 'keep-me', text: 'in place' });
  });

  it('fromDrop(): prefers a file-system handle, falls back to the File', async () => {
    const svc = createFileServiceWith(fakeBackend(), recent);
    const handle = fakeHandle('/d/drop.md', 'dropped');
    const dtHandle = {
      items: [{ kind: 'file', getAsFileSystemHandle: async () => handle, getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(await svc.fromDrop(dtHandle)).toMatchObject({ text: 'dropped', source: 'fsa', name: 'drop.md' });

    const file = new File(['legacy drop'], 'l.md');
    const dtFile = { items: [{ kind: 'file', getAsFile: () => file }], files: [file] } as unknown as DataTransfer;
    expect(await svc.fromDrop(dtFile)).toMatchObject({ docId: legacyDocId('l.md'), text: 'legacy drop', source: 'legacy' });

    const dtEmpty = { items: [{ kind: 'string', getAsFile: () => null }], files: [] } as unknown as DataTransfer;
    expect(await svc.fromDrop(dtEmpty)).toBeNull();
  });

  it('fromDrop(): refuses non-Markdown files instead of loading binary garbage', async () => {
    const svc = createFileServiceWith(fakeBackend(), recent);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'pic.png', { type: 'image/png' });
    const dtPng = { items: [{ kind: 'file', getAsFile: () => png }], files: [png] } as unknown as DataTransfer;
    expect(await svc.fromDrop(dtPng)).toBeNull();

    // …also when the drop arrives as a file-system handle (FSA path).
    const handle = fakeHandle('/d/pic.png', 'binary');
    const dtHandle = {
      items: [{ kind: 'file', getAsFileSystemHandle: async () => handle, getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(await svc.fromDrop(dtHandle)).toBeNull();

    const txt = new File(['plain'], 'notes.txt', { type: 'text/plain' });
    const dtTxt = { items: [{ kind: 'file', getAsFile: () => txt }], files: [txt] } as unknown as DataTransfer;
    expect(await svc.fromDrop(dtTxt)).toMatchObject({ name: 'notes.txt', text: 'plain' });
  });
});

describe('isMarkdownFile / isMarkdownDrop', () => {
  it('accepts Markdown and text/* payloads and rejects everything else', () => {
    expect(isMarkdownFile('a.md')).toBe(true);
    expect(isMarkdownFile('A.MARKDOWN')).toBe(true);
    expect(isMarkdownFile('notes.txt', 'text/plain')).toBe(true);
    expect(isMarkdownFile('pic.png', 'image/png')).toBe(false);
    expect(isMarkdownFile('book.pdf', 'application/pdf')).toBe(false);
    // A known extension wins over a vague type; a typeless extensionless file is not accepted.
    expect(isMarkdownFile('archive.zip', 'text/plain')).toBe(false);
    expect(isMarkdownFile('README')).toBe(false);
    expect(isMarkdownFile('', 'text/markdown')).toBe(true);
  });

  it('reads the drop payload synchronously from files, then from the item type', () => {
    const png = new File([new Uint8Array([0x89])], 'pic.png', { type: 'image/png' });
    expect(isMarkdownDrop({ items: [{ kind: 'file' }], files: [png] } as unknown as DataTransfer)).toBe(false);
    const md = new File(['# hi'], 'a.md', { type: 'text/markdown' });
    expect(isMarkdownDrop({ items: [{ kind: 'file' }], files: [md] } as unknown as DataTransfer)).toBe(true);
    // No File (handle-only drop): fall back to the item's MIME type.
    expect(isMarkdownDrop({ items: [{ kind: 'file', type: 'text/markdown' }], files: [] } as unknown as DataTransfer)).toBe(true);
    expect(isMarkdownDrop({ items: [{ kind: 'file', type: 'image/png' }], files: [] } as unknown as DataTransfer)).toBe(false);
    expect(isMarkdownDrop({ items: [], files: [] } as unknown as DataTransfer)).toBe(false);
  });
});
