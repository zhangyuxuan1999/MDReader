// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScrollSync } from '../src/preview/scrollSync';
import { createBus } from '../src/shared/bus';
import { SYNC_SUPPRESS_MS, type EditorApi, type PreviewApi } from '../src/shared/types';

const PX_PER_LINE = 10;

function fakes(docLines = 100000) {
  const scrollDOM = document.createElement('div');
  const editorScroll = new Set<() => void>();
  let editorTop = { line: 1, fraction: 0 };
  const editor = {
    view: { scrollDOM },
    topVisible: () => editorTop,
    scrollToLine: vi.fn((line: number, fraction = 0) => { editorTop = { line, fraction }; }),
    gotoLine: vi.fn(),
    hasFocus: vi.fn(() => true),
    onScroll: (fn: () => void) => { editorScroll.add(fn); return () => editorScroll.delete(fn); },
  };
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
  const previewScroll = new Set<() => void>();
  const preview = {
    el,
    lineToScrollTop: (line: number, fraction: number) => (line - 1 + fraction) * PX_PER_LINE,
    scrollTopToLine: (top: number) => {
      const pos = top / PX_PER_LINE;
      return { line: Math.floor(pos) + 1, fraction: pos - Math.floor(pos) };
    },
    // One block covering the whole (long) document: scrollSync asks for the last block to find where the
    // content ends and the scroll-past-end padding begins.
    blockAtLine: (line: number) => ({ index: 0, id: 1, startLine: 1, lineCount: docLines, kind: 0, line }),
    topVisible: () => {
      const pos = el.scrollTop / PX_PER_LINE;
      return { line: Math.floor(pos) + 1, fraction: pos - Math.floor(pos) };
    },
    scrollToLine: vi.fn((line: number, fraction = 0) => { el.scrollTop = (line - 1 + fraction) * PX_PER_LINE; }),
    isLineVisible: vi.fn(() => false),
    onScroll: (fn: () => void) => { previewScroll.add(fn); return () => previewScroll.delete(fn); },
  };
  return {
    editor, preview,
    /** Height of the preview's content in px (its scroll-past-end padding is `scrollHeight` minus this). */
    contentHeight: () => docLines * PX_PER_LINE,
    setEditorTop(line: number, fraction = 0) { editorTop = { line, fraction }; },
    fireEditorScroll() { for (const f of editorScroll) f(); },
    firePreviewScroll() { for (const f of previewScroll) f(); },
    editorApi: editor as unknown as EditorApi,
    previewApi: preview as unknown as PreviewApi,
  };
}

const frame = (): void => { vi.advanceTimersByTime(17); };

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('createScrollSync', () => {
  it('does nothing while disabled', () => {
    const f = fakes();
    createScrollSync(f.editorApi, f.previewApi, createBus());
    f.setEditorTop(20);
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(0);
  });

  it('editor is the default master: editor scroll positions the preview and suppresses the echo', () => {
    const f = fakes();
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    sync.setEnabled(true);
    f.setEditorTop(20, 0.5);
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(195);
    // through scrollToLine, so the preview keeps the line anchored while its blocks are measured
    expect(f.preview.scrollToLine).toHaveBeenCalledWith(20, 0.5);
    // The programmatic preview scroll echoes back: ignored (preview is not master, and suppressed).
    f.firePreviewScroll();
    expect(f.editor.scrollToLine).not.toHaveBeenCalled();
    // A settle pass re-reads the master once and corrects if it moved > 4 px.
    f.setEditorTop(21, 0);
    frame();
    expect(f.preview.el.scrollTop).toBe(200);
  });

  it('user input on the preview elects it master; suppression expires after SYNC_SUPPRESS_MS', () => {
    const f = fakes();
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    sync.setEnabled(true);
    f.setEditorTop(10);
    f.fireEditorScroll();                    // preview.scrollTop = 90, preview suppressed (echo guard)
    f.firePreviewScroll();                   // the echo: ignored
    expect(f.editor.scrollToLine).not.toHaveBeenCalled();
    f.preview.el.dispatchEvent(new Event('wheel'));   // user input lifts the echo guard at once
    f.preview.el.scrollTop = 300;
    f.firePreviewScroll();
    expect(f.editor.scrollToLine).toHaveBeenCalledWith(31, 0);
    // Now the editor's echo is suppressed even though the editor scrolled.
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(300);
    vi.advanceTimersByTime(SYNC_SUPPRESS_MS + 1);
    // Back to the editor via keyboard.
    f.editor.view.scrollDOM.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(SYNC_SUPPRESS_MS + 1);
    f.setEditorTop(50);
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(490);
  });

  it('syncNow forces one pass regardless of enabled state', () => {
    const f = fakes();
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    f.preview.el.scrollTop = 125;
    sync.syncNow('preview');
    expect(f.editor.scrollToLine).toHaveBeenCalledWith(13, 0.5);
    f.setEditorTop(7);
    sync.syncNow('editor');
    expect(f.preview.el.scrollTop).toBe(60);
  });

  it('follows the typing cursor when its line is not visible: smooth nearby, instant when far', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    sync.setEnabled(true);
    f.preview.isLineVisible.mockReturnValue(true);
    bus.emit('doc:cursor', { line: 5, col: 0, typing: true });
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();
    f.preview.isLineVisible.mockReturnValue(false);
    bus.emit('doc:cursor', { line: 5, col: 0, typing: false });
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();
    bus.emit('doc:cursor', { line: 20, col: 0, typing: true });     // 190 px away < 3 screens
    expect(f.preview.scrollToLine).toHaveBeenLastCalledWith(20, 0, 'smooth');
    bus.emit('doc:cursor', { line: 200, col: 0, typing: true });    // > 300 px away
    expect(f.preview.scrollToLine).toHaveBeenLastCalledWith(200, 0, 'instant');
  });

  it('does not follow a typing cursor the editor did not originate (unfocused: a preview edit session write)', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    sync.setEnabled(true);
    f.preview.el.scrollTop = 28598;
    f.editor.hasFocus.mockReturnValue(false);
    bus.emit('doc:cursor', { line: 1, col: 0, typing: true });
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();
    expect(f.preview.el.scrollTop).toBe(28598);
    f.editor.hasFocus.mockReturnValue(true);
    bus.emit('doc:cursor', { line: 1, col: 0, typing: true });
    expect(f.preview.scrollToLine).toHaveBeenLastCalledWith(1, 0, 'instant');
  });

  it('nav:gotoLine moves both panes and neither echoes', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    sync.setEnabled(true);
    bus.emit('nav:gotoLine', { line: 42, fraction: 0.25, source: 'toc' });
    expect(f.editor.gotoLine).toHaveBeenCalledWith(42);
    expect(f.preview.scrollToLine).toHaveBeenCalledWith(42, 0.25);
    f.setEditorTop(40);
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(412.5);   // untouched by the editor echo
    // CodeMirror keeps settling for a few frames after gotoLine (longer under mount load): still no follow
    vi.advanceTimersByTime(SYNC_SUPPRESS_MS + 200);
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(412.5);
    f.firePreviewScroll();
    expect(f.editor.scrollToLine).not.toHaveBeenCalled();
    // real user input on the editor lifts its suppression at once
    f.editor.view.scrollDOM.dispatchEvent(new Event('wheel'));
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(390);
    bus.emit('nav:gotoLine', { line: 3, source: 'link' });
    expect(f.preview.scrollToLine).toHaveBeenLastCalledWith(3, 0);
  });

  it('dispose detaches everything', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    sync.setEnabled(true);
    sync.dispose();
    f.setEditorTop(9);
    f.fireEditorScroll();
    bus.emit('nav:gotoLine', { line: 3, source: 'link' });
    expect(f.preview.el.scrollTop).toBe(0);
    expect(f.editor.gotoLine).not.toHaveBeenCalled();
  });
});

describe('settle chain guards (fix round)', () => {
  it('a settle pass stops when someone else moved the follower meanwhile', () => {
    const f = fakes();
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    sync.setEnabled(true);
    f.setEditorTop(20);
    f.fireEditorScroll();                    // preview → 190, settle pass armed for the next frame
    expect(f.preview.el.scrollTop).toBe(190);
    f.setEditorTop(21);                      // the pass would correct to 200 …
    f.preview.el.scrollTop = 5000;           // … but an API scrollToLine / navigation moved the preview far away
    frame();
    expect(f.preview.el.scrollTop).toBe(5000);
    // the mirror image: preview master, editor moved by someone else (e.g. gotoLine) before the pass
    f.preview.el.dispatchEvent(new Event('wheel'));
    f.preview.el.scrollTop = 300;
    f.firePreviewScroll();                   // editor → line 31
    expect(f.editor.topVisible().line).toBe(31);
    f.preview.el.scrollTop = 310;            // master drifted a little: a pass would follow …
    f.editor.scrollToLine(500, 0);           // … unless the editor was moved elsewhere meanwhile
    f.editor.scrollToLine.mockClear();
    frame();
    expect(f.editor.scrollToLine).not.toHaveBeenCalled();
    expect(f.editor.topVisible().line).toBe(500);
  });

  it('nav:gotoLine cancels a follow chain in flight so it cannot drag a pane back', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    sync.setEnabled(true);
    f.setEditorTop(20);
    f.fireEditorScroll();                    // preview → 190, pass armed
    f.setEditorTop(21);                      // the pass would move the preview to 200
    bus.emit('nav:gotoLine', { line: 22, source: 'toc' });   // within MOVED_LINES of the pass's own target
    expect(f.preview.el.scrollTop).toBe(210);
    frame();
    frame();
    expect(f.preview.el.scrollTop).toBe(210);
  });
});

/**
 * Lead decision 1. The preview has a scroll-past-end tail (preview.css `padding-bottom`), the editor has
 * none, so at the bottom of a document the two panes cannot agree on a top line unless the sync knows
 * where the content ends: the master's position is read with its own tail taken out, and a follower target
 * outside the follower's scroll range is clamped to it.
 */
describe('document tail (lead decision 1)', () => {
  /** 100 lines × 10 px content + a 200 px tail in a 100 px pane: content ends at 1000, max scroll 1100. */
  function tailFakes() {
    const f = fakes(100);
    Object.defineProperty(f.preview.el, 'scrollHeight', { value: 1200, configurable: true });
    return f;
  }

  it('stops following the preview once it is inside its own tail', () => {
    const f = tailFakes();
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    sync.setEnabled(true);
    f.preview.el.dispatchEvent(new Event('wheel'));
    // Last full screen of content: line 91 is the deepest top line the document actually has.
    f.preview.el.scrollTop = 900;
    f.firePreviewScroll();
    expect(f.editor.scrollToLine).toHaveBeenLastCalledWith(91, 0);
    // Deeper into the tail the preview reports later and later lines (topVisible saturates at the last
    // line) — the editor must stay on the content end instead of drifting with it.
    for (const top of [950, 1050, 1100]) {
      f.editor.scrollToLine.mockClear();
      f.preview.el.scrollTop = top;
      f.firePreviewScroll();
      if (f.editor.scrollToLine.mock.calls.length > 0) expect(f.editor.scrollToLine).toHaveBeenLastCalledWith(91, 0);
      expect(f.editor.topVisible().line).toBe(91);
    }
  });

  it('clamps a preview target past the end to the pane\'s scroll range instead of anchoring to it', () => {
    const f = tailFakes();
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    sync.setEnabled(true);
    f.setEditorTop(150);                      // beyond this document: 1490 px, past the 1100 px maximum
    f.fireEditorScroll();
    expect(f.preview.el.scrollTop).toBe(1100);
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();   // no unreachable anchor for the next 600 ms
    // and the settle chain sees itself as on target, so it stops instead of re-writing every frame
    f.preview.scrollToLine.mockClear();
    frame();
    frame();
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();
    expect(f.preview.el.scrollTop).toBe(1100);
  });

  it('leaves the editor at its end when the target line is below what it can show', () => {
    const f = tailFakes();
    const scrollDOM = f.editor.view.scrollDOM;
    Object.defineProperty(scrollDOM, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollDOM, 'clientHeight', { value: 300, configurable: true });
    scrollDOM.scrollTop = 700;                // CodeMirror is at its maximum scroll
    // The editor cannot go past line 70 whatever it is asked for (still within MOVED_LINES of the
    // target, so the settle chain really reaches the "follower is at its end" guard).
    f.editor.scrollToLine.mockImplementation((line: number, fraction = 0) => {
      f.setEditorTop(Math.min(line, 70), line > 70 ? 0 : fraction);
    });
    const sync = createScrollSync(f.editorApi, f.previewApi, createBus());
    sync.setEnabled(true);
    f.preview.el.dispatchEvent(new Event('wheel'));
    f.preview.el.scrollTop = 900;
    f.firePreviewScroll();
    expect(f.editor.topVisible().line).toBe(70);
    f.editor.scrollToLine.mockClear();
    frame();
    frame();
    expect(f.editor.scrollToLine).not.toHaveBeenCalled();   // aligned to its end: the chain stops
  });
});
