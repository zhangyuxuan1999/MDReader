// src/worker/cache.ts — byte-budgeted LRU keyed by content hash (SPEC 4.1). Map insertion order is
// the recency order: get() re-inserts, set() evicts from the front until the budget holds.
export interface RenderedBlock { html: string; flags: number; renderMs: number }

export class LruCache<K, V> {
  private map = new Map<K, { value: V; cost: number }>();
  private total = 0;

  constructor(private budget: number, private costOf: (v: V) => number) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  /** Membership without touching recency. */
  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.cost;
      this.map.delete(key);
    }
    const cost = this.costOf(value);
    this.map.set(key, { value, cost });
    this.total += cost;
    if (this.total > this.budget) this.evict();
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  private evict(): void {
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) return;
      this.map.delete(k);
      this.total -= e.cost;
    }
  }
}

export const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

export function createRenderCache(budget = CACHE_BUDGET_BYTES): LruCache<string, RenderedBlock> {
  return new LruCache<string, RenderedBlock>(budget, (v) => v.html.length * 2);
}
