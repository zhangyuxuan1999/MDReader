// Launch-document queue (CONTRACT §10): macOS 'open-file' fires before the renderer exists.
import { describe, expect, it, vi } from 'vitest';
import { createOpenFileQueue } from '../electron/openQueue.mjs';

describe('createOpenFileQueue', () => {
  it('buffers paths until the renderer is ready, then flushes them in order', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);

    q.push('/a/one.md');
    q.push('/a/two.md');
    expect(deliver).not.toHaveBeenCalled();
    expect(q.isReady()).toBe(false);
    expect(q.pending()).toEqual(['/a/one.md', '/a/two.md']);

    const flushed = q.markReady();
    expect(flushed).toEqual(['/a/one.md', '/a/two.md']);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(['/a/one.md', '/a/two.md']);
    expect(q.pending()).toEqual([]);
  });

  it('delivers immediately once ready', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.markReady();
    q.push('/a/later.md');
    expect(deliver).toHaveBeenCalledWith('/a/later.md');
    expect(q.pending()).toEqual([]);
  });

  it('markReady is idempotent and does not re-deliver', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.push('/a/one.md');
    q.markReady();
    expect(q.markReady()).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('reset puts a new window back into buffering mode, keeping pending paths', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.push('/a/one.md');
    q.reset();
    q.push('/a/two.md');
    expect(deliver).not.toHaveBeenCalled();
    q.markReady();
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(['/a/one.md', '/a/two.md']);
  });

  it('drops a duplicate path while buffering (argv + macOS open-file for one launch)', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.push('/a/one.md');
    q.push('/a/one.md');
    q.push('/a/two.md');
    expect(q.pending()).toEqual(['/a/one.md', '/a/two.md']);
    q.markReady();
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(['/a/one.md', '/a/two.md']);
  });

  it('still re-delivers the same path once ready (reopening a file is a real action)', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.markReady();
    q.push('/a/one.md');
    q.push('/a/one.md');
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('ignores empty / non-string paths', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    expect(q.push('')).toBe(false);
    expect(q.push(undefined as unknown as string)).toBe(false);
    expect(q.push(42 as unknown as string)).toBe(false);
    q.markReady();
    expect(deliver).not.toHaveBeenCalled();
  });

  // ---- CONTRACT §10a: deliver() reports whether a live window took the path; nothing is dropped.

  it('re-buffers a path when deliver returns false (window closed, app still in the Dock)', () => {
    let live = true;
    const deliver = vi.fn(() => live);
    const q = createOpenFileQueue(deliver);
    q.markReady();
    live = false;
    expect(q.push('/a/one.md')).toBe(true);
    expect(q.isReady()).toBe(false);
    expect(q.pending()).toEqual(['/a/one.md']);
    // later pushes buffer without trying the dead consumer again
    q.push('/a/two.md');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(q.pending()).toEqual(['/a/one.md', '/a/two.md']);
  });

  it('a path pushed while there is no consumer reaches the next consumer exactly once', () => {
    let live = true;
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => {
      if (!live) return false;
      got.push(p);
      return true;
    });
    q.markReady();
    q.push('/a/first.md');
    // window closed: main.mjs resets on 'closed'
    live = false;
    q.reset();
    q.push('/a/one.md');
    expect(got).toEqual(['/a/first.md']);
    // a new window: createWindow() resets again (pending must survive), renderer subscribes
    q.reset();
    live = true;
    expect(q.markReady()).toEqual(['/a/one.md']);
    expect(got).toEqual(['/a/first.md', '/a/one.md']);
    expect(q.markReady()).toEqual([]);
    expect(got).toEqual(['/a/first.md', '/a/one.md']);
    expect(q.pending()).toEqual([]);
  });

  it('without a reset (closed event missed) the failed delivery is still kept, not dropped', () => {
    let live = true;
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => (live ? (got.push(p), true) : false));
    q.markReady();
    live = false;
    q.push('/a/lost-before-fix.md');
    live = true;
    q.markReady();
    expect(got).toEqual(['/a/lost-before-fix.md']);
  });

  it('keeps arrival order and drops nothing when several paths arrive for one new window', () => {
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => (got.push(p), true));
    q.reset();
    q.push('/a/1.md');
    q.push('/a/2.md');
    q.push('/a/3.md');
    q.reset(); // createWindow() after the first path
    q.markReady();
    expect(got).toEqual(['/a/1.md', '/a/2.md', '/a/3.md']);
  });

  it('a consumer vanishing mid-flush keeps the undelivered rest, in order, without duplicates', () => {
    let budget = 1;
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => {
      if (budget <= 0) return false;
      budget--;
      got.push(p);
      return true;
    });
    q.push('/a/1.md');
    q.push('/a/2.md');
    q.push('/a/3.md');
    expect(q.markReady()).toEqual(['/a/1.md']);
    expect(q.isReady()).toBe(false);
    expect(q.pending()).toEqual(['/a/2.md', '/a/3.md']);
    q.push('/a/2.md'); // same path again while buffering: still one entry, now the last request
    expect(q.pending()).toEqual(['/a/3.md', '/a/2.md']);
    budget = 10;
    expect(q.markReady()).toEqual(['/a/3.md', '/a/2.md']);
    expect(got).toEqual(['/a/1.md', '/a/3.md', '/a/2.md']);
  });

  it('a re-buffered path is deduplicated against an identical later push', () => {
    let live = true;
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => (live ? (got.push(p), true) : false));
    q.markReady();
    live = false;
    q.push('/a/one.md');
    q.push('/a/one.md');
    expect(q.pending()).toEqual(['/a/one.md']);
    live = true;
    q.markReady();
    expect(got).toEqual(['/a/one.md']);
  });

  it('reset is idempotent, keeps pending paths and is a no-op on an empty queue', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.reset();
    q.reset();
    expect(q.isReady()).toBe(false);
    expect(q.pending()).toEqual([]);
    q.push('/a/one.md');
    q.reset();
    q.reset();
    expect(q.pending()).toEqual(['/a/one.md']);
    expect(deliver).not.toHaveBeenCalled();
    q.markReady();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('only a strict true counts as delivered', () => {
    const q = createOpenFileQueue(() => undefined as unknown as boolean);
    q.markReady();
    expect(q.isReady()).toBe(true); // nothing to flush yet
    q.push('/a/one.md');
    expect(q.isReady()).toBe(false);
    expect(q.pending()).toEqual(['/a/one.md']);
  });
  it('pushFront buffers a path ahead of everything pending, deduplicated (crash restore)', () => {
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => { got.push(p); return true; });
    q.markReady();
    q.reset(); // renderer crashed
    q.push('/a/later.md');
    q.push('/a/shown.md');
    expect(q.pushFront('/a/shown.md')).toBe(true);
    expect(q.pending()).toEqual(['/a/shown.md', '/a/later.md']);
    expect(q.isReady()).toBe(false);
    expect(q.pushFront('')).toBe(false);
    q.markReady();
    expect(got).toEqual(['/a/shown.md', '/a/later.md']); // the newest request is shown last
    expect(q.pending()).toEqual([]);
  });

  it('pushFront never delivers directly, even on a live queue', () => {
    const deliver = vi.fn(() => true);
    const q = createOpenFileQueue(deliver);
    q.markReady();
    q.pushFront('/a/shown.md');
    expect(deliver).not.toHaveBeenCalled();
    expect(q.isReady()).toBe(false);
    expect(q.pending()).toEqual(['/a/shown.md']);
  });

  it('remove withdraws one pending path and keeps the rest in order', () => {
    const q = createOpenFileQueue(() => true);
    q.push('/a/one.md');
    q.pushFront('/a/restore.md');
    q.push('/a/two.md');
    expect(q.remove('/a/restore.md')).toBe(true);
    expect(q.remove('/a/restore.md')).toBe(false);
    expect(q.remove('/a/missing.md')).toBe(false);
    expect(q.pending()).toEqual(['/a/one.md', '/a/two.md']);
  });

  it('S1/T5: a buffered duplicate moves to the end (A, B, A ends on A); launch dedupe and pushFront still hold', () => {
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => { got.push(p); return true; });
    q.push('/a/A.md');
    q.push('/a/B.md');
    q.push('/a/A.md');
    expect(q.pending()).toEqual(['/a/B.md', '/a/A.md']);
    q.markReady();
    expect(got).toEqual(['/a/B.md', '/a/A.md']);
    // argv + Apple event for the same launch: one open
    got.length = 0;
    q.reset();
    q.push('/a/L.md');
    q.push('/a/L.md');
    q.markReady();
    expect(got).toEqual(['/a/L.md']);
    // crash restore at the front; the user asking for that same document again makes it the last request
    got.length = 0;
    q.reset();
    q.push('/a/later.md');
    q.pushFront('/a/shown.md');
    expect(q.pending()).toEqual(['/a/shown.md', '/a/later.md']);
    q.push('/a/shown.md');
    expect(q.pending()).toEqual(['/a/later.md', '/a/shown.md']);
    q.markReady();
    expect(got).toEqual(['/a/later.md', '/a/shown.md']);
  });

  it('a delivery refused while a close dialog is up keeps the path for the same consumer (取消 → markReady)', () => {
    let closeAsked = true;
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => { if (closeAsked) return false; got.push(p); return true; });
    q.markReady();
    q.push('/a/held.md');
    expect(got).toEqual([]);
    expect(q.pending()).toEqual(['/a/held.md']);
    closeAsked = false; // 取消
    expect(q.markReady()).toEqual(['/a/held.md']);
    expect(got).toEqual(['/a/held.md']);
    expect(q.isReady()).toBe(true);
  });
});
