// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMountQueue, type QueuedItem } from '../src/preview/mountQueue';

const item = (id: number, payload = ''): QueuedItem => ({ id, flags: 0, payload, version: 1 });

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('MountQueue', () => {
  it('mounts centre-first in the next frame and drains, reading the centre once per flush', () => {
    const mounted: number[] = [];
    const drained = vi.fn();
    let centreReads = 0;
    const q = createMountQueue({
      mount: (it) => { mounted.push(it.id); },
      centre: () => { centreReads++; return 5; },
      indexOf: (id) => id,
      onDrained: drained,
    });
    for (const id of [1, 9, 5, 3, 7]) q.enqueue(item(id));
    expect(mounted).toEqual([]);
    expect(q.size).toBe(5);
    vi.advanceTimersByTime(17);
    expect(mounted).toEqual([5, 3, 7, 1, 9]);
    expect(q.size).toBe(0);
    expect(drained).toHaveBeenCalledTimes(1);
    expect(centreReads).toBe(1);   // one layout read per flush, not one per queued item
  });

  it('replaces a queued item with the same id and skips ids that vanished', () => {
    const mounted: QueuedItem[] = [];
    const q = createMountQueue({ mount: (it) => { mounted.push(it); }, centre: () => 0, indexOf: (id) => (id === 2 ? undefined : id) });
    q.enqueue(item(1, 'old'));
    q.enqueue(item(1, 'new'));
    q.enqueue(item(2));
    q.enqueue(item(3));
    q.remove(3);
    expect(q.has(3)).toBe(false);
    vi.advanceTimersByTime(17);
    expect(mounted.map((m) => `${m.id}:${m.payload}`)).toEqual(['1:new']);
  });

  it('dispose cancels the pending flush', () => {
    const mount = vi.fn();
    const q = createMountQueue({ mount, centre: () => 0, indexOf: (id) => id });
    q.enqueue(item(1));
    q.dispose();
    vi.advanceTimersByTime(50);
    expect(mount).not.toHaveBeenCalled();
  });
});
