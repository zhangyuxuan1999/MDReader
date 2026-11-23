// src/preview/mountQueue.ts — budgeted mounting (SPEC §5.5). Items are keyed by block id (a newer
// item replaces an older one), flushed in rAF slices of ≤ MOUNT_SLICE_MS, centre-first.
import { MOUNT_SLICE_MS } from '../shared/types';

export interface QueuedItem { id: number; flags: number; payload: string; version: number }

export interface MountQueueDeps {
  mount(item: QueuedItem): void;
  /** Block index of the viewport centre, for the mount order (SPEC §5.5). Called **once per flush**, and
   *  the preview answers it from its height model, so the mount path reads no layout at all. */
  centre(): number;
  /** Block index of an id, or `undefined` when the block no longer exists (its item is dropped). */
  indexOf(id: number): number | undefined;
  /** Called after a flush that emptied the queue. */
  onDrained?(): void;
}

export interface MountQueue {
  enqueue(item: QueuedItem): void;
  remove(id: number): void;
  has(id: number): boolean;
  readonly size: number;
  dispose(): void;
}

export function createMountQueue(deps: MountQueueDeps): MountQueue {
  const items = new Map<number, QueuedItem>();
  let raf = 0;

  function schedule(): void {
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function flush(): void {
    raf = 0;
    const centre = deps.centre();
    const order: number[] = [];
    const dist = new Map<number, number>();
    for (const id of items.keys()) {
      const i = deps.indexOf(id);
      if (i === undefined) { items.delete(id); continue; }   // the block vanished: drop its payload
      dist.set(id, Math.abs(i - centre));
      order.push(id);
    }
    order.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const t0 = performance.now();
    for (const id of order) {
      const it = items.get(id);
      if (!it) continue;
      items.delete(id);
      deps.mount(it);
      if (performance.now() - t0 >= MOUNT_SLICE_MS) break;
    }
    if (items.size > 0) schedule();
    else deps.onDrained?.();
  }

  return {
    enqueue(item) {
      items.set(item.id, item);
      schedule();
    },
    remove(id) { items.delete(id); },
    has: (id) => items.has(id),
    get size() { return items.size; },
    dispose() {
      items.clear();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
