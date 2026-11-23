// src/preview/scrollSync.ts — editor ⇄ preview scroll synchronisation (SPEC §6). Master election by
// user input, echo guard via suppressUntil, one settle pass per follow, cursor-follow while typing.
import { SYNC_SUPPRESS_MS, type CreateScrollSync, type Line } from '../shared/types';

type Pane = 'editor' | 'preview';
const MASTER_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown', 'focusin'] as const;
const SETTLE_PX = 4;
const SETTLE_FRACTION = 0.25;
/** Settle passes after a follow: CodeMirror measures line heights one frame at a time after a scroll or
 *  a pane resize, and the preview's heights firm up as blocks mount; each pass re-reads the master and
 *  stops as soon as the follower is on target (a pass costs a few µs, so several are affordable). */
const SETTLE_PASSES = 6;
const CURSOR_FAR_SCREENS = 3;
/** After nav:gotoLine both panes are positioned programmatically and keep settling (CodeMirror measures
 *  after the scroll, the preview re-anchors as blocks mount): neither pane's echo may drive the other
 *  meanwhile. Real user input on a pane lifts its suppression at once. */
const NAV_SETTLE_MS = 600;
/** A settle pass re-applies the master's position only while the follower still sits where the previous
 *  pass put it: when its top line moved further than this since then, someone else positioned that pane
 *  (an API scrollToLine, a navigation, the cursor-follow) and the chain must not drag it back. Measured
 *  heights firming up under the anchored line move the top edge by a line or two at most. */
const MOVED_LINES = 30;
/** Line number past the end of any document the app can hold, used to ask the preview for its last block. */
const LAST_LINE = 0x7fffffff;

export const createScrollSync: CreateScrollSync = (editor, preview, bus) => {
  let enabled = false;
  let master: Pane = 'editor';
  const suppressUntil = { editor: 0, preview: 0 };
  let settleRaf = 0;
  const now = (): number => performance.now();

  const scrollDOM = editor.view.scrollDOM;
  const electEditor = (e: Event): void => { master = 'editor'; if (e.type !== 'focusin') suppressUntil.editor = 0; };
  const electPreview = (e: Event): void => { master = 'preview'; if (e.type !== 'focusin') suppressUntil.preview = 0; };
  for (const ev of MASTER_EVENTS) {
    scrollDOM.addEventListener(ev, electEditor, { passive: true, capture: true });
    preview.el.addEventListener(ev, electPreview, { passive: true, capture: true });
  }

  function settle(fn: () => void): void {
    cancelSettle();
    settleRaf = requestAnimationFrame(() => { settleRaf = 0; fn(); });
  }
  function cancelSettle(): void {
    if (settleRaf) cancelAnimationFrame(settleRaf);
    settleRaf = 0;
  }

  /**
   * scrollTop of the very end of the preview's content — its scroll-past-end padding excluded. Model
   * only (`blockAtLine` clamps to the last block, `lineToScrollTop` is pure arithmetic): no layout read.
   */
  function previewContentBottom(): number {
    const b = preview.blockAtLine(LAST_LINE);
    if (b.index < 0 || b.lineCount <= 0) return 0;
    return preview.lineToScrollTop(b.startLine + b.lineCount - 1, 1);
  }

  /**
   * The preview's top edge AS A MASTER, with its trailing padding taken out of the picture: once the pane
   * is scrolled into its own tail there is no more document below, so the position to follow stays the one
   * of the last full screen of content. The editor has no scroll-past-end region at all, so without this
   * the two panes could not agree on a top line anywhere in the tail (the preview kept reporting later and
   * later lines while the editor sat at its maximum scroll) — that was a 28-line drift at f = 1.0.
   */
  function previewTop(): { line: Line; fraction: number } {
    const maxContentTop = Math.max(0, previewContentBottom() - preview.el.clientHeight);
    return preview.el.scrollTop > maxContentTop
      ? preview.scrollTopToLine(maxContentTop)
      : preview.topVisible();
  }

  /** Clamps a follower target to the pane's real scroll range. Past the end `scrollTop` saturates anyway,
   *  but an unclamped target would keep every settle pass "off target" and re-writing for ever. A range of
   *  0 means the pane cannot scroll; a negative one means it has no usable measurement yet (hidden pane). */
  function clampPreviewTarget(top: number): number {
    const max = preview.el.scrollHeight - preview.el.clientHeight;
    if (max < 0) return top;
    return top < 0 ? 0 : top > max ? max : top;
  }

  /** True when CodeMirror's scroller is at its maximum scroll: it has no scroll-past-end region, so the
   *  lines of the document's last screen can never be brought to its top edge. */
  function editorAtEnd(): boolean {
    const max = scrollDOM.scrollHeight - scrollDOM.clientHeight;
    return max > 0 && scrollDOM.scrollTop >= max - 1;
  }

  /** Positions the preview on (line, fraction), or on its own end when that line cannot reach the top
   *  edge. Returns false when it was already there. */
  function applyPreview(line: Line, fraction: number): boolean {
    const want = preview.lineToScrollTop(line, fraction);
    const top = clampPreviewTarget(want);
    if (Math.abs(preview.el.scrollTop - top) <= 1) return false;
    suppressUntil.preview = now() + SYNC_SUPPRESS_MS;
    // Clamped: the target is inside the preview's own tail, so align the pane to its end instead of
    // handing `scrollToLine` a target it can never reach (and re-anchoring to it for 600 ms).
    if (top < want) preview.el.scrollTop = top;
    else preview.scrollToLine(line, fraction);
    return true;
  }

  /** Position the preview from the editor's top edge; settle passes on the next frames while it is off.
   *  Goes through preview.scrollToLine so the preview keeps the target line anchored while the blocks
   *  it just materialized are measured (their estimated heights become real ones after this frame). */
  function followPreview(): void {
    const { line, fraction } = editor.topVisible();
    if (!applyPreview(line, fraction)) return;
    let setLine = line;
    const pass = (left: number): void => {
      if (master !== 'editor') return;   // the user took over meanwhile
      if (Math.abs(preview.topVisible().line - setLine) > MOVED_LINES) return;   // someone else moved the preview
      const t = editor.topVisible();
      const top2 = clampPreviewTarget(preview.lineToScrollTop(t.line, t.fraction));
      if (Math.abs(preview.el.scrollTop - top2) <= SETTLE_PX) return;
      applyPreview(t.line, t.fraction);
      setLine = t.line;
      if (left > 1) settle(() => pass(left - 1));
    };
    settle(() => pass(SETTLE_PASSES));
  }

  /** Position the editor from the preview's top edge; settle passes on the next frames while it is off. */
  function followEditor(): void {
    const { line, fraction } = previewTop();
    suppressUntil.editor = now() + SYNC_SUPPRESS_MS;
    editor.scrollToLine(line, fraction);
    let setLine = line;
    const pass = (left: number): void => {
      if (master !== 'preview') return;
      if (Math.abs(editor.topVisible().line - setLine) > MOVED_LINES) return;   // someone else moved the editor
      // The master may have kept scrolling, and CodeMirror re-measures line heights after each scroll
      // (estimated wrapped heights become real ones, one viewport per frame), which can shift the line
      // that landed on top — most visibly when the editor pane was hidden until a moment ago.
      const t = previewTop();
      const got = editor.topVisible();
      if (t.line === got.line && Math.abs(t.fraction - got.fraction) <= SETTLE_FRACTION) return;
      // The editor is already showing the end of the document and the target is below that: it is as
      // close as it can get, and another write would only restart the chain.
      if (got.line < t.line && editorAtEnd()) return;
      suppressUntil.editor = now() + SYNC_SUPPRESS_MS;
      editor.scrollToLine(t.line, t.fraction);
      setLine = t.line;
      if (left > 1) settle(() => pass(left - 1));
    };
    settle(() => pass(SETTLE_PASSES));
  }

  const offEditorScroll = editor.onScroll(() => {
    if (!enabled || master !== 'editor' || now() < suppressUntil.editor) return;
    followPreview();
  });
  const offPreviewScroll = preview.onScroll(() => {
    if (!enabled || master !== 'preview' || now() < suppressUntil.preview) return;
    followEditor();
  });

  // Cursor-follow is for typing IN THE EDITOR (finding high 1). App already announces the notification a
  // preview write causes as `typing: false` (src/app/App.ts, previewWriteGate); a doc change the editor did
  // not originate still reports `typing` otherwise — a checkbox toggled in the preview — for CodeMirror's
  // unfocused caret, so the editor must also have focus. Following such an event would scroll the preview
  // away from the block the user works in (to line 1 right after opening a file). The one exception is a step of the
  // history run from outside the editor (U2 as amended: `follow`), which the preview follows as 0.1.1 did.
  const offCursor = bus.on('doc:cursor', (e) => {
    if (!e.typing || !enabled || (!editor.hasFocus() && !e.follow) || preview.isLineVisible(e.line)) return;
    const distance = Math.abs(preview.lineToScrollTop(e.line, 0) - preview.el.scrollTop);
    const far = distance > CURSOR_FAR_SCREENS * preview.el.clientHeight;
    suppressUntil.preview = now() + SYNC_SUPPRESS_MS;
    preview.scrollToLine(e.line, 0, far ? 'instant' : 'smooth');
  });

  const offGoto = bus.on('nav:gotoLine', (e) => {
    cancelSettle();   // a follow chain in flight must not drag either pane back after the navigation
    suppressUntil.editor = now() + NAV_SETTLE_MS;
    suppressUntil.preview = now() + NAV_SETTLE_MS;
    editor.gotoLine(e.line);
    preview.scrollToLine(e.line, e.fraction ?? 0);
  });

  return {
    setEnabled(on) { enabled = on; },
    syncNow(from) {
      master = from;
      if (from === 'editor') followPreview(); else followEditor();
    },
    dispose() {
      for (const ev of MASTER_EVENTS) {
        scrollDOM.removeEventListener(ev, electEditor, { capture: true });
        preview.el.removeEventListener(ev, electPreview, { capture: true });
      }
      offEditorScroll(); offPreviewScroll(); offCursor(); offGoto();
      cancelSettle();
    },
  };
};
