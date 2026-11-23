/// <reference types="wicg-file-system-access" />
// src/files/fsaBackend.ts — File System Access API backend: picker, in-place save with permission
// handling, save-as. docId assignment is done by fileService (needs the recent store).
import type { OpenedFile, SaveResult } from '../shared/types';

export const MD_TYPES: FilePickerAcceptType[] = [
  { description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } },
];

export interface PickedFile { handle?: FileSystemFileHandle; file: File }

export interface FileBackend {
  readonly canSaveInPlace: boolean;
  /** Shows the open picker; null when the user cancels. */
  pick(): Promise<PickedFile | null>;
  /** Saves in place when the file has a writable handle, else falls back to saveAs. */
  save(file: OpenedFile, text: string): Promise<SaveResult>;
  /** Save picker (or download); the returned OpenedFile carries the new handle/name. */
  saveAs(text: string, suggestedName: string): Promise<SaveResult>;
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
function isNotAllowed(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
}
function failure(err: unknown): SaveResult {
  if (isAbort(err)) return { ok: false, reason: 'cancelled' };
  if (isNotAllowed(err)) return { ok: false, reason: 'permission' };
  return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
}

/** queryPermission → requestPermission (needs a user gesture). */
export async function ensurePermission(h: FileSystemFileHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  const descriptor: FileSystemHandlePermissionDescriptor = { mode };
  if ((await h.queryPermission(descriptor)) === 'granted') return true;
  return (await h.requestPermission(descriptor)) === 'granted';
}

async function writeHandle(h: FileSystemFileHandle, text: string): Promise<void> {
  const w = await h.createWritable();
  try {
    await w.write(text);
  } finally {
    await w.close();
  }
}

export function createFsaBackend(): FileBackend {
  const saveAs = async (text: string, suggestedName: string, docId?: string): Promise<SaveResult> => {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: MD_TYPES });
      await writeHandle(handle, text);
      const savedAt = Date.now();
      return {
        ok: true,
        savedAt,
        file: { docId: docId ?? '', name: handle.name, text, handle, lastModified: savedAt, source: 'fsa' },
      };
    } catch (err) {
      return failure(err);
    }
  };

  return {
    canSaveInPlace: true,
    async pick() {
      try {
        const [handle] = await window.showOpenFilePicker({ types: MD_TYPES, multiple: false });
        return { handle, file: await handle.getFile() };
      } catch (err) {
        if (isAbort(err)) return null;
        throw err;
      }
    },
    async save(file, text) {
      if (!file.handle) return saveAs(text, file.name, file.docId);
      try {
        if (!(await ensurePermission(file.handle, 'readwrite'))) return { ok: false, reason: 'permission' };
        await writeHandle(file.handle, text);
        const savedAt = Date.now();
        return { ok: true, savedAt, file: { ...file, text, lastModified: savedAt, source: 'fsa' } };
      } catch (err) {
        return failure(err);
      }
    },
    saveAs: (text, suggestedName) => saveAs(text, suggestedName),
  };
}
