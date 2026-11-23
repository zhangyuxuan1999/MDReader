// @vitest-environment jsdom
// test/r4-ie-history.test.ts — fix-session-e (stage 2e, round 4), B2: U2 as amended, second half (CONTRACT §11,
// Checkpoint-C decisions, RVS-3). The preview's cursor-follow returns while the editor has no focus (OFFD-4: a tick in
// the preview must not throw it), except for the ONE notification marked `follow` — the step of ⌘Z / ⇧⌘Z run from
// outside the editor (App historyOutside; its App-level tests are in test/app.previewEdit.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScrollSync } from '../src/preview/scrollSync';
import { createBus } from '../src/shared/bus';
import type { EditorApi, PreviewApi } from '../src/shared/types';

const PX = 10;
function fakes() {
  const scrollDOM = document.createElement('div');
  const editor = {
    view: { scrollDOM },
    topVisible: () => ({ line: 1, fraction: 0 }),
    scrollToLine: vi.fn(),
    gotoLine: vi.fn(),
    hasFocus: vi.fn(() => false),
    onScroll: () => () => {},
  };
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
  const preview = {
    el,
    lineToScrollTop: (line: number, fraction: number) => (line - 1 + fraction) * PX,
    scrollTopToLine: (top: number) => ({ line: Math.floor(top / PX) + 1, fraction: 0 }),
    blockAtLine: () => ({ index: 0, id: 1, startLine: 1, lineCount: 100000, kind: 0 }),
    topVisible: () => ({ line: Math.floor(el.scrollTop / PX) + 1, fraction: 0 }),
    scrollToLine: vi.fn((line: number) => { el.scrollTop = (line - 1) * PX; }),
    isLineVisible: vi.fn(() => false),
    onScroll: () => () => {},
  };
  return { editor, preview, editorApi: editor as unknown as EditorApi, previewApi: preview as unknown as PreviewApi };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('B2: the cursor-follow obeys the mark of an outside history step, and only it', () => {
  it('unfocused editor: an unmarked typing notification (a tick) does not move the preview; a marked one does', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    sync.setEnabled(true);
    f.preview.el.scrollTop = 9530;
    bus.emit('doc:cursor', { line: 3, col: 0, typing: true });                 // a tick: OFFD-4 holds
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();
    expect(f.preview.el.scrollTop).toBe(9530);
    bus.emit('doc:cursor', { line: 11, col: 0, typing: true, follow: true });  // the step of an outside ⌘Z
    expect(f.preview.scrollToLine).toHaveBeenLastCalledWith(11, 0, 'instant');
    sync.dispose();
  });
  it('the mark does not override the rest of the rule: not typing, disabled, or the line already visible', () => {
    const f = fakes();
    const bus = createBus();
    const sync = createScrollSync(f.editorApi, f.previewApi, bus);
    bus.emit('doc:cursor', { line: 11, col: 0, typing: true, follow: true });  // disabled
    sync.setEnabled(true);
    bus.emit('doc:cursor', { line: 11, col: 0, typing: false, follow: true }); // a preview write is never marked
    f.preview.isLineVisible.mockReturnValue(true);
    bus.emit('doc:cursor', { line: 11, col: 0, typing: true, follow: true });  // already on screen
    expect(f.preview.scrollToLine).not.toHaveBeenCalled();
    sync.dispose();
  });
});
