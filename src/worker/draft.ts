// src/worker/draft.ts — debounced IndexedDB autosave from the worker (SPEC 4.6). Every IDB call is
// guarded so Node tests and private-mode browsers degrade to a no-op.
import { set } from 'idb-keyval';
import { DRAFT_DEBOUNCE_MS, IDB_DRAFT_PREFIX, type DraftRecord } from '../shared/types';
import { delDraftIfMine, type DraftStamp } from '../files/drafts';

export interface DraftSaver {
  enable(): void;
  disable(): void;
  /** Deletes the stored draft of the current document — only while it is still the record this saver
   *  wrote (R4: another tab on the same key keeps its draft) — and cancels a pending write. */
  clear(): void;
  /** Writes now (visibilitychange → hidden). */
  flush(): void;
  /** Called after every edit; (re)starts the debounce when enabled. */
  touch(): void;
  /** Called on setDoc: cancels a pending write that belonged to the previous document. */
  reset(): void;
}

const hasIdb = (): boolean => typeof indexedDB !== 'undefined';

export function createDraftSaver(record: () => DraftRecord | null, onSaved: (docId: string, version: number, at: number) => void): DraftSaver {
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The last record this saver handed to IndexedDB (stamped when issued, so a clear that races the
   *  write still recognises it). */
  let mine: DraftStamp | null = null;

  function cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function write(): void {
    cancel();
    const r = record();
    if (!r || !hasIdb()) return;
    try {
      mine = { docId: r.docId, version: r.version, at: r.at };
      set(IDB_DRAFT_PREFIX + r.docId, r).then(
        () => onSaved(r.docId, r.version, r.at),
        () => undefined,
      );
    } catch {
      // IndexedDB unavailable (private mode): drafts are a no-op.
    }
  }

  return {
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      cancel();
    },
    clear() {
      cancel();
      const r = record();
      if (!r || !hasIdb()) return;
      void delDraftIfMine(r.docId, mine);
    },
    flush() {
      if (enabled) write();
    },
    touch() {
      if (!enabled) return;
      cancel();
      timer = setTimeout(write, DRAFT_DEBOUNCE_MS);
    },
    reset: cancel,
  };
}
