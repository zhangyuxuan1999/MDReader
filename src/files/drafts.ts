// src/files/drafts.ts — read/delete side of the draft store (the worker writes, SPEC §4.6; putDraft is R7's one exception).
import { createStore, del, get, promisifyRequest, set } from 'idb-keyval';
import { IDB_DRAFT_PREFIX, type DraftRecord, type DraftStore } from '../shared/types';

function isDraft(x: unknown): x is DraftRecord {
  if (typeof x !== 'object' || x === null) return false;
  const d = x as DraftRecord;
  return typeof d.docId === 'string' && typeof d.version === 'number' && typeof d.text === 'string' && typeof d.at === 'number';
}

/** Identifies ONE write of a draft: the record a tab stored carries this version and timestamp. */
export interface DraftStamp { docId: string; version: number; at: number }

/** idb-keyval's own default database and store, opened here so the check and the delete below can share
 *  one transaction (idb-keyval does not export its default store). */
let keyval: ReturnType<typeof createStore> | null = null;

/**
 * R4: 丢弃 / 不保存 / a save delete only a draft THIS tab wrote. Two tabs on the untitled document (or the
 * same file) share one key; the stored record is deleted only while it is still the write stamped `mine` —
 * a record another tab wrote since is left alone. Check and delete run in one readwrite transaction, so no
 * write can slip in between. Resolves true when it deleted; never rejects (IndexedDB unavailable → false).
 */
export async function delDraftIfMine(docId: string, mine: DraftStamp | null): Promise<boolean> {
  if (!mine || mine.docId !== docId || typeof indexedDB === 'undefined') return false;
  try {
    keyval ??= createStore('keyval-store', 'keyval');
    return await keyval('readwrite', (store) =>
      new Promise<boolean>((resolve, reject) => {
        const key = IDB_DRAFT_PREFIX + docId;
        const req = store.get(key);
        req.onsuccess = () => {
          const v: unknown = req.result;
          const own = isDraft(v) && v.docId === docId && v.version === mine.version && v.at === mine.at;
          if (own) store.delete(key);
          promisifyRequest(store.transaction).then(() => resolve(own), reject);
        };
        req.onerror = () => reject(req.error);
      }),
    );
  } catch {
    return false;
  }
}

/**
 * R7 (c): the one draft written from the main thread — the text of a document thrown away while a save of it is
 * still in flight (the worker has already moved on to the next document). The same key and record as the worker's
 * writes. Resolves true when stored; never rejects (IndexedDB unavailable → false).
 */
export async function putDraft(r: DraftRecord): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    await set(IDB_DRAFT_PREFIX + r.docId, r);
    return true;
  } catch {
    return false;
  }
}

export function createDraftStore(): DraftStore {
  return {
    async get(docId) {
      try {
        const v = await get<unknown>(IDB_DRAFT_PREFIX + docId);
        return isDraft(v) ? v : undefined;
      } catch {
        return undefined;
      }
    },
    async del(docId) {
      try {
        await del(IDB_DRAFT_PREFIX + docId);
      } catch {
        /* IDB unavailable */
      }
    },
  };
}
