// @vitest-environment jsdom
// verify-session (0.2.0 stage 2a) repro for SES-2: an autolink glued to a preceding ASCII letter / digit
// (`word<https://e.com>`) is serialized as a bare URL, which markdown-it's linkify does not recognise after a
// letter — the link disappears from the rendering as soon as its paragraph is edited in the preview (the first
// edit serializes the whole block). Same pipeline as test/serialize.roundtrip.test.ts (render → mount →
// serializeBlock with the session's source-style hints → render again). Every case asserts that the block still
// renders a link with the same href. FAILING TODAY: the cases marked (fails) below.
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
const hrefs = (html: string): string[] => Array.from(mount(html).querySelectorAll('a[href]')).map((a) => a.getAttribute('href') ?? '');

const CASES: string[] = [
  'word<https://e.com> tail',      // (fails) → "wordhttps://e.com tail", no link
  'word<https://e.com>',           // (fails) → "wordhttps://e.com"
  'v2<https://e.com/x> next',      // (fails) digit before
  'see:<https://e.com> next',      // colon before (control)
  '见<https://e.com> 后',           // CJK before (control: holds today)
  'a <https://e.com> b',           // space before (control: holds today)
];

describe('SES-2: an autolink keeps rendering as a link after its paragraph is serialized', () => {
  for (const src of CASES) {
    it(JSON.stringify(src), () => {
      const before = hrefs(render(src));
      expect(before.length).toBe(1);
      const md = serializeBlock(mount(render(src)), BlockKind.Prose, { ...sourceStyleHints(src), editing: true });
      const after = hrefs(render(md));
      expect({ md, after }).toEqual({ md, after: before });
    });
  }
});
