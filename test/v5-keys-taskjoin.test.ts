// @vitest-environment jsdom
// verify-session-keys (round 4 re-verification), finding KEYS-1: when two list items are joined in a preview session
// (Delete at the end of an item, or Backspace at the start of the next one), Chromium moves the second item's
// content — its task checkbox included — into the first item. The serializer marks the item with the state of the
// LAST checkbox in it (serialize.ts: for every input, li.setAttribute('data-mdr-task', …)), so the first item's own
// state is replaced by the second one's and a plain item becomes a ticked task. The DOM below is what the session
// shows after the join (bench/verify/v5-keys-probe.mjs task-*). These cases FAIL today; they define "fixed".
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { resetListCache, serializeBlock } from '../src/preview/serialize';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  return w;
}
/** The join as Chromium performs it: the children of item k+1 move to the end of item k, item k+1 goes. */
function joinItems(w: HTMLElement, k: number): void {
  const lis = Array.from(w.querySelectorAll('li'));
  const a = lis[k], b = lis[k + 1];
  const pa = a.querySelector('p') ?? a;
  const pb = b.querySelector('p') ?? b;
  while (pb.firstChild) pa.appendChild(pb.firstChild);
  b.remove();
}

describe('KEYS-1: joining list items keeps the first item\'s own task state', () => {
  it('unticked task + ticked task: the joined item stays unticked', () => {
    resetListCache();
    const w = mount('- [ ] task a\n- [x] task b');
    joinItems(w, 0);
    const out = serializeBlock(w, BlockKind.List);
    w.remove();
    expect(out.startsWith('- [ ] task a')).toBe(true);
  });
  it('ticked task + unticked task: the joined item stays ticked', () => {
    resetListCache();
    const w = mount('- [x] task a\n- [ ] task b');
    joinItems(w, 0);
    const out = serializeBlock(w, BlockKind.List);
    w.remove();
    expect(out.startsWith('- [x] task a')).toBe(true);
  });
  it('plain item + ticked task: the joined item does not become a task', () => {
    resetListCache();
    const w = mount('- plain a\n- [x] task b');
    joinItems(w, 0);
    const out = serializeBlock(w, BlockKind.List);
    w.remove();
    expect(out.startsWith('- plain a')).toBe(true);
  });
});
