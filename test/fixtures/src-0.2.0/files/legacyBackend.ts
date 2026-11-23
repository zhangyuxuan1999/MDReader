// src/files/legacyBackend.ts — fallback for browsers without the File System Access API:
// <input type=file> to open, Blob + <a download> to "save" (always a download, never in place).
import type { OpenedFile, SaveResult } from '../shared/types';
import type { FileBackend, PickedFile } from './fsaBackend';

export const LEGACY_PREFIX = 'legacy:';
const ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

export function legacyDocId(name: string): string {
  return LEGACY_PREFIX + name;
}

/** Triggers a browser download of `text` as `name`. */
export function downloadText(name: string, text: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function pickWithInput(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.hidden = true;
    const done = (file: File | null): void => {
      input.remove();
      resolve(file ? { file } : null);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

export function createLegacyBackend(): FileBackend {
  const saveAs = async (text: string, suggestedName: string): Promise<SaveResult> => {
    const name = suggestedName || '未命名.md';
    try {
      downloadText(name, text);
    } catch (err) {
      return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    const savedAt = Date.now();
    const file: OpenedFile = { docId: legacyDocId(name), name, text, lastModified: savedAt, source: 'legacy' };
    return { ok: true, savedAt, file };
  };
  return {
    canSaveInPlace: false,
    pick: pickWithInput,
    save: (file, text) => saveAs(text, file.name),
    saveAs,
  };
}
