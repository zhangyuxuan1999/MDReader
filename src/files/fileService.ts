/// <reference types="wicg-file-system-access" />
// src/files/fileService.ts — FileService over the FSA or legacy backend (SPEC §8 "Files").
// docId rules: handles reuse the recent entry's id (isSameEntry) else crypto.randomUUID();
// legacy files are 'legacy:' + name; the new document is 'untitled'.
import type { FileService, OpenedFile, RecentStore, SaveResult } from '../shared/types';
import { T } from '../shared/i18n';
import { getNative } from '../shared/native';
import { createFsaBackend, ensurePermission, type FileBackend } from './fsaBackend';
import { createLegacyBackend, legacyDocId } from './legacyBackend';
import { createNativeFileService } from './nativeBackend';

export const UNTITLED_ID = 'untitled';

/** Extensions the picker offers (SPEC §8) — drag & drop accepts exactly the same set. */
export const MARKDOWN_EXT_RE = /\.(md|markdown|mdown|mkd|txt)$/i;

/** True for files MDReader can open as Markdown source: a Markdown/text extension or a `text/*` type.
 *  Anything else (images, PDFs, archives, office documents) would land in the editor as binary garbage. */
export function isMarkdownFile(name: string, type?: string): boolean {
  if (MARKDOWN_EXT_RE.test(name)) return true;
  if (/\.[0-9a-z]+$/i.test(name)) return false; // a different, known extension wins over a vague type
  return !!type && /^text\//i.test(type);
}

/** Synchronous check on a drop payload (DataTransfer is only readable inside the event). */
export function isMarkdownDrop(dt: DataTransfer): boolean {
  const file = dt.files?.[0];
  if (file) return isMarkdownFile(file.name, file.type);
  const item = Array.from(dt.items ?? []).find((i) => i.kind === 'file');
  return !!item && isMarkdownFile('', item.type);
}

export function hasFsa(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window && typeof window.showOpenFilePicker === 'function';
}

export function newDocId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function isFileHandle(h: FileSystemHandle | null): h is FileSystemFileHandle {
  return !!h && h.kind === 'file';
}

/** Exported for tests: build the service over an explicit backend. */
export function createFileServiceWith(backend: FileBackend, recent: RecentStore): FileService {
  const docIdFor = async (h: FileSystemFileHandle | undefined, name: string, hint?: string): Promise<string> => {
    if (hint) return hint;
    if (!h) return legacyDocId(name);
    return (await recent.findByHandle(h))?.docId ?? newDocId();
  };

  const fromFile = async (file: File, handle?: FileSystemFileHandle, docId?: string): Promise<OpenedFile> => ({
    docId: await docIdFor(handle, file.name, docId),
    name: file.name,
    text: await file.text(),
    handle,
    lastModified: file.lastModified,
    source: handle ? 'fsa' : 'legacy',
  });

  /** After a save-as the file may be new: keep an existing document id, mint one for untitled docs. */
  const withDocId = async (r: SaveResult, previous: OpenedFile | null): Promise<SaveResult> => {
    if (!r.ok) return r;
    const keep = previous && previous.docId !== UNTITLED_ID && previous.source !== 'new' ? previous.docId : undefined;
    const docId = r.file.docId || (await docIdFor(r.file.handle, r.file.name, keep));
    return { ...r, file: { ...r.file, docId } };
  };

  return {
    canSaveInPlace: backend.canSaveInPlace,
    newFile: () => ({ docId: UNTITLED_ID, name: T.untitled, text: '', lastModified: 0, source: 'new' }),
    async open() {
      const picked = await backend.pick();
      return picked ? fromFile(picked.file, picked.handle) : null;
    },
    async openHandle(h, docId) {
      if (!(await ensurePermission(h, 'read'))) throw new DOMException(T.needReauth, 'NotAllowedError');
      return fromFile(await h.getFile(), h, docId);
    },
    async fromDrop(dt) {
      // Second line of defence behind App's synchronous isMarkdownDrop check: never hand a binary
      // file to the editor (the name is only known after the handle/file has been resolved).
      const item = Array.from(dt.items ?? []).find((i) => i.kind === 'file');
      if (item) {
        const handle = item.getAsFileSystemHandle ? await item.getAsFileSystemHandle().catch(() => null) : null;
        if (isFileHandle(handle)) {
          const f = await handle.getFile();
          return isMarkdownFile(f.name, f.type) ? fromFile(f, handle) : null;
        }
        const file = item.getAsFile();
        if (file) return isMarkdownFile(file.name, file.type) ? fromFile(file) : null;
      }
      const file = dt.files?.[0];
      if (!file) return null;
      return isMarkdownFile(file.name, file.type) ? fromFile(file) : null;
    },
    async save(file, text) {
      const r = await backend.save(file, text);
      return withDocId(r, file);
    },
    async saveAs(text, suggestedName) {
      const r = await backend.saveAs(text, suggestedName);
      return withDocId(r, null);
    },
  };
}

/** Desktop build first (CONTRACT §10): with the Electron bridge present, files are addressed by absolute
 *  path so 保存 writes back to the file the user double-clicked. Otherwise: FSA, else the legacy backend. */
export function createFileService(recent: RecentStore): FileService {
  const native = getNative();
  if (native) return createNativeFileService(native);
  return createFileServiceWith(hasFsa() ? createFsaBackend() : createLegacyBackend(), recent);
}
