// @vitest-environment jsdom
// test/review-sanitize.test.ts — verifier: DOMPurify configuration (sanitize.ts) against common vectors,
// and the HTML_FLAG_TRUSTED path (md.ts → innerHTML without DOMPurify) against attribute injection via the
// fence info string.
import { describe, expect, it } from 'vitest';
import { sanitizeToFragment, sanitizeHtmlString } from '../src/preview/sanitize';
import { createMarkdown } from '../src/worker/md';
import { DEFAULT_RENDER_OPTIONS, HTML_FLAG_TRUSTED } from '../src/shared/types';

const html = (s: string): string => {
  const d = document.createElement('div');
  d.appendChild(sanitizeToFragment(s));
  return d.innerHTML;
};

describe('review: sanitizer vectors', () => {
  it('strips script / event handlers / javascript: / data: hrefs / iframes / forms / style', () => {
    const out = html([
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">j</a>',
      '<a href="data:text/html,<script>alert(1)</script>">d</a>',
      '<iframe src="https://x"></iframe>',
      '<form action="https://x"><input name=q><button>go</button></form>',
      '<style>body{display:none}</style>',
      '<details open ontoggle=alert(1)>x</details>',
      '<svg><a xlink:href="javascript:alert(1)"><text>s</text></a></svg>',
      '<math><maction actiontype="statusline#http://x" xlink:href="javascript:alert(1)">m</maction></math>',
      '<input type="text" value="x"><input type="checkbox" checked>',
      '<object data="x"></object><embed src="x">',
      '<base href="https://evil/">',
      '<meta http-equiv="refresh" content="0;url=https://evil/">',
      '<svg><foreignObject><body><img src=x onerror=alert(1)></body></foreignObject></svg>',
      '<a href="https://ok" target="_top">t</a>',
    ].join(''));
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onerror|ontoggle/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/href="data:/i);
    expect(out).not.toMatch(/<iframe|<form|<button|<style|<object|<embed|<base|<meta|<foreignObject/i);
    expect(out).not.toMatch(/type="text"/);
    expect(out).toMatch(/type="checkbox"/);
    // external anchors: target=_blank + rel
    expect(out).toMatch(/<a href="https:\/\/ok" target="_blank" rel="noopener noreferrer">/);
  });
  it('string sanitizer matches the fragment sanitizer', () => {
    const s = '<p onclick=x>a<img src=x onerror=y></p>';
    expect(sanitizeHtmlString(s)).toBe(html(s));
  });
});

describe('review: TRUSTED (innerHTML) path cannot be reached with unescaped attribute text', () => {
  it('fence info string with quotes / angle brackets is escaped', () => {
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    const r = md.renderBlock('```js"><img src=x onerror=alert(1)>\ncode\n```', { references: {} });
    expect(r.flags & HTML_FLAG_TRUSTED).toBe(HTML_FLAG_TRUSTED);
    const d = document.createElement('div');
    d.innerHTML = r.html;
    expect(d.querySelector('img')).toBeNull();
    expect(d.querySelectorAll('*').length).toBe(2); // pre > code only
  });
  it('fence info string with entity / backslash escapes decoded by unescapeAll stays escaped', () => {
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    const r = md.renderBlock('```js&quot;&gt;&lt;img&#32;src=x&#32;onerror=alert(1)&gt;\ncode\n```', { references: {} });
    const d = document.createElement('div');
    d.innerHTML = r.html;
    expect(d.querySelector('img')).toBeNull();
  });
  it('fence content is escaped (with and without hljs)', () => {
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    for (const lang of ['', 'js', 'nolang']) {
      const r = md.renderBlock('```' + lang + '\n<img src=x onerror=alert(1)>\n```', { references: {} });
      const d = document.createElement('div');
      d.innerHTML = r.html;
      expect(d.querySelector('img'), lang).toBeNull();
    }
    const r2 = md.renderBlock('    <img src=x onerror=alert(1)>', { references: {} });
    expect(r2.flags & HTML_FLAG_TRUSTED).toBe(HTML_FLAG_TRUSTED);
    const d = document.createElement('div');
    d.innerHTML = r2.html;
    expect(d.querySelector('img')).toBeNull();
  });
  it('a block mixing a fence with inline html is NOT trusted', () => {
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    const r = md.renderBlock('```\nx\n```\n<img src=x onerror=alert(1)>', { references: {} });
    expect(r.flags & HTML_FLAG_TRUSTED).toBe(0);
  });
});
