// src/files/nativeBackend.ts — FileService over the Electron shell bridge (CONTRACT §10, src/shared/native.ts).
// A native file carries an absolute `path`, so 保存 writes back to the very file the user double-clicked;
// docIds are 'native:' + path (stable across sessions, which is what keys the draft store).
// src/shared/i18n.ts is frozen, so the two strings this module needs live here.
import type { MdrNative, NativeFileError, NativeFileInfo } from '../shared/native';
import { getNative } from '../shared/native';
import type { FileService, OpenedFile, SaveResult } from '../shared/types';
import { T } from '../shared/i18n';
import { isMarkdownFile, UNTITLED_ID } from './fileService';
import { legacyDocId } from './legacyBackend';

/** zh-CN strings owned by this module. */
const E_NO_HANDLE = '桌面版按路径打开文件，不支持文件句柄';
const E_NO_BRIDGE = '桌面桥接不可用';

export const NATIVE_PREFIX = 'native:';

/** Markers inside a NativeFileError message that App branches on. The shell builds these strings in
 *  electron/fileIO.mjs (CONFLICT_MESSAGE / unrepresentableMessage); they are matched, not parsed,
 *  because NativeFileError.code is frozen to five values and both cases are 'EIO'. */
export const CONFLICT_MARK = '文件已被其他程序修改';
export const UNREPRESENTABLE_MARK = '无法表示的字符';

/** Why an in-place 保存 was refused, when the shell refused it for a reason App can act on. */
export type NativeSaveProblem = 'conflict' | 'encoding' | null;

export function saveProblem(r: SaveResult): NativeSaveProblem {
  if (r.ok || r.reason !== 'error' || !r.message) return null;
  if (r.message.includes(CONFLICT_MARK)) return 'conflict';
  if (r.message.includes(UNREPRESENTABLE_MARK)) return 'encoding';
  return null;
}

/** The encoding the shell decoded each opened file with. It is not part of the frozen
 *  NativeFileInfo / OpenedFile shapes, so it lives here, keyed by absolute path, and App reads it to
 *  tell the user 「这是一个 GBK 文件」 once. Bounded: a long session must not remember every file. */
const ENCODING_LIMIT = 200;
const encodings = new Map<string, string>();

export function noteEncoding(path: string, encoding: string | undefined): void {
  if (!path || !encoding) return;
  encodings.delete(path);
  encodings.set(path, encoding);
  while (encodings.size > ENCODING_LIMIT) encodings.delete(encodings.keys().next().value as string);
}

/** The WHATWG label the file was decoded with ('utf-8', 'gbk', 'utf-16le', …), or undefined. */
export function encodingOf(path: string | undefined): string | undefined {
  return path ? encodings.get(path) : undefined;
}

/** True for a file whose bytes are not UTF-8 — it is written back in its own encoding, and a
 *  character outside that encoding makes the save fail (App then offers 另存为). */
export function isLegacyEncoding(encoding: string | undefined): boolean {
  return !!encoding && encoding !== 'utf-8';
}

export const nativeDocId = (path: string): string => NATIVE_PREFIX + path;

/** Basename of an absolute path (POSIX or Windows separators). */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function isNativeFileError(x: unknown): x is NativeFileError {
  const e = x as NativeFileError | null;
  return typeof e === 'object' && e !== null && typeof e.code === 'string' && typeof e.message === 'string';
}

function messageOf(err: unknown): string {
  if (isNativeFileError(err)) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Maps a NativeFileError onto the rejections App already handles: ENOENT → DOMException NotFoundError
 *  (recents: drop the entry), EACCES → NotAllowedError, everything else a plain Error that keeps the
 *  shell's `code` (EISDIR, EIO, UNKNOWN) so App can say what happened (CONTRACT §11 R3). */
export function toOpenError(err: unknown): unknown {
  if (err instanceof DOMException) return err;
  if (!isNativeFileError(err)) return err instanceof Error ? err : new Error(String(err));
  if (err.code === 'ENOENT') return new DOMException(err.message, 'NotFoundError');
  if (err.code === 'EACCES') return new DOMException(err.message, 'NotAllowedError');
  return Object.assign(new Error(err.message), { code: err.code });
}

export function fileFromNative(info: NativeFileInfo): OpenedFile {
  noteEncoding(info.path, (info as NativeFileInfo & { encoding?: string }).encoding);
  return {
    docId: nativeDocId(info.path),
    name: info.name,
    text: info.text,
    path: info.path,
    lastModified: info.lastModified,
    source: 'native',
  };
}

/** Opens an absolute path (the OS `open-file` event, a recent entry). Rejects with a DOMException whose
 *  name App already branches on — NotFoundError for a file that is gone. */
export async function openPath(path: string, bridge: MdrNative | undefined = getNative()): Promise<OpenedFile> {
  if (!bridge) throw new Error(E_NO_BRIDGE);
  try {
    return fileFromNative(await bridge.readFile(path));
  } catch (err) {
    throw toOpenError(err);
  }
}

export interface NativeFileService extends FileService {
  /** App tells the service which document is current, so 另存为 starts in that file's folder.
   *  (`saveAs` alone cannot know: the frozen FileService signature has no file argument.) */
  noteOpened(f: OpenedFile | null): void;
}

export function isNativeFileService(s: FileService): s is NativeFileService {
  return typeof (s as NativeFileService).noteOpened === 'function';
}

export function createNativeFileService(bridge: MdrNative): NativeFileService {
  let currentPath: string | null = null;
  const note = (p: string | null | undefined): void => {
    currentPath = p ?? null;
  };
  const failed = (err: unknown): SaveResult => ({ ok: false, reason: 'error', message: messageOf(err) });

  const write = async (path: string, text: string, name: string, previous?: OpenedFile): Promise<SaveResult> => {
    try {
      const { lastModified } = await bridge.writeFile(path, text);
      note(path);
      return {
        ok: true,
        savedAt: lastModified,
        file: { ...previous, docId: nativeDocId(path), name, text, path, lastModified, source: 'native' },
      };
    } catch (err) {
      return failed(err);
    }
  };

  const saveAs = async (text: string, suggestedName: string): Promise<SaveResult> => {
    let path: string | null;
    try {
      path = await bridge.saveDialog(suggestedName || T.untitled, currentPath);
    } catch (err) {
      return failed(err);
    }
    if (!path) return { ok: false, reason: 'cancelled' };
    return write(path, text, basename(path));
  };

  /** A dropped file whose path the shell could not resolve: keep the text, lose the write-back (⌘S → 另存为). */
  const fromLooseFile = async (f: File): Promise<OpenedFile> => ({
    docId: legacyDocId(f.name),
    name: f.name,
    text: await f.text(),
    lastModified: f.lastModified,
    source: 'legacy',
  });

  return {
    canSaveInPlace: true,
    noteOpened: (f) => note(f?.path),
    newFile: () => ({ docId: UNTITLED_ID, name: T.untitled, text: '', lastModified: 0, source: 'new' }),

    async open() {
      let info: NativeFileInfo | null;
      try {
        info = await bridge.openDialog();
      } catch (err) {
        // The shell read the picked file and failed (undecodable, a FIFO …): a NativeFileError-shaped
        // object, which App used to print as 「打开失败：[object Object]」.
        throw toOpenError(err);
      }
      if (!info) return null;
      note(info.path);
      return fileFromNative(info);
    },

    // Handles are a File System Access concept; the desktop build addresses files by path.
    async openHandle() {
      throw new Error(E_NO_HANDLE);
    },

    async fromDrop(dt) {
      const files = Array.from(dt.files ?? []);
      if (files.length === 0) {
        for (const item of Array.from(dt.items ?? [])) {
          if (item.kind !== 'file') continue;
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      for (const f of files) {
        // Second line of defence behind App's synchronous isMarkdownDrop check.
        if (!isMarkdownFile(f.name, f.type)) continue;
        const path = bridge.pathForFile(f);
        if (path) {
          try {
            const opened = fileFromNative(await bridge.readFile(path));
            note(opened.path);
            return opened;
          } catch (err) {
            // G31 / R3: the shell refused the file (binary, no permission, a FIFO, a folder, gone): that
            // refusal is the answer — App names the file and the shell's reason and keeps the current
            // document. Reading File.text() instead opened binary garbage, or an empty document for a FIFO.
            if (isNativeFileError(err)) throw toOpenError(err);
            // Anything else is a broken bridge, not a verdict on the file: the in-memory File still works.
          }
        }
        return fromLooseFile(f);
      }
      return null;
    },

    async save(file, text) {
      if (!file.path) return saveAs(text, file.name);
      return write(file.path, text, file.name, file);
    },

    saveAs,
  };
}
