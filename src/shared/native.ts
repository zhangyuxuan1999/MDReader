// src/shared/native.ts — FROZEN contract between the Electron shell (electron/preload.ts exposes it via
// contextBridge as window.mdrNative) and the renderer (src/files/nativeBackend.ts + src/app/App.ts).
// When window.mdrNative is absent the renderer behaves exactly as the web build (FSA / legacy backends).

export interface NativeFileInfo {
  path: string;          // absolute path
  name: string;          // basename
  text: string;          // UTF-8 decoded, CRLF preserved (the worker normalises)
  lastModified: number;  // mtime in ms since epoch
}

export interface NativeDocumentState {
  path: string | null;   // null for an untitled document
  name: string;          // shown in the window title
  dirty: boolean;        // drives the macOS "edited" dot and the close/quit guard
}

export interface NativeFileError { code: 'ENOENT' | 'EACCES' | 'EISDIR' | 'EIO' | 'UNKNOWN'; message: string }

export interface MdrNative {
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly version: string;                                   // app version from package.json
  /** Native open panel filtered to Markdown/text; reads the chosen file. null = cancelled. */
  openDialog(): Promise<NativeFileInfo | null>;
  /** Native save panel; returns the chosen absolute path or null when cancelled. Does not write. */
  saveDialog(suggestedName: string, currentPath: string | null): Promise<string | null>;
  /** Rejects with a NativeFileError-shaped object. */
  readFile(path: string): Promise<NativeFileInfo>;
  writeFile(path: string, text: string): Promise<{ lastModified: number }>;
  /** Absolute path of a File that came from a drop / <input type=file>, or null when unknown. */
  pathForFile(file: File): string | null;
  /** The OS asked the app to open a document (double-click, "Open With", Dock drop, `open -a`). The launch
   *  document is delivered as soon as the renderer subscribes; later ones as they arrive. Returns unsubscribe. */
  onOpenFile(cb: (path: string) => void): () => void;
  /** A native menu item / shortcut was chosen; `id` is a CommandId from src/shared/types.ts. The shell also sends
   *  'app.closeRequested' when the window/app wants to close while the document is dirty: the renderer must
   *  answer through resolveClose(). Returns unsubscribe. */
  onCommand(cb: (id: string) => void): () => void;
  /** After 'app.closeRequested': 'save' → the renderer has saved (or the user cancelled the save: then send
   *  'cancel'), 'discard' → close without saving, 'cancel' → keep the window open. */
  resolveClose(decision: 'save' | 'discard' | 'cancel'): void;
  /** Called by the renderer whenever the document identity or dirty flag changes. */
  setDocumentState(s: NativeDocumentState): void;
  /** Adds the path to the OS recent-documents list (macOS "Open Recent"). */
  addRecent(path: string): void;
}

declare global {
  interface Window { mdrNative?: MdrNative }
}

export function getNative(): MdrNative | undefined {
  return typeof window !== 'undefined' ? window.mdrNative : undefined;
}
