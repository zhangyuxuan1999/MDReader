// test/review-html-block-datal.test.ts — verifier: SPEC 4.4 lists `html_block` among the tokens that get
// `data-l`. markdown-it's html_block renderer returns `token.content` verbatim, so md.ts now injects the
// attribute into the first tag of the content (fixed in the fix round; was an it.fails evidence test).
import { describe, expect, it } from 'vitest';
import { createMarkdown } from '../src/worker/md';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';

describe('review: data-l on html_block', () => {
  it('html_block output carries data-l like the other line tokens', () => {
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    const html = md.renderBlock('<div class="x">\n<p>hi</p>\n</div>', { references: {} });
    expect(html.flags).toBe(0);
    expect(html.html).toMatch(/data-l="0"/);
  });
  it('(control) paragraph_open carries data-l', () => {
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    expect(md.renderBlock('hi', { references: {} }).html).toMatch(/data-l="0"/);
  });
});
