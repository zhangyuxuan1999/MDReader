// src/app/registry.ts — command registry shared by toolbar, palette, shortcuts and CM keymap.
// Registration is idempotent by id (re-registering replaces) and notifies onChange listeners
// synchronously so keymaps/toolbars can refresh.
import type { Command, CommandId, CommandRegistry } from '../shared/types';

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<CommandId, Command>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const fn of Array.from(listeners)) fn();
  };

  return {
    register(c) {
      commands.set(c.id, c);
      notify();
    },
    get: (id) => commands.get(id),
    run(id) {
      const c = commands.get(id);
      if (!c || c.enabled?.() === false) return false;
      try {
        const r = c.run();
        if (r instanceof Promise) r.catch((err: unknown) => console.error(`[registry] ${id} failed`, err));
      } catch (err) {
        console.error(`[registry] ${id} threw`, err);
      }
      return true;
    },
    list: () => Array.from(commands.values()),
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
