// src/preview/focusLine.ts — which element inside a mounted block carries the focus tint (CONTRACT §9).
//
// Preview elements carry `data-l`: the 0-based line of that element relative to its block's start line.
// A block's subtree is walked ONCE (document order, one block only — never the whole document) and the
// element that covers `rel` is the one with the LARGEST data-l ≤ rel; when several nested elements share
// that value (a `li` and the `p` inside it both map to the list item's first line) the DEEPEST one wins,
// so the tint stays as close to the clicked text as possible. A block with no usable `data-l` (an `hr`, a
// block still pending) tints its wrapper.

/** The element of `wrapper` to tint for the block-relative line `rel`; the wrapper itself as a fallback. */
export function pickFocusElement(wrapper: HTMLElement, rel: number): HTMLElement {
  const want = Number.isFinite(rel) ? Math.max(0, Math.floor(rel)) : 0;
  let best: HTMLElement | null = null;
  let bestL = -1;
  for (const node of wrapper.querySelectorAll<HTMLElement>('[data-l]')) {
    const l = Number(node.dataset.l);
    if (!Number.isFinite(l) || l > want) continue;
    if (l > bestL || (l === bestL && best !== null && best.contains(node))) {
      best = node;
      bestL = l;
    }
  }
  return best ?? wrapper;
}
