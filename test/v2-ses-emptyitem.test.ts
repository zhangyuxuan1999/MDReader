// @vitest-environment jsdom
// verify-session (0.2.0 stage 2a) repro for SES-7: emptying the text of the FIRST item of a nested list (what
// Backspace over its last character does inside a preview session) serializes the item as a lone marker line
// ("  -" / "   1.") directly under the parent item's text. Markdown reads "-" there as a setext underline (the
// parent item's text becomes an <h2>) and "1." as paragraph continuation (the nested list disappears and "1. 2."
// shows as text). The session itself still shows a normal list; the source and every re-render show the heading /
// the literal markers. Pipeline as in test/serialize.roundtrip.test.ts. FAILING TODAY: the first three cases (the third: the empty nested item is dropped, milder).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints } from '../src/preview/serialize';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});
const render = (src: string): string => mdk.renderBlock(src, { references: {} }).html;
function mount(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  return w;
}
/** Nesting + texts, the way a reader sees the list (no markers, no whitespace). */
function shape(el: Element): string {
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return (n as Text).data.replace(/\s+/g, '');
    if (n.nodeType !== 1) return '';
    const e = n as Element;
    const inner = Array.from(e.childNodes).map(walk).join('');
    if (/^(UL|OL)$/.test(e.tagName)) return `${e.tagName}[${inner}]`;
    if (e.tagName === 'LI') return `(${inner})`;
    if (/^H[1-6]$/.test(e.tagName)) return `${e.tagName}{${inner}}`;
    return inner;
  };
  return walk(el);
}
/** Empties the text of the item whose text is `item` (Backspace over it in the session), then serializes. */
function emptyItem(src: string, item: string): { md: string; before: string; after: string } {
  const w = mount(render(src));
  const li = Array.from(w.querySelectorAll('li')).find((l) => Array.from(l.childNodes).some((c) => c.nodeType === 3 && (c as Text).data.trim() === item))!;
  for (const c of Array.from(li.childNodes)) if (c.nodeType === 3 && (c as Text).data.trim() === item) c.remove();
  li.insertBefore(document.createElement('br'), li.firstChild);   // what Chrome leaves in an emptied item
  const before = shape(w);
  const md = serializeBlock(w, BlockKind.List, { ...sourceStyleHints(src), editing: true });
  return { md, before, after: shape(mount(render(md))) };
}

describe('SES-7: an emptied first nested item keeps the list a list', () => {
  const cases: Array<[string, string]> = [
    ['- on\n  - x\n  - o', 'x'],        // (fails) → "- on\n  -\n  - o": "on" becomes an <h2>
    ['1. on\n   1. x\n   2. o', 'x'],   // (fails) → "1. on\n   1.\n   2. o": renders "on 1. 2. o"
    ['- on\n  - x', 'x'],               // (fails, milder) → "- on": the emptied only nested item is dropped
    ['- a\n- x\n- o', 'x'],             // control: a top-level middle item (holds)
  ];
  for (const [src, item] of cases) {
    it(JSON.stringify(src), () => {
      const r = emptyItem(src, item);
      expect({ md: r.md, rendered: r.after }).toEqual({ md: r.md, rendered: r.before });
    });
  }
});
