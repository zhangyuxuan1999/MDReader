// src/preview/interactions.ts — delegated listeners on the preview scroller (SPEC §5.6):
// task checkbox write-back, Alt+click to source, #anchor / relative / external links, and the
// focus line (CONTRACT §9): a click or a text selection in this pane tints the line here and mirrors
// it into the editor over the bus.
import { T } from '../shared/i18n';
import type { EventBus, Line, OutlineEntry } from '../shared/types';
import { slugify } from '../shared/slug';

export interface InteractionDeps {
  bus: EventBus;
  /** Tint this line in the preview itself (the bus event mirrors it into the editor). */
  setFocusLine(line: Line): void;
  /** The line the preview is tinting right now (null when nothing is). The selection path dedupes
   *  against THIS rather than a private copy: when the editor takes the focus line over, the preview's
   *  tint moves with it, and re-selecting the old line must count as a fresh gesture again. */
  currentFocusLine(): Line | null;
  /** Absolute start line of the block wrapper with this id, or undefined if unknown. */
  startLineOf(id: number): Line | undefined;
  /** Line count of the block with this id, or undefined if unknown (CONTRACT §11, U16: a checkbox toggles only a line of
   *  its own block). Optional: without it only the start of the range is checked. */
  lineCountOf?(id: number): number | undefined;
  /** The source text of this 1-based line ('' when there is none) (U16: only a task-item line is toggled). Optional:
   *  without it the line is not read here (the editor's toggle still changes only a task line). */
  sourceLine?(line: Line): string;
  /** Does the mounted HTML of the block with this id show its current source lines, and does the preview's structure
   *  describe the current source (CONTRACT §11, U24 note)? Optional: without it the structure is trusted. A checkbox of a
   *  block that is not current toggles nothing (its data-l and the block's start line may name another line now). */
  isCurrent?(id: number): boolean;
  /** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions): THE answer for a click on this task checkbox
   *  (createPreview's taskLine, which asks taskLineIn below). When present, the tick asks only this (startLineOf,
   *  lineCountOf and isCurrent then serve the focus line and Alt+click alone); a host without it (unit-test hosts) gets
   *  taskLineIn with its line deps as the triple. */
  taskLine?(input: HTMLInputElement): TaskAnswer;
  outline(): OutlineEntry[];
  /** Is this element inside the block being edited in the preview (CONTRACT §11)? There a plain click on a
   *  link places the caret (⌘/Ctrl-click opens it) and checkboxes are handled by the session. */
  isEditing?(target: Element): boolean;
}

/** The only schemes a link in the preview opens, and always outside the app (CONTRACT §11, S3). */
const OPEN_EXTERNALLY = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** The absolute URL to open outside the app for this href, or null: a relative or protocol-relative href, or any
 *  scheme but http / https / mailto / tel (javascript:, data:, file:, app:, blob:, …), opens nothing. The URL parser
 *  strips what the browser strips (surrounding spaces, tabs and newlines inside), so the test sees the real scheme. */
export function externalUrl(href: string): string | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  return OPEN_EXTERNALLY.has(u.protocol) ? u.href : null;
}

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** The hyperlink a click on `target` activates, up to the preview element, with its href; null when there is none.
 *  Links: HTML a and area, SVG a (href, else xlink:href), a MathML element with href. The walk goes on past an a
 *  without a destination, because an enclosing SVG a still navigates on that click. */
function linkOf(target: Element, root: Element): { link: Element; href: string } | null {
  for (let e: Element | null = target; e && e !== root; e = e.parentElement) {
    let href: string | null = null;
    if (e.localName === 'a' || e.localName === 'area') href = e.getAttribute('href') ?? e.getAttributeNS(XLINK_NS, 'href');
    else if (e.namespaceURI === MATHML_NS) href = e.getAttribute('href');
    if (href !== null) return { link: e, href };
  }
  return null;
}


/** Resolves a `#fragment` to a line via the outline: exact slug, normalised slug, then prefix match. */
export function resolveAnchor(items: OutlineEntry[], fragment: string): Line | undefined {
  let raw = fragment;
  try { raw = decodeURIComponent(fragment); } catch { /* keep as-is */ }
  const exact = items.find((e) => e.slug === raw);
  if (exact) return exact.line;
  const norm = slugify(raw);
  if (!norm) return undefined;
  const hit = items.find((e) => e.slug === norm) ?? items.find((e) => e.slug.startsWith(norm + '-'));
  return hit?.line;
}

/** A task-item line of the source: blockquote markers and indentation, a list marker, then [ ], [x] or [X] (the shape
 *  the editor's task toggle flips: TASK_RE in src/editor/commands.ts). */
const TASK_LINE = /^(?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]/;

/** U24 (CONTRACT §11, Checkpoint-C decisions, RVT-3): is `box` the checkbox the task-list renderer made for its item?
 *  The ONE test, asked by the tick (taskLineOf) and by the count of a block's task boxes (inlineEdit taskBoxes). By
 *  structure: markdown-it-task-lists marks the item `task-list-item` and emits its box as the first token of the item's
 *  first paragraph, before any of the item's text; whatever HTML the document has in the item comes after it, and the
 *  HTML parser never places a later node before an earlier one (it may wrap the box in formatting elements an
 *  earlier item left open, which is why this is not a parent / first-child test). So the item's own box is the FIRST
 *  checkbox inside its nearest <li>, and a document's checkbox inside a task item never is. The item is the worker's:
 *  a data-l that came from the document flags its block (U10), and the data-l the worker injects into the first tag
 *  of an HTML block names that block's first line, which is never a task line (taskLineOf reads it). */
export function ownTaskBox(box: HTMLInputElement): boolean {
  const li = box.closest('li');
  return !!li && li.hasAttribute('data-l') && li.classList.contains('task-list-item')
    && li.querySelector('input[type="checkbox"]') === box;
}

/** The block wrapper that holds `e`: the OUTERMOST `.md-block` below the preview root. A document's raw HTML can put a
 *  `.md-block` inside a block (U15 flags that block), never around one. */
function wrapperOf(e: Element, root: Element): HTMLElement | null {
  let w: HTMLElement | null = null;
  for (let p: Element | null = e; p && p !== root; p = p.parentElement) if (p.classList.contains('md-block')) w = p as HTMLElement;
  return w;
}

/** The toast of a task click that ticked nothing because the line it stands for is gone or cannot be known (U16 as
 *  amended a second time), and of a waiting click given up (inlineEdit). */
export const TASK_NOT_TICKED_TEXT = '没有勾选：该任务项刚被改动，请再点一次';

/** U16 (Checkpoint-D decisions): what the HTML in a block's wrapper shows: the block's `n` lines as they were in source
 *  version `v`, where the block started at line `s`. */
export interface TaskStamp { v: number; s: Line; n: number }
/** The five answers for a click on a task checkbox: a source line (ticked at once); 'none' (the box names no line:
 *  cancelled silently); 'wait' (a block a session has just released: the wait of U16 as first amended takes it);
 *  'gone' and 'unknown' (cancelled, with the toast TASK_NOT_TICKED_TEXT). */
export type TaskAnswer = Line | 'none' | 'wait' | 'gone' | 'unknown';
/** What taskLineIn asks its host (createPreview). */
export interface TaskQueries {
  /** What the HTML in block wrapper `w` shows, or 'wait' / 'unknown' when that cannot be said now ('none': a host
   *  without stamps, for a block it does not know or that is not current). */
  shown(w: HTMLElement): TaskStamp | 'wait' | 'unknown' | 'none';
  /** The source's current version (the version a line of `shown` must be mapped to). */
  current(): number;
  /** PreviewSourceAccess.lineNow; absent: a stamp of another version cannot be mapped. */
  lineNow?(line: Line, version: number): Line | null | undefined;
  /** The source text of a line; absent: the line is not read (the editor's toggle still changes only a task line). */
  sourceLine?(line: Line): string;
}

/** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions) — THE function that says which source line a
 *  click on this task checkbox ticks, asked through createPreview's taskLine by every listener of the click (the edit
 *  session's capture listener, onClick, onChange). 'none' first: not its task item's own box (ownTaskBox, U24 RVT-3),
 *  a flagged block (U10), no line offset of digits in the item's data-l, an offset outside the block's lines (U16).
 *  Then the triple of the HTML (shown): line = s + offset of version v, mapped through lineNow when v is not the
 *  source's current version (null: 'gone'; undefined or no lineNow: 'unknown'), and still a task line of the source
 *  (TASK_LINE, which also refuses an HTML block whose first tag forges the item's class: its data-l names the block's
 *  first line, never a task line), else 'gone' for a mapped line and 'none' for a line that was not mapped (CHC-3: a
 *  box that never named a task line, "- - [ ] x", is cancelled silently, as before the round). */
export function taskLineIn(input: HTMLInputElement, root: Element, q: TaskQueries): TaskAnswer {
  if (!ownTaskBox(input)) return 'none';
  const w = wrapperOf(input, root);
  if (!w || w.hasAttribute('data-mdr-x')) return 'none';
  const li = input.closest<HTMLElement>('li');
  const rel = li?.dataset.l ?? '';
  if (!li || !w.contains(li) || !/^\d+$/.test(rel)) return 'none';   // the worker writes a line offset: digits only
  const sh = q.shown(w);
  if (typeof sh === 'string') return sh;
  if (Number(rel) >= sh.n) return 'none';
  let line: Line | null | undefined = sh.s + Number(rel);
  const mapped = sh.v !== q.current();
  if (mapped) {
    line = q.lineNow ? q.lineNow(line, sh.v) : undefined;
    if (line === undefined) return 'unknown';
    if (line === null) return 'gone';
  }
  // Checkpoint-E decisions (CHC-3): a line that was not mapped is the source as the box shows it; when TASK_LINE does
  // not recognise it, the box never named a task line: 'none' (cancelled silently). 'gone' is for a mapped line.
  if (q.sourceLine && !TASK_LINE.test(q.sourceLine(line))) return mapped ? 'gone' : 'none';
  return line;
}

/** Absolute line for an element: block start + nearest `data-l` (0-based, relative). The block is the outermost
 *  wrapper (`wrapperOf`), as for a checkbox: a `.md-block` the document forged inside a block names no block. */
function lineOfElement(target: Element, root: Element, deps: InteractionDeps): Line | undefined {
  const block = wrapperOf(target, root);
  if (!block) return undefined;
  const start = deps.startLineOf(Number(block.dataset.id));
  if (start === undefined) return undefined;
  const marked = target.closest<HTMLElement>('[data-l]');
  const rel = marked && block.contains(marked) ? Number(marked.dataset.l) : 0;
  return start + (Number.isFinite(rel) ? rel : 0);
}

export function attachInteractions(el: HTMLElement, deps: InteractionDeps): () => void {
  const doc = el.ownerDocument;
  // ---- focus line: tint here, mirror there. Never scrolls, never moves the caret, never takes focus.
  /** Only the selection path skips an unchanged line (a click always re-announces, because the editor
   *  may have cleared its mirror in between); "unchanged" is measured against what the preview actually
   *  tints, so a line the editor took over in the meantime is announced again. */
  const focusOn = (target: Element | null, skipUnchanged: boolean): void => {
    if (!target) return;
    const line = lineOfElement(target, el, deps);
    if (line === undefined || (skipUnchanged && line === deps.currentFocusLine())) return;
    deps.setFocusLine(line);
    deps.bus.emit('focus:line', { line, source: 'preview' });
  };

  // A non-collapsed selection whose anchor is inside the preview focuses the anchor's line. rAF-coalesced:
  // dragging across a paragraph fires `selectionchange` per mouse move, and all but the first are dropped
  // by the unchanged-line test above.
  let selRaf = 0;
  /** The anchor element of a non-collapsed selection inside this pane, else null. No layout is read
   *  (`contains` walks parents), so this is cheap enough to run on every `selectionchange` — including
   *  the ones the editor's own caret fires, which must not schedule a frame here at all. */
  const selectionAnchor = (): Element | null => {
    const sel = el.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const anchor = sel.anchorNode;
    const node = anchor === null ? null : anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    return node && el.contains(node) ? node : null;
  };
  const runSelection = (): void => {
    selRaf = 0;
    focusOn(selectionAnchor(), true);
  };
  const onSelectionChange = (): void => {
    if (selRaf || !selectionAnchor()) return;
    selRaf = requestAnimationFrame(runSelection);
  };

  /** U16 as amended a second time (CONTRACT §11, Checkpoint-D decisions): the answer for a click on this task checkbox —
   *  the host's (createPreview taskLine), else taskLineIn with this host's line deps as the triple (a block that is not
   *  current, or that the structure does not know, names no line here: the behaviour of hosts without stamps). */
  const legacyQueries: TaskQueries = {
    shown(w) {
      const id = Number(w.dataset.id);
      const s = deps.isCurrent && !deps.isCurrent(id) ? undefined : deps.startLineOf(id);
      return s === undefined ? 'none' : { v: 0, s, n: deps.lineCountOf ? deps.lineCountOf(id) ?? 0 : Infinity };
    },
    current: () => 0,
    ...(deps.sourceLine ? { sourceLine: deps.sourceLine } : {}),
  };
  const taskLineOf = (input: HTMLInputElement): TaskAnswer => {
    if (deps.taskLine) return deps.taskLine(input);
    const a = taskLineIn(input, el, legacyQueries);
    return typeof a === 'number' ? a : 'none';
  };

  // ---- U24 (CONTRACT §11, J13; as amended: OFFC-1, RVT-4): a task is ticked only by a click that hit its checkbox
  // itself. A click a <label> forwards to its control (wrapping it, or for= naming it, from anywhere on the page)
  // reaches the checkbox as a trusted click with the same detail, but it always comes after the label's own click,
  // and onCheckClick below, which sees EVERY click of the document first (capture phase on the document; no path
  // leaves it before its last two lines), clears the remembered press and key at its end: a forwarded click never
  // finds the press on the checkbox. That clearing is the one thing this rule rests on. So a click on a checkbox
  // counts when the last press in the document went down on that checkbox and no click came between (whatever the
  // click's coordinates: a press that went down on the box is the hit), or, for a key (detail 0), when the key went
  // down on the focused checkbox itself and its focus was not given by a refused forwarded click. Any other click on
  // a checkbox is cancelled and stopped before any other listener (the edit session's included) sees it: the box
  // keeps what the source says, no change event follows, nothing replays it.
  /** Target of the last press (pointerdown / mousedown) anywhere in the document; replaced by the next press and
   *  cleared by the next click, by nothing else (a key between press and release, Shift or Escape, keeps it). */
  let pressOn: EventTarget | null = null;
  /** Target of the last keydown, when no press came after it; cleared by a click. */
  let keyOn: EventTarget | null = null;
  /** A checkbox that a refused forwarded click focused (the label focuses its control first): a key on it ticks nothing
   *  until it loses the focus. */
  let focusGiven: Element | null = null;
  /** A click that hit its checkbox: the session's replay of it (inlineEdit replayToggle, `input.click()`, an untrusted
   *  click no document can produce) counts once within REPLAY_MS — on that checkbox, or (U16 amended) on the one the
   *  session identified as the same task after a re-render replaced the element that was hit. REPLAY_MS is longer than
   *  the bound of that wait (inlineEdit: RESUME_MS 2.5 s, extended three times: 10 s). */
  let granted: { input: HTMLInputElement; until: number } | null = null;
  const REPLAY_MS = 11000;
  const onPress = (e: Event): void => { pressOn = e.target; keyOn = null; };
  const onKey = (e: Event): void => { keyOn = e.target; };
  const onFocusOut = (e: Event): void => { if (e.target === focusGiven) focusGiven = null; };
  const hitsBox = (input: HTMLInputElement, e: MouseEvent): 'direct' | 'replay' | null => {
    if (!e.isTrusted && granted && (granted.input === input || !granted.input.isConnected) && performance.now() <= granted.until) { granted = null; return 'replay'; }
    if (e.detail === 0 && keyOn === input && focusGiven !== input) return 'direct';
    return pressOn === input ? 'direct' : null;
  };
  const onCheckClick = (e: MouseEvent): void => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'checkbox' && el.contains(t)) {
      const hit = hitsBox(t, e);
      if (hit === 'direct') granted = { input: t, until: performance.now() + REPLAY_MS };
      else if (hit === null) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (granted?.input === t) granted = null;
        if (doc.activeElement === t) focusGiven = t;
      }
    }
    pressOn = null;
    keyOn = null;
  };

  const onChange = (e: Event): void => {
    const input = e.target as HTMLElement | null;
    if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
    if (deps.isEditing?.(input)) return;   // the edit session serializes the new state itself
    const line = taskLineOf(input);           // (the same answer as the click's: nothing changed in between)
    if (typeof line === 'number') deps.bus.emit('source:edit', { kind: 'toggleTask', line });
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    if (!target) return;
    // Primary button, no Ctrl/Meta (those are "open in a new tab" on a link, not "I am reading here").
    // Alt+click keeps its gotoLine behaviour below AND tints.
    if (e.button === 0 && !e.metaKey && !e.ctrlKey) focusOn(target, false);
    if (e.altKey) {
      const line = lineOfElement(target, el, deps);
      if (line === undefined) return;
      e.preventDefault();
      deps.bus.emit('nav:gotoLine', { line, source: 'preview' });
      return;
    }
    // U16 as amended a second time (Checkpoint-D decisions): a task checkbox whose click names a line goes through (the
    // browser shows the tick, onChange toggles that line). Any other answer cancels it, which keeps the box as the
    // source says (no change event follows): 'none' silently (a flagged block, U10; not a task item's own box or line,
    // U16, U24); 'gone' / 'unknown' with the toast, once per click; 'wait' silently here, because the edit session's
    // capture listener has begun its wait for this click (only it answers 'wait').
    if (target instanceof HTMLInputElement && target.type === 'checkbox' && !deps.isEditing?.(target)) {
      const a = taskLineOf(target);
      if (typeof a !== 'number') {
        e.preventDefault();
        if (a === 'gone' || a === 'unknown') deps.bus.emit('toast', { text: TASK_NOT_TICKED_TEXT, timeoutMs: 4000 });
        return;
      }
    }
    const found = linkOf(target, el);
    if (!found) return;
    const editing = !!deps.isEditing?.(found.link);
    if (!editing && opensItself(found.link, found.href)) return;
    // S3: no link in a document navigates the app window. Every other activation is cancelled here and routed below.
    e.preventDefault();
    // Editing: a click places the caret; ⌘/Ctrl-click still follows the link.
    if (editing && !(e.metaKey || e.ctrlKey)) return;
    follow(found.href);
  };

  /** An HTML link the sanitizer made a new-window link (target=_blank) to http / https / mailto / tel keeps the
   *  browser's own activation, as in 0.1.x: it opens a new window, never this one (the shell turns that into an
   *  external open). Every other link (SVG a, xlink:href, area, any other scheme, relative) is routed by `follow`. */
  const opensItself = (link: Element, href: string): boolean =>
    link.namespaceURI === XHTML_NS && link.localName === 'a' && link.getAttribute('target') === '_blank'
    && externalUrl(href) !== null;

  /** An in-document #anchor scrolls the editor; http / https / mailto / tel open outside the app; a relative link
   *  says it is unsupported; any other scheme does nothing. */
  const follow = (href: string): void => {
    if (href.startsWith('#')) {
      const line = resolveAnchor(deps.outline(), href.slice(1));
      if (line !== undefined) deps.bus.emit('nav:gotoLine', { line, source: 'link' });
      return;
    }
    const url = externalUrl(href);
    if (url !== null) el.ownerDocument.defaultView?.open(url, '_blank', 'noopener,noreferrer');
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(href.trim())) deps.bus.emit('toast', { text: T.relativeLinkUnsupported });
  };

  // The middle button activates a link through auxclick (a new tab or window): cancelled and routed the same way.
  const onAuxClick = (e: MouseEvent): void => {
    if (e.button !== 1 || !(e.target instanceof Element)) return;
    const found = linkOf(e.target, el);
    if (!found || (!deps.isEditing?.(found.link) && opensItself(found.link, found.href))) return;
    e.preventDefault();
    follow(found.href);
  };

  el.addEventListener('change', onChange);
  el.addEventListener('click', onClick);
  el.addEventListener('auxclick', onAuxClick);
  // `selectionchange` only ever fires on the document, so this one listener is not delegated to `el`.
  doc.addEventListener('selectionchange', onSelectionChange);
  // U24: presses and keys anywhere count (a press outside the preview is not a press on a checkbox); the click test runs
  // in the document's capture phase, before every listener of the preview and of the edit session.
  doc.addEventListener('click', onCheckClick, true);
  doc.addEventListener('pointerdown', onPress, true);
  doc.addEventListener('mousedown', onPress, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('focusout', onFocusOut, true);
  return () => {
    el.removeEventListener('change', onChange);
    el.removeEventListener('click', onClick);
    el.removeEventListener('auxclick', onAuxClick);
    doc.removeEventListener('selectionchange', onSelectionChange);
    doc.removeEventListener('click', onCheckClick, true);
    doc.removeEventListener('pointerdown', onPress, true);
    doc.removeEventListener('mousedown', onPress, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    if (selRaf) cancelAnimationFrame(selRaf);
    selRaf = 0;
  };
}
