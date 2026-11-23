// src/files/recent.ts — recent files in idb-keyval under IDB_RECENT (newest first, ≤ MAX_RECENT).
// Every IDB call is guarded: without IndexedDB (private mode) the store is an in-memory no-op.
import { del, get, set } from 'idb-keyval';
import { IDB_RECENT, MAX_RECENT, type RecentEntry, type RecentStore } from '../shared/types';

function isEntry(x: unknown): x is RecentEntry {
  return typeof x === 'object' && x !== null && typeof (x as RecentEntry).docId === 'string' && typeof (x as RecentEntry).name === 'string';
}

/** Desktop entries (CONTRACT §10) have no handle — they are found by absolute path. `src/shared/types.ts`
 *  is frozen, so the extra lookup lives on the concrete store; it is still a RecentStore everywhere else. */
export interface RecentStoreWithPath extends RecentStore {
  findByPath(path: string): Promise<RecentEntry | undefined>;
}

export function createRecentStore(): RecentStoreWithPath {
  // Serialise writes so concurrent push/remove cannot interleave read-modify-write cycles.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const read = async (): Promise<RecentEntry[]> => {
    try {
      const v = await get<unknown>(IDB_RECENT);
      return Array.isArray(v) ? v.filter(isEntry) : [];
    } catch {
      return [];
    }
  };
  const write = async (list: RecentEntry[]): Promise<void> => {
    try {
      if (list.length === 0) await del(IDB_RECENT);
      else await set(IDB_RECENT, list);
    } catch {
      /* IDB unavailable */
    }
  };

  return {
    list: () => serial(async () => (await read()).sort((a, b) => b.openedAt - a.openedAt)),
    push: (e) =>
      serial(async () => {
        const rest = (await read()).filter((x) => x.docId !== e.docId);
        await write([e, ...rest].slice(0, MAX_RECENT));
      }),
    remove: (docId) =>
      serial(async () => {
        const list = await read();
        const rest = list.filter((x) => x.docId !== docId);
        if (rest.length !== list.length) await write(rest);
      }),
    async findByPath(path) {
      if (!path) return undefined;
      return (await read()).find((e) => e.path === path);
    },
    async findByHandle(h) {
      for (const e of await read()) {
        if (!e.handle) continue;
        try {
          if (await h.isSameEntry(e.handle)) return e;
        } catch {
          /* handle from another origin/session: skip */
        }
      }
      return undefined;
    },
  };
}
