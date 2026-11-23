// @vitest-environment jsdom
// test/app.tocVisibility.test.ts — TOC visibility policy (finding r3: "Below 900 px the 显示/隐藏目录
// control is a dead button that still flips the persisted mdr.toc preference").
// Below the breakpoint layout.css floats an open TOC over the editor pane, so the control must have a
// visible effect there AND must not rewrite the wide-layout preference the user cannot observe.
import { describe, expect, it } from 'vitest';
import { createTocVisibility } from '../src/app/App';

function harness(startNarrow = false) {
  const applied: boolean[] = [];
  const persisted: boolean[] = [];
  let narrow = startNarrow;
  const vis = createTocVisibility({
    isNarrow: () => narrow,
    apply: (shown) => applied.push(shown),
    persist: (on) => persisted.push(on),
  });
  return {
    vis, applied, persisted,
    setNarrow(on: boolean) {
      narrow = on;
      vis.breakpointChanged();
    },
  };
}

describe('createTocVisibility', () => {
  it('wide: the toggle drives the persisted preference', () => {
    const h = harness(false);
    h.vis.restore(true);
    expect(h.vis.shown()).toBe(true);
    expect(h.persisted).toEqual([]);   // restore must not write the value back

    h.vis.set(false);
    expect(h.vis.shown()).toBe(false);
    expect(h.applied.at(-1)).toBe(false);
    expect(h.persisted).toEqual([false]);

    h.vis.set(true);
    expect(h.persisted).toEqual([false, true]);
  });

  it('narrow: the toggle opens/closes the overlay and never touches the preference', () => {
    const h = harness(true);
    h.vis.restore(true);
    // A persisted `open` must not cover the editor with an overlay nobody asked for.
    expect(h.vis.shown()).toBe(false);

    h.vis.set(true);
    expect(h.vis.shown()).toBe(true);
    expect(h.applied.at(-1)).toBe(true);
    h.vis.set(false);
    expect(h.vis.shown()).toBe(false);
    expect(h.persisted).toEqual([]);
  });

  it('narrow: widening the window restores the stored preference, not the overlay state', () => {
    const h = harness(false);
    h.vis.restore(true);
    h.setNarrow(true);
    expect(h.vis.shown()).toBe(false);
    h.vis.set(true);             // overlay open
    h.vis.set(false);            // overlay closed again
    h.setNarrow(false);
    expect(h.vis.shown()).toBe(true);     // the wide preference survived the narrow session
    expect(h.persisted).toEqual([]);
  });

  it('overlayOpen is true only while the narrow panel is up', () => {
    const h = harness(false);
    h.vis.restore(true);
    expect(h.vis.overlayOpen()).toBe(false);   // the docked wide TOC is not an overlay
    h.setNarrow(true);
    h.vis.set(true);
    expect(h.vis.overlayOpen()).toBe(true);
    h.setNarrow(false);
    expect(h.vis.overlayOpen()).toBe(false);   // widening must drop it, or the dismiss listeners stay hot
  });

  it('closeOverlay only applies to the narrow overlay', () => {
    const h = harness(true);
    h.vis.restore(true);
    h.vis.set(true);
    const n = h.applied.length;
    h.vis.closeOverlay();
    expect(h.vis.shown()).toBe(false);
    expect(h.applied.length).toBe(n + 1);
    // A second close is a no-op (Esc pressed with the overlay already closed).
    h.vis.closeOverlay();
    expect(h.applied.length).toBe(n + 1);

    // Wide: Esc / an outside click must never hide the docked TOC.
    const w = harness(false);
    w.vis.restore(true);
    const m = w.applied.length;
    w.vis.closeOverlay();
    expect(w.vis.shown()).toBe(true);
    expect(w.applied.length).toBe(m);
  });
});
