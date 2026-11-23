// src/editor/palette.ts — command palette overlay (SPEC §7). Reads registry.list() on every open,
// fuzzy (subsequence) matches over title + id, keyboard navigation, restores focus on close.
import type { Command, CreatePalette, PaletteApi } from '../shared/types';
import { formatShortcut } from '../shared/keys';
import { T } from '../shared/i18n';

/** PaletteApi (shared/types) is frozen, so disposal is reached through this side table. */
const extras = new WeakMap<PaletteApi, { dispose(): void }>();

/** Removes the palette element and every listener it installed (no-op for an unknown palette). */
export function disposePalette(palette: PaletteApi): void {
  extras.get(palette)?.dispose();
}

const PLACEHOLDER = '输入命令名称…';
const EMPTY = '没有匹配的命令';

/**
 * Subsequence match score: lower is better, -1 = no match. Contiguous and early matches score best.
 */
export function fuzzyScore(query: string, text: string): number {
  if (query.length === 0) return 0;
  let score = 0;
  let last = -1;
  for (const ch of query) {
    const i = text.indexOf(ch, last + 1);
    if (i < 0) return -1;
    score += i - last - 1;
    last = i;
  }
  return score;
}

export function filterCommands(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  return cmds
    .map((c) => ({ c, s: fuzzyScore(q, `${c.title} ${c.id}`.toLowerCase()) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.c);
}

export const createPalette: CreatePalette = (parent, registry) => {
  const doc = parent.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'mdr-palette';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', T.palette);

  const box = doc.createElement('div');
  box.className = 'mdr-palette__box';
  const input = doc.createElement('input');
  input.className = 'mdr-palette__input';
  input.type = 'text';
  input.placeholder = PLACEHOLDER;
  input.setAttribute('aria-label', T.palette);
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = doc.createElement('ul');
  list.className = 'mdr-palette__list';
  list.setAttribute('role', 'listbox');
  box.append(input, list);
  root.appendChild(box);
  parent.appendChild(root);

  let items: Command[] = [];
  let active = 0;
  let prevFocus: HTMLElement | null = null;

  const render = (): void => {
    list.replaceChildren();
    if (items.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'mdr-palette__empty';
      empty.textContent = EMPTY;
      list.appendChild(empty);
      return;
    }
    items.forEach((c, i) => {
      const li = doc.createElement('li');
      li.className = 'mdr-palette__item';
      li.dataset.cmd = c.id;
      li.setAttribute('role', 'option');
      if (i === active) li.classList.add('is-active');
      if (c.enabled?.() === false) li.classList.add('is-disabled');
      const title = doc.createElement('span');
      title.className = 'mdr-palette__title';
      title.textContent = c.title;
      li.appendChild(title);
      if (c.shortcut) {
        const key = doc.createElement('kbd');
        key.className = 'mdr-palette__key';
        key.textContent = formatShortcut(c.shortcut);
        li.appendChild(key);
      }
      list.appendChild(li);
    });
  };

  const setActive = (i: number, reveal = true): void => {
    if (items.length === 0) return;
    active = (i + items.length) % items.length;
    list.querySelectorAll('.mdr-palette__item').forEach((el, j) => el.classList.toggle('is-active', j === active));
    if (reveal) (list.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  };

  const filter = (): void => {
    items = filterCommands(registry.list(), input.value);
    active = 0;
    render();
  };

  const close = (): void => {
    if (root.hidden) return;
    root.hidden = true;
    restoreFocus();
  };

  /**
   * A focus target is usable only if it is still in the document and is not the body/root: clicking the
   * preview leaves document.activeElement === body, and focusing the body again would silently kill
   * every editor-scope shortcut until the user clicks the editor. Such a target falls back to the editor.
   */
  const focusable = (el: HTMLElement | null): boolean =>
    !!el && el.isConnected && el !== doc.body && el !== doc.documentElement && typeof el.focus === 'function';

  const restoreFocus = (): void => {
    const target = focusable(prevFocus) ? prevFocus : (doc.querySelector('.cm-editor .cm-content') as HTMLElement | null);
    prevFocus = null;
    target?.focus();
  };

  const runActive = (): void => {
    const cmd = items[active];
    if (!cmd || cmd.enabled?.() === false) return;
    close();
    registry.run(cmd.id);
  };

  const open = (): void => {
    if (!root.hidden) return;
    prevFocus = doc.activeElement as HTMLElement | null;
    input.value = '';
    root.hidden = false;
    filter();
    input.focus();
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': setActive(active + 1); break;
      case 'ArrowUp': setActive(active - 1); break;
      case 'Enter': runActive(); break;
      case 'Escape': close(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  const indexOfItem = (target: EventTarget | null): number => {
    const li = (target as HTMLElement | null)?.closest?.<HTMLElement>('.mdr-palette__item');
    return li ? Array.prototype.indexOf.call(list.children, li) : -1;
  };

  const onClick = (e: MouseEvent): void => {
    const i = indexOfItem(e.target);
    if (i < 0) return;
    active = i;
    runActive();
  };
  // The pointer moves the selection so the :hover highlight and the Enter target are the same item.
  const onHover = (e: MouseEvent): void => {
    const i = indexOfItem(e.target);
    if (i >= 0 && i !== active) setActive(i, false);
  };
  // Click on the backdrop (outside the box) closes.
  const onBackdrop = (e: MouseEvent): void => {
    if (e.target === root) {
      e.preventDefault();
      close();
    }
  };
  list.addEventListener('click', onClick);
  list.addEventListener('mousemove', onHover);
  list.addEventListener('mouseover', onHover);
  root.addEventListener('mousedown', onBackdrop);

  const api: PaletteApi = { open, close, isOpen: () => !root.hidden };
  extras.set(api, {
    dispose() {
      list.removeEventListener('click', onClick);
      list.removeEventListener('mousemove', onHover);
      list.removeEventListener('mouseover', onHover);
      root.removeEventListener('mousedown', onBackdrop);
      root.remove();
      items = [];
      prevFocus = null;
    },
  });
  return api;
};
