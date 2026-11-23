// src/app/layout.ts — builds the app skeleton (CONTRACT §2), owns data-mode / data-toc and the
// gutter drag that sets --split (persisted in LS_SPLIT). Other modules mount into LayoutEls.
import { LS_SPLIT, type LayoutApi, type LayoutEls, type Mode } from '../shared/types';

const SPLIT_RE = /^\d+(\.\d+)?fr$/;
const MIN_FRACTION = 0.2;
const MAX_FRACTION = 0.8;

/** LayoutApi (shared/types) is frozen, so the teardown hook lives in a side table keyed by the instance
 *  (the same pattern as disposeTheme / disposeToolbar / disposePalette). */
const extras = new WeakMap<LayoutApi, { dispose(): void }>();

/** Removes every node `createLayout` appended and the attributes it set on `root`, so the root is left
 *  exactly as it was found and a second `createApp(root)` builds exactly one shell (no-op for an
 *  unknown layout). Callers dispose the modules mounted INTO the layout first. */
export function disposeLayout(layout: LayoutApi): void {
  extras.get(layout)?.dispose();
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = className;
  return e;
}

export function createLayout(root: HTMLElement): LayoutApi {
  const doc = root.ownerDocument;
  root.classList.add('mdr-app');
  root.dataset.mode = 'split';
  root.dataset.toc = 'open';

  const toolbar = el(doc, 'header', 'mdr-toolbar');
  const main = el(doc, 'div', 'mdr-main');
  const toc = el(doc, 'aside', 'mdr-pane mdr-pane--toc');
  const editor = el(doc, 'div', 'mdr-pane mdr-pane--editor');
  const gutter = el(doc, 'div', 'mdr-gutter');
  gutter.setAttribute('role', 'separator');
  gutter.setAttribute('aria-orientation', 'vertical');
  const preview = el(doc, 'div', 'mdr-pane mdr-pane--preview');
  const statusbar = el(doc, 'footer', 'mdr-statusbar');
  const overlay = el(doc, 'div', 'mdr-overlay');

  main.append(toc, editor, gutter, preview);
  root.append(toolbar, main, statusbar, overlay);

  try {
    const saved = localStorage.getItem(LS_SPLIT);
    if (saved && SPLIT_RE.test(saved)) root.style.setProperty('--split', saved);
  } catch {
    /* no persistence */
  }

  const els: LayoutEls = { toolbar, toc, editor, gutter, preview, statusbar, overlay };
  const api: LayoutApi = {
    els,
    setMode(m: Mode) {
      root.dataset.mode = m;
    },
    getMode: () => root.dataset.mode as Mode,
    setTocVisible(on) {
      root.dataset.toc = on ? 'open' : 'closed';
    },
    isTocVisible: () => root.dataset.toc !== 'closed',
  };
  extras.set(api, {
    dispose() {
      toolbar.remove();
      main.remove();
      statusbar.remove();
      overlay.remove();
      root.classList.remove('mdr-app');
      root.classList.remove('is-dragover');
      root.classList.remove('is-resizing');
      delete root.dataset.mode;
      delete root.dataset.toc;
      root.style.removeProperty('--split');
    },
  });
  return api;
}

/**
 * Pointer drag on the gutter resizes the editor/preview split. Geometry is read once on
 * pointerdown; moves are rAF-coalesced and only write the --split custom property.
 * `onResize` fires once at the end of a drag (App re-syncs scroll positions there).
 */
export function installSplitResize(root: HTMLElement, els: LayoutEls, onResize: () => void): () => void {
  const { gutter } = els;
  let left = 0;
  let width = 1;
  let frame = 0;
  let pendingX = 0;
  let dragging = false;

  const apply = (): void => {
    frame = 0;
    const f = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, (pendingX - left) / width));
    // editor is `--split` fr, preview is 1fr → editor fraction f ⇒ split = f / (1 − f)
    root.style.setProperty('--split', `${(f / (1 - f)).toFixed(3)}fr`);
  };

  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    pendingX = e.clientX;
    if (!frame) frame = requestAnimationFrame(apply);
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    if (frame) {
      cancelAnimationFrame(frame);
      apply();
    }
    root.classList.remove('is-resizing');
    gutter.classList.remove('is-dragging');
    try {
      localStorage.setItem(LS_SPLIT, root.style.getPropertyValue('--split'));
    } catch {
      /* no persistence */
    }
    onResize();
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // One-off layout read at drag start: the resizable span is [editor left, preview right].
    const editorRect = els.editor.getBoundingClientRect();
    const previewRect = els.preview.getBoundingClientRect();
    left = editorRect.left;
    width = Math.max(1, previewRect.right - editorRect.left - gutter.offsetWidth);
    dragging = true;
    root.classList.add('is-resizing');
    gutter.classList.add('is-dragging');
    gutter.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  gutter.addEventListener('pointerdown', onDown);
  gutter.addEventListener('pointermove', onMove);
  gutter.addEventListener('pointerup', onUp);
  gutter.addEventListener('pointercancel', onUp);
  return () => {
    gutter.removeEventListener('pointerdown', onDown);
    gutter.removeEventListener('pointermove', onMove);
    gutter.removeEventListener('pointerup', onUp);
    gutter.removeEventListener('pointercancel', onUp);
    // A drag interrupted by dispose() left one rAF scheduled, which would write --split onto a root
    // the app no longer owns.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    dragging = false;
  };
}
