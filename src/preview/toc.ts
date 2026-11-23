// src/preview/toc.ts — table of contents (SPEC §5.7). DOM identity is keyed on level+text: an edit
// that only shifts lines patches data-line in place, an edit that changes headings touches only the
// differing entries (prefix/suffix reconcile). No layout reads on the keystroke path: the active item
// is revealed (one offsetTop read + scrollIntoView) only when the cursor really moves to another
// heading. Two things keep a huge outline cheap: a full (re)build is sliced across frames, and while a
// very large outline is collapsed the levels ≥ 3 get no element at all.
import { MOUNT_SLICE_MS, type CreateToc, type Line, type OutlineEntry, type TocApi } from '../shared/types';

/** Teardown hook for the frozen `TocApi` shape (side table, like `disposeToolbar`/`disposeTheme`). */
const extras = new WeakMap<TocApi, { dispose(): void }>();

/** Removes the nav, its click listener and any in-flight build/reveal frame. Idempotent. */
export function disposeToc(toc: TocApi): void {
  extras.get(toc)?.dispose();
  extras.delete(toc);
}

const COLLAPSE_THRESHOLD = 3000;
/** Deepest level materialized while a very large outline is collapsed. */
const COLLAPSED_MAX_LEVEL = 2;
const EXPAND_LABEL = '展开全部层级';
const COLLAPSE_LABEL = '仅显示一、二级';
/** A full (re)build of more than this many entries is created in ≤ MOUNT_SLICE_MS frame slices. */
const SLICE_ABOVE = 600;
/** Entries per time check inside a build slice (the check itself must not dominate). */
const SLICE_STEP = 64;
/** Hard cap of items created per frame. `makeItem` is cheap enough that an 8 ms script budget covers
 *  ~12k anchors, whose style + layout then costs ~100 ms in the same frame — the cap bounds that too. */
const SLICE_MAX_ITEMS = 1000;

function makeItem(e: OutlineEntry): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = `mdr-toc__item mdr-toc__item--h${e.level}`;
  a.href = '#' + e.slug;
  a.dataset.line = String(e.line);
  a.textContent = e.text;
  a.title = e.text;
  return a;
}

const sameKey = (a: OutlineEntry, b: OutlineEntry): boolean => a.level === b.level && a.text === b.text;

export const createToc: CreateToc = (parent, bus) => {
  const nav = document.createElement('nav');
  nav.className = 'mdr-toc';
  parent.appendChild(nav);

  let entries: OutlineEntry[] = [];
  /** Aligned with `entries`; `undefined` for an entry that has no element (sliced build, hidden level). */
  let items: Array<HTMLAnchorElement | undefined> = [];
  let lines = new Int32Array(0);
  /** Slug currently written into each item's href, aligned with `entries` (so a dedupe suffix that moved
   *  is noticed even when the entry's level+text key did not change). */
  let slugs: Array<string | undefined> = [];
  let activeEl: HTMLAnchorElement | null = null;
  let activeLine: Line = 1;
  let visible = true;
  let collapsed = false;
  let expandBtn: HTMLButtonElement | null = null;
  /** Next index a sliced build must create; `-1` when no build is in progress. */
  let buildCursor = -1;
  let buildRaf = 0;

  /**
   * Whether an outline of `count` entries is shown collapsed: above the threshold the toggle exists and
   * the user's choice decides, and a list that is only now crossing the threshold starts collapsed.
   * While collapsed, levels ≥ 3 get no element at all — a 20k-heading document would otherwise put 20k
   * anchors into the DOM (and into the load's style + layout) only to hide two thirds of them with CSS.
   */
  function collapsedFor(count: number): boolean {
    return count > COLLAPSE_THRESHOLD ? (expandBtn ? collapsed : true) : false;
  }
  /** True when `items` is (or is about to be) sparse because deep levels are hidden. */
  const deepHidden = (count: number): boolean => collapsedFor(count);
  const wanted = (e: OutlineEntry): boolean => !collapsed || e.level <= COLLAPSED_MAX_LEVEL;

  function setCollapsed(on: boolean, rebuild = false): void {
    const changed = collapsed !== on;
    collapsed = on;
    nav.classList.toggle('mdr-toc--collapsed', on);
    if (expandBtn) expandBtn.textContent = on ? EXPAND_LABEL : COLLAPSE_LABEL;
    // Toggling changes which entries have an element, so the list is rebuilt (a rare, deliberate action).
    if (rebuild && changed && entries.length > COLLAPSE_THRESHOLD) fullBuild(entries);
  }

  function onClick(e: MouseEvent): void {
    const t = e.target as Element | null;
    if (!t) return;
    if (t.closest('.mdr-toc__expand')) {
      setCollapsed(!collapsed, true);
      return;
    }
    const a = t.closest<HTMLAnchorElement>('a[data-line]');
    if (!a) return;
    e.preventDefault();
    bus.emit('nav:gotoLine', { line: Number(a.dataset.line), source: 'toc' });
  }
  nav.addEventListener('click', onClick);

  /** The expand/collapse toggle exists only for very large outlines; collapsing applies when it appears. */
  function syncCollapseToggle(count: number): void {
    const many = count > COLLAPSE_THRESHOLD;
    if (many && !expandBtn) {
      expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'mdr-toc__expand';
      nav.prepend(expandBtn);
      setCollapsed(true);
    } else if (!many && expandBtn) {
      expandBtn.remove();
      expandBtn = null;
      setCollapsed(false);
    }
  }

  /** Rewrites an existing item to `e` without touching classes that are not the level (e.g. `is-active`). */
  function patchItem(a: HTMLAnchorElement, prev: OutlineEntry, e: OutlineEntry): void {
    if (prev.level !== e.level) {
      a.classList.remove(`mdr-toc__item--h${prev.level}`);
      a.classList.add(`mdr-toc__item--h${e.level}`);
    }
    a.textContent = e.text;
    a.title = e.text;
  }

  // ------------------------------------------------------------------ sliced full build
  function cancelBuild(): void {
    if (buildRaf) cancelAnimationFrame(buildRaf);
    buildRaf = 0;
    buildCursor = -1;
  }

  /** Creates the still missing items of a full build, in order, within one frame slice. */
  function buildStep(): void {
    buildRaf = 0;
    const n = entries.length;
    const t0 = performance.now();
    const frag = document.createDocumentFragment();
    let made = 0;
    while (buildCursor < n) {
      const e = entries[buildCursor];
      if (wanted(e)) {
        const a = makeItem(e);
        items[buildCursor] = a;
        slugs[buildCursor] = e.slug;
        frag.appendChild(a);
      }
      buildCursor++;
      if (++made >= SLICE_MAX_ITEMS) break;
      if (made % SLICE_STEP === 0 && performance.now() - t0 >= MOUNT_SLICE_MS) break;
    }
    nav.appendChild(frag);
    if (buildCursor < n) buildRaf = requestAnimationFrame(buildStep);
    else buildCursor = -1;
    activate(activeLine, false);   // the active heading may only now have an element
  }

  /** Drops every item and (re)builds the whole list; large lists are sliced across frames. */
  function fullBuild(next: OutlineEntry[]): void {
    cancelBuild();
    nav.replaceChildren();
    if (expandBtn) nav.appendChild(expandBtn);   // items are appended after it, so it stays first
    activeEl = null;
    revealed = null;
    entries = next;
    // `wanted` must already know whether deep levels are hidden before anything is created.
    collapsed = collapsedFor(next.length);
    nav.classList.toggle('mdr-toc--collapsed', collapsed);
    items = new Array(next.length);
    slugs = new Array(next.length);
    lines = new Int32Array(next.length);
    for (let i = 0; i < next.length; i++) lines[i] = next[i].line;
    syncCollapseToggle(next.length);
    buildCursor = 0;
    if (next.length > SLICE_ABOVE) buildStep();
    else {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < next.length; i++) {
        if (!wanted(next[i])) continue;
        frag.appendChild((items[i] = makeItem(next[i])));
        slugs[i] = next[i].slug;
      }
      nav.appendChild(frag);
      buildCursor = -1;
      activate(activeLine, false);
    }
  }

  /** Patches the DOM to `next`: unchanged (level, text) entries keep their element. */
  function reconcile(next: OutlineEntry[]): void {
    const prev = entries;
    const nOld = prev.length, nNew = next.length;
    const minLen = Math.min(nOld, nNew);
    let p = 0;
    while (p < minLen && sameKey(prev[p], next[p])) p++;
    let s = 0;
    while (s < minLen - p && sameKey(prev[nOld - 1 - s], next[nNew - 1 - s])) s++;
    const structural = p + s < nNew || p + s < nOld;

    if (structural) {
      // fullBuild is the only path that works on a sparse `items`, and the only one that can slice.
      if (buildCursor >= 0                                                   // a sliced build is in flight
        || (p === 0 && s === 0 && Math.max(nNew, nOld) > SLICE_ABOVE)        // full replacement, worth slicing
        || (nOld !== nNew && (deepHidden(nOld) || deepHidden(nNew)))) {      // insert/remove in a sparse list
        fullBuild(next);
        return;
      }
      if (nOld === nNew) {
        // Same shape: rewrite the differing entries in place (typing inside a heading).
        for (let i = p; i < nNew - s; i++) {
          if (sameKey(prev[i], next[i])) continue;
          const a = items[i];
          if (a && wanted(next[i])) patchItem(a, prev[i], next[i]);
          else if (a) { a.remove(); items[i] = undefined; slugs[i] = undefined; }
          else if (wanted(next[i])) { fullBuild(next); return; }   // a hidden level became visible
        }
      } else {
        const frag = document.createDocumentFragment();
        const fresh: HTMLAnchorElement[] = new Array(nNew - s - p);
        for (let i = p; i < nNew - s; i++) frag.appendChild((fresh[i - p] = makeItem(next[i])));
        const ref = s > 0 ? items[nOld - s]! : null;
        for (let i = p; i < nOld - s; i++) items[i]!.remove();
        nav.insertBefore(frag, ref);
        items = [...items.slice(0, p), ...fresh, ...items.slice(nOld - s)];
        // `lines` / `slugs` are index-aligned with `items`: shift them the same way so the prefix and the
        // suffix keep their "already applied" values and only really changed attributes are written.
        const nl = new Int32Array(nNew);
        nl.set(lines.subarray(0, p), 0);
        nl.set(lines.subarray(nOld - s), nNew - s);
        lines = nl;
        slugs = [...slugs.slice(0, p), ...new Array<undefined>(nNew - s - p), ...slugs.slice(nOld - s)];
      }
    }

    // Lines and slugs may have shifted anywhere (a dedupe suffix moves without the level+text key
    // changing): patch attributes only where the applied value differs.
    if (lines.length !== nNew) lines = new Int32Array(nNew);
    if (slugs.length !== nNew) slugs = new Array(nNew);
    for (let i = 0; i < nNew; i++) {
      const e = next[i], a = items[i];
      if (lines[i] !== e.line) {
        lines[i] = e.line;
        if (a) a.dataset.line = String(e.line);
      }
      if (slugs[i] !== e.slug) {
        slugs[i] = e.slug;
        if (a) a.href = '#' + e.slug;
      }
    }
    entries = next;
    syncCollapseToggle(nNew);
  }

  function indexForLine(line: Line): number {
    let lo = 0, hi = lines.length - 1;
    if (hi < 0 || lines[0] > line) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid] <= line) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Scrolls the active item into view when it is outside the nav's visible box (one layout read). */
  function revealActive(): void {
    if (!visible || !activeEl || nav.clientHeight === 0) return;
    const top = activeEl.offsetTop, bottom = top + activeEl.offsetHeight;
    const viewTop = nav.scrollTop, viewBottom = viewTop + nav.clientHeight;
    if (top < viewTop || bottom > viewBottom) activeEl.scrollIntoView({ block: 'nearest' });
  }

  /** The reveal is rAF-coalesced: an outline message can land before the (rAF-coalesced) cursor event of
   *  the same keystroke, moving the active item for a moment — no layout read unless it really changed. */
  let revealRaf = 0;
  let revealed: HTMLAnchorElement | null = null;
  function scheduleReveal(): void {
    if (revealRaf) return;
    revealRaf = requestAnimationFrame(() => {
      revealRaf = 0;
      if (activeEl === revealed) return;
      revealed = activeEl;
      revealActive();
    });
  }

  /**
   * Highlights the last entry at or before `line`. `reveal` is true only when the cursor moved
   * (`setActiveLine`): an outline message — including the first one of a document — must never scroll the
   * nav, and the offsetTop read that decides it costs a full layout of the list (38 ms for a 50k-heading
   * outline, all of it inside the load's long task).
   */
  function activate(line: Line, reveal: boolean): void {
    activeLine = line;
    const idx = indexForLine(line);
    const next = (idx >= 0 ? items[idx] : null) ?? null;
    // `next === activeEl` is not enough on its own: a reconcile may have rewritten the element, so make
    // sure the class is really there before short-circuiting.
    if (next === activeEl && (!next || next.classList.contains('is-active'))) return;
    activeEl?.classList.remove('is-active');
    activeEl = next;
    if (!next) return;
    next.classList.add('is-active');
    // `revealed` is left alone otherwise: a reveal already scheduled by a cursor move still applies to
    // the item this (outline-driven) activation settled on — that coalescing keeps typing layout-free.
    if (reveal) scheduleReveal();
  }

  const api: TocApi = {
    setOutline(next) {
      reconcile(next);
      activate(activeLine, false);   // the cursor did not move: keep its heading highlighted
    },
    setActiveLine: (line) => activate(line, true),
    setVisible(on) {
      visible = on;
      nav.hidden = !on;
      if (on && activeEl) { revealed = null; scheduleReveal(); }
    },
  };
  extras.set(api, {
    dispose() {
      cancelBuild();
      if (revealRaf) cancelAnimationFrame(revealRaf);
      revealRaf = 0;
      nav.removeEventListener('click', onClick);
      nav.remove();
    },
  });
  return api;
};
