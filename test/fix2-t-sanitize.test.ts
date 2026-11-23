// @vitest-environment jsdom
// fix-trust (stage 2b): U10 (d) — the sanitizer drops data-md, data-md-block and data-mdr-* from block HTML.
import { describe, expect, it } from 'vitest';
import { sanitizeHtmlString, sanitizeToFragment } from '../src/preview/sanitize';

const frag = (s: string): HTMLElement => {
  const d = document.createElement('div');
  d.appendChild(sanitizeToFragment(s));
  return d;
};
const str = (s: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = sanitizeHtmlString(s);
  return d;
};
const RESERVED = /^data-(?:md|md-block|mdr-.*)$/i;
const reservedLeft = (d: HTMLElement): string[] =>
  Array.from(d.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).map((a) => a.name)).filter((n) => RESERVED.test(n));

const INPUT =
  '<p data-l="0">Fix <span data-md="[x](https://evil.example/)" style="display:none">.</span> ' +
  '<span data-md-block="[bank]: https://evil.example/">.</span> <span data-mdr-ui>THIS</span> ' +
  '<b DATA-MD="z" DATA-MDR-O="1" data-mdr-x="" data-Mdr-Anything="q">b</b> ' +
  '<svg><a href="#a" data-md="z"><text data-mdr-ui="1">t</text></a></svg> ' +
  '<math><mi data-md-block="y">x</mi></math></p>';

describe('U10 (d): reserved attributes leave block HTML', () => {
  for (const [name, run] of [['sanitizeToFragment', frag], ['sanitizeHtmlString', str]] as const) {
    it(`${name}: every data-md / data-md-block / data-mdr-* is removed`, () => {
      const d = run(INPUT);
      expect(reservedLeft(d)).toEqual([]);
      // the elements and their visible text stay; only the attributes go
      expect(d.textContent).toContain('THIS');
      expect(d.querySelector('b')!.textContent).toBe('b');
      expect(d.querySelector('p')!.getAttribute('data-l')).toBe('0');
    });
    it(`${name}: other data-* attributes and the worker's own markers stay`, () => {
      const d = run('<pre class="md-code" data-lang="ts" data-l="3"><code>x</code></pre><span data-x="1" data-mdrx="2" data-mdx="3">s</span>');
      expect(d.querySelector('pre')!.getAttribute('data-lang')).toBe('ts');
      expect(d.querySelector('pre')!.getAttribute('data-l')).toBe('3');
      const sp = d.querySelector('span')!;
      expect(sp.getAttribute('data-x')).toBe('1');
      expect(sp.getAttribute('data-mdrx')).toBe('2');
      expect(sp.getAttribute('data-mdx')).toBe('3');
    });
  }
});
