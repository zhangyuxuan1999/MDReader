// test/editor.helpers.ts — minimal CommandRegistry for editor/toolbar/palette tests (E4 owns the real one).
import type { Command, CommandId, CommandRegistry } from '../src/shared/types';

export function createFakeRegistry(): CommandRegistry & { ran: CommandId[] } {
  const map = new Map<CommandId, Command>();
  const listeners = new Set<() => void>();
  const ran: CommandId[] = [];
  return {
    ran,
    register(c) {
      map.set(c.id, c);
      for (const fn of listeners) fn();
    },
    get: (id) => map.get(id),
    run(id) {
      const c = map.get(id);
      if (!c || c.enabled?.() === false) return false;
      ran.push(id);
      void c.run();
      return true;
    },
    list: () => [...map.values()],
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** jsdom has no layout: give CodeMirror's measure pass the Range/Element rect APIs it expects. */
export function installLayoutStubs(): void {
  const zero = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
  const rects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
  const g = globalThis as { Range?: { prototype: Range } };
  if (g.Range && typeof g.Range.prototype.getClientRects !== 'function') {
    g.Range.prototype.getClientRects = rects;
    g.Range.prototype.getBoundingClientRect = zero as unknown as () => DOMRect;
  }
}
