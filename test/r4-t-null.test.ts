// @vitest-environment jsdom
// test/r4-t-null.test.ts — fix-trust (stage 2e, round 4): J23. HTML that DOMPurify cannot parse into a body (a block that
// is `<!div>` alone, one that starts with `<frameset>`) gives an empty fragment, not null: replaceChildren(null) showed
// the word "null". Other HTML is sanitized as before.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';

const shown = (md: string): string => {
  const r = createMarkdown(DEFAULT_RENDER_OPTIONS).renderBlock(md, { references: {} });
  const s = document.createElement('section');
  s.replaceChildren(sanitizeToFragment(r.html));
  return s.textContent ?? '';
};

describe('J23: a block DOMPurify cannot turn into a fragment shows nothing', () => {
  it('<!div>, <frameset> and <frameset> with content show no "null"', () => {
    for (const md of ['<!div>\n', '<frameset>\n', '<frameset><frame src="x"></frameset>\n', '<!div>\n<!div>\n']) {
      const frag = sanitizeToFragment(createMarkdown(DEFAULT_RENDER_OPTIONS).renderBlock(md, { references: {} }).html);
      expect(frag, md).toBeInstanceOf(DocumentFragment);
      expect(shown(md), md).not.toContain('null');
    }
  });

  it('ordinary blocks are unchanged, including raw HTML and a literal word null', () => {
    expect(shown('null\n').trim()).toBe('null');
    expect(shown('<div>kept <b>bold</b></div>\n')).toContain('kept bold');
    expect(shown('a <frameset> b\n')).toContain('a');
  });
});
