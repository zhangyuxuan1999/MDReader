// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtmlString, sanitizeToFragment } from '../src/preview/sanitize';

const html = (s: string): HTMLElement => {
  const d = document.createElement('div');
  d.appendChild(sanitizeToFragment(s));
  return d;
};

describe('sanitizeToFragment', () => {
  it('returns a fragment and strips scripts, forbidden tags and event handlers', () => {
    const d = html('<p data-l="2">a<script>x()</script><style>p{}</style><iframe src="x"></iframe>' +
      '<button>b</button><form></form><span onclick="x()" onload="y()">s</span></p>');
    expect(d.querySelector('script, style, iframe, button, form')).toBeNull();
    expect(d.querySelector('span')!.attributes.length).toBe(0);
    expect(d.querySelector('p')!.dataset.l).toBe('2');
  });

  it('keeps data-lang on code blocks and task checkboxes, drops other inputs', () => {
    const d = html('<pre class="md-code" data-lang="ts" data-l="0"><code>x</code></pre>' +
      '<input type="checkbox" checked><input type="checkbox" disabled><input type="text"><input>');
    expect(d.querySelector('pre')!.dataset.lang).toBe('ts');
    expect(d.querySelectorAll('input').length).toBe(2);
    expect(d.querySelectorAll('input[type="checkbox"]').length).toBe(2);
  });

  it('opens external links in a new tab, leaves anchors and relative links untouched', () => {
    const d = html('<a href="https://x.y">1</a><a href="mailto:a@b.c">2</a><a href="//cdn/x">3</a><a href="#h">4</a><a href="../r.md">5</a><a href="javascript:alert(1)">6</a>');
    const a = d.querySelectorAll('a');
    for (const i of [0, 1, 2]) {
      expect(a[i].getAttribute('target')).toBe('_blank');
      expect(a[i].getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(a[3].getAttribute('target')).toBeNull();
    expect(a[4].getAttribute('target')).toBeNull();
    expect(a[5].getAttribute('href')).toBeNull();
  });

  it('keeps svg and mathml from KaTeX output', () => {
    const d = html('<span class="katex"><math><mi>x</mi></math><svg width="1" height="1"><path d="M0 0"/></svg></span>');
    expect(d.querySelector('math mi')).not.toBeNull();
    expect(d.querySelector('svg path')).not.toBeNull();
  });

  it('keeps <semantics>/<annotation> so KaTeX MathML does not leak the TeX source as a stray text node', () => {
    const d = html('<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML">' +
      '<semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">x^2 + y_1</annotation></semantics></math></span></span>');
    const math = d.querySelector('math')!;
    const semantics = math.firstElementChild!;
    expect(semantics.tagName.toLowerCase()).toBe('semantics');
    const annotation = semantics.lastElementChild!;
    expect(annotation.tagName.toLowerCase()).toBe('annotation');
    expect(annotation.getAttribute('encoding')).toBe('application/x-tex');
    expect(annotation.textContent).toBe('x^2 + y_1');
    // the TeX source lives inside <annotation>, never as a text node directly under <math>
    expect(Array.from(math.childNodes).every((n) => n.nodeType === 1)).toBe(true);
  });

  it('still sanitizes element children of an annotation', () => {
    const d = html('<math><semantics><mrow><mi>x</mi></mrow>' +
      '<annotation encoding="application/xhtml+xml"><script>x()</script><b onclick="y()">t</b></annotation></semantics></math>');
    expect(d.querySelector('script')).toBeNull();
    expect(d.querySelector('b')?.hasAttribute('onclick')).toBe(false);
  });
});

describe('sanitizeHtmlString', () => {
  it('applies the same rules, string in / string out (for the HTML export)', () => {
    const out = sanitizeHtmlString('<h1 id="t">T</h1><p data-l="1">a<script>x()</script><a href="https://x.y" onclick="z()">l</a><input type="text"></p>');
    expect(typeof out).toBe('string');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<input');
    expect(out).toContain('id="t"');
    expect(out).toContain('data-l="1"');
    expect(out).toContain('target="_blank"');
  });
});
