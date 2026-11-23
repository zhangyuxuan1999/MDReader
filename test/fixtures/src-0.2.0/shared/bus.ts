// src/shared/bus.ts — tiny typed event bus. Handlers are isolated: one throwing handler never
// prevents the others from running (the error is reported via console.error).
import type { AppEvents, EventBus } from './types';

type Handler = (e: unknown) => void;

export function createBus(): EventBus {
  const map = new Map<keyof AppEvents, Set<Handler>>();
  return {
    on(key, fn) {
      let set = map.get(key);
      if (!set) {
        set = new Set();
        map.set(key, set);
      }
      const h = fn as Handler;
      set.add(h);
      return () => {
        set!.delete(h);
      };
    },
    emit(key, e) {
      const set = map.get(key);
      if (!set || set.size === 0) return;
      // Snapshot so handlers may unsubscribe (or subscribe) during dispatch.
      for (const h of Array.from(set)) {
        try {
          h(e);
        } catch (err) {
          console.error(`[bus] handler for "${String(key)}" threw`, err);
        }
      }
    },
  };
}
