import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory idb-keyval; `failing` simulates IndexedDB being unavailable.
const mem = new Map<IDBValidKey, unknown>();
let failing = false;
vi.mock('idb-keyval', () => ({
  get: async (k: IDBValidKey) => {
    if (failing) throw new Error('no idb');
    return mem.get(k);
  },
  set: async (k: IDBValidKey, v: unknown) => {
    if (failing) throw new Error('no idb');
    mem.set(k, v);
  },
  del: async (k: IDBValidKey) => {
    if (failing) throw new Error('no idb');
    mem.delete(k);
  },
}));

import { createRecentStore } from '../src/files/recent';
import { createDraftStore } from '../src/files/drafts';
import { IDB_DRAFT_PREFIX, IDB_RECENT, MAX_RECENT } from '../src/shared/types';

/** Fake handle: same entry ⇔ same `path`. */
const handle = (path: string): FileSystemFileHandle =>
  ({ kind: 'file', name: path.split('/').pop(), isSameEntry: async (o: { path?: string }) => o.path === path, path }) as unknown as FileSystemFileHandle;

describe('createRecentStore', () => {
  beforeEach(() => {
    mem.clear();
    failing = false;
  });

  it('pushes newest first, dedupes by docId and caps at MAX_RECENT', async () => {
    const r = createRecentStore();
    for (let i = 0; i < MAX_RECENT + 3; i++) await r.push({ docId: `d${i}`, name: `${i}.md`, openedAt: i });
    await r.push({ docId: 'd5', name: '5b.md', openedAt: 100 });
    const list = await r.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toMatchObject({ docId: 'd5', name: '5b.md' });
    expect(list.filter((e) => e.docId === 'd5')).toHaveLength(1);
    expect(list.map((e) => e.openedAt)).toEqual([...list.map((e) => e.openedAt)].sort((a, b) => b - a));
    expect(mem.get(IDB_RECENT)).toHaveLength(MAX_RECENT);
  });

  it('removes entries and finds by handle via isSameEntry', async () => {
    const r = createRecentStore();
    await r.push({ docId: 'a', name: 'a.md', handle: handle('/x/a.md'), openedAt: 1 });
    await r.push({ docId: 'b', name: 'b.md', openedAt: 2 });
    expect((await r.findByHandle(handle('/x/a.md')))?.docId).toBe('a');
    expect(await r.findByHandle(handle('/x/zzz.md'))).toBeUndefined();
    await r.remove('a');
    expect((await r.list()).map((e) => e.docId)).toEqual(['b']);
    await r.remove('b');
    expect(mem.has(IDB_RECENT)).toBe(false);
  });

  it('is a no-op when IndexedDB throws', async () => {
    failing = true;
    const r = createRecentStore();
    await expect(r.push({ docId: 'a', name: 'a.md', openedAt: 1 })).resolves.toBeUndefined();
    await expect(r.list()).resolves.toEqual([]);
    await expect(r.remove('a')).resolves.toBeUndefined();
  });

  // CONTRACT §10: desktop entries have no handle — they are reopened by absolute path.
  it('stores and finds desktop entries by path', async () => {
    const r = createRecentStore();
    await r.push({ docId: 'native:/docs/a.md', name: 'a.md', path: '/docs/a.md', openedAt: 1 });
    await r.push({ docId: 'native:/docs/b.md', name: 'b.md', path: '/docs/b.md', openedAt: 2 });
    expect((await r.findByPath('/docs/a.md'))?.docId).toBe('native:/docs/a.md');
    expect(await r.findByPath('/docs/missing.md')).toBeUndefined();
    expect(await r.findByPath('')).toBeUndefined();
    // Path entries survive a round trip through IDB and stay listable next to handle entries.
    await r.push({ docId: 'h', name: 'h.md', handle: handle('/x/h.md'), openedAt: 3 });
    expect((await r.list()).map((e) => e.docId)).toEqual(['h', 'native:/docs/b.md', 'native:/docs/a.md']);
    await r.remove('native:/docs/a.md');
    expect(await r.findByPath('/docs/a.md')).toBeUndefined();
  });

  it('findByPath never matches handle-only entries', async () => {
    const r = createRecentStore();
    await r.push({ docId: 'h', name: 'h.md', handle: handle('/x/h.md'), openedAt: 1 });
    expect(await r.findByPath('/x/h.md')).toBeUndefined();
  });

  it('findByPath is a no-op when IndexedDB throws', async () => {
    failing = true;
    await expect(createRecentStore().findByPath('/docs/a.md')).resolves.toBeUndefined();
  });

  it('serialises concurrent writes', async () => {
    const r = createRecentStore();
    await Promise.all([1, 2, 3].map((i) => r.push({ docId: `d${i}`, name: `${i}.md`, openedAt: i })));
    expect((await r.list()).map((e) => e.docId)).toEqual(['d3', 'd2', 'd1']);
  });
});

describe('createDraftStore', () => {
  beforeEach(() => {
    mem.clear();
    failing = false;
  });

  it('reads well-formed records only and deletes', async () => {
    const d = createDraftStore();
    mem.set(IDB_DRAFT_PREFIX + 'untitled', { docId: 'untitled', version: 3, text: 'hi', at: 10 });
    mem.set(IDB_DRAFT_PREFIX + 'bad', { nope: true });
    expect(await d.get('untitled')).toMatchObject({ version: 3, text: 'hi' });
    expect(await d.get('bad')).toBeUndefined();
    expect(await d.get('missing')).toBeUndefined();
    await d.del('untitled');
    expect(mem.has(IDB_DRAFT_PREFIX + 'untitled')).toBe(false);
    failing = true;
    expect(await d.get('untitled')).toBeUndefined();
    await expect(d.del('x')).resolves.toBeUndefined();
  });
});
