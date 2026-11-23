// @vitest-environment jsdom
// fix-trust (stage 2b): S3 renderer side (G37) and the data-mdr-x checkbox hardening, at unit level.
// Every link activation in the preview is handled or cancelled; only http / https / mailto / tel open externally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachInteractions, externalUrl } from '../src/preview/interactions';
import { createBus } from '../src/shared/bus';
import type { EventBus, ToastSpec } from '../src/shared/types';

const SVG = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';

let root: HTMLElement;
let bus: EventBus;
let detach: () => void;
let editing: Element | null;
let opened: string[];
let toasts: ToastSpec[];
let edits: number[];

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  bus = createBus();
  editing = null;
  opened = [];
  toasts = [];
  edits = [];
  vi.spyOn(window, 'open').mockImplementation((u?: string | URL) => { opened.push(String(u)); return null; });
  bus.on('toast', (t) => { toasts.push(t); });
  bus.on('source:edit', (e) => { edits.push(e.line); });
  detach = attachInteractions(root, {
    bus,
    setFocusLine: () => {},
    currentFocusLine: () => null,
    startLineOf: (id) => (id === 1 ? 10 : id === 2 ? 20 : undefined),
    outline: () => [],
    isEditing: (t) => !!(editing && editing.contains(t)),
  });
});
afterEach(() => {
  detach();
  root.remove();
  vi.restoreAllMocks();
});

function block(id: number, html: string, reserved = false): HTMLElement {
  const s = document.createElement('section');
  s.className = 'md-block';
  s.dataset.id = String(id);
  if (reserved) s.setAttribute('data-mdr-x', '');
  s.innerHTML = html;
  root.appendChild(s);
  return s;
}
function svgLink(attrs: Array<[string | null, string, string]>): Element {
  const svg = document.createElementNS(SVG, 'svg');
  const a = document.createElementNS(SVG, 'a');
  for (const [ns, name, value] of attrs) a.setAttributeNS(ns, name, value);
  const text = document.createElementNS(SVG, 'text');
  text.textContent = 'L';
  a.appendChild(text);
  svg.appendChild(a);
  const s = block(1, '');
  s.appendChild(svg);
  return text;
}
/** Dispatches a cancelable click; true when the default action was cancelled. */
const click = (t: Element, init: MouseEventInit = {}): boolean =>
  // a real click comes after its press on the same element (U24 counts a checkbox click only then)
  (t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init })),
  !t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })));
const aux = (t: Element): boolean =>
  !t.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));

describe('externalUrl', () => {
  it('opens only http, https, mailto and tel, with the scheme the URL parser sees', () => {
    expect(externalUrl('https://e.com/x')).toBe('https://e.com/x');
    expect(externalUrl(' HTTP://E.com ')).toBe('http://e.com/');
    expect(externalUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(externalUrl('tel:123')).toBe('tel:123');
    for (const h of ['javascript:alert(1)', 'java\nscript:alert(1)', ' javascript:x', 'data:text/html,x', 'file:///etc/passwd',
      'app://mdreader/index.html', 'blob:https://e.com/1', 'vbscript:x', 'ftp://e.com', 'sms:1', '//e.com/x', 'x.md', '#a', '']) {
      expect(externalUrl(h), h).toBeNull();
    }
  });
});

describe('link activation (S3)', () => {
  it('an SVG link (href) to a relative path or index.html is cancelled and toasts, nothing opens', () => {
    for (const href of ['nonexistent.md', 'index.html']) {
      const t = svgLink([[null, 'href', href]]);
      expect(click(t)).toBe(true);
      expect(aux(t)).toBe(true);
    }
    expect(opened).toEqual([]);
    expect(toasts.length).toBe(4);
  });

  it('an SVG link with a protocol-relative href is cancelled and nothing opens', () => {
    const t = svgLink([[null, 'href', '//mdreader/nonexistent.md']]);
    expect(click(t)).toBe(true);
    expect(opened).toEqual([]);
  });

  it('an SVG xlink:href link is seen: cancelled, and an https one opens externally', () => {
    const rel = svgLink([[XLINK, 'xlink:href', 'other.md']]);
    expect(click(rel)).toBe(true);
    const web = svgLink([[XLINK, 'xlink:href', 'https://e.com/svg']]);
    expect(click(web)).toBe(true);
    expect(opened).toEqual(['https://e.com/svg']);
  });

  it('an SVG a without a destination inside an SVG a with one: the outer link is the one routed', () => {
    const svg = document.createElementNS(SVG, 'svg');
    const outer = document.createElementNS(SVG, 'a');
    outer.setAttribute('href', 'https://e.com/outer');
    const inner = document.createElementNS(SVG, 'a');
    const text = document.createElementNS(SVG, 'text');
    inner.appendChild(text);
    outer.appendChild(inner);
    svg.appendChild(outer);
    block(1, '').appendChild(svg);
    expect(click(text)).toBe(true);
    expect(opened).toEqual(['https://e.com/outer']);
  });

  it('an image-map area is cancelled', () => {
    const s = block(1, '<img usemap="#m"><map name="m"><area href="nonexistent.md" shape="rect" coords="0,0,9,9"></map>');
    expect(click(s.querySelector('area')!)).toBe(true);
    expect(aux(s.querySelector('area')!)).toBe(true);
    expect(opened).toEqual([]);
  });

  it('HTML links to other schemes never open and never navigate', () => {
    const s = block(1, '<p><a href="javascript:alert(1)">j</a><a href="data:text/html,x">d</a><a href="file:///x">f</a>'
      + '<a href="ftp://e.com" target="_blank">t</a><a href="sms:1" target="_blank">s</a><a href="app://mdreader/index.html">a</a></p>');
    for (const a of Array.from(s.querySelectorAll('a'))) {
      expect(click(a), a.getAttribute('href')!).toBe(true);
      expect(aux(a), a.getAttribute('href')!).toBe(true);
    }
    expect(opened).toEqual([]);
    expect(toasts).toEqual([]);   // a link with a scheme is not "relative"
  });

  it('a sanitized new-window HTML link to https keeps the browser activation; one without target is routed', () => {
    const s = block(1, '<p><a href="https://e.com/w" target="_blank" rel="noopener noreferrer">w</a><a href="https://e.com/n">n</a></p>');
    const [w, n] = Array.from(s.querySelectorAll('a'));
    expect(click(w)).toBe(false);
    expect(aux(w)).toBe(false);
    expect(click(n)).toBe(true);
    expect(opened).toEqual(['https://e.com/n']);
  });

  it('inside a session: a plain click only places the caret; ⌘-click opens only http(s) / mailto / tel', () => {
    const s = block(1, '<p><a href="https://e.com/w" target="_blank">w</a><a href="ftp://e.com/f" target="_blank">f</a>'
      + '<a href="sms:1" target="_blank">s</a><a href="javascript:x">j</a></p>');
    editing = s;
    const [w, f, sms, j] = Array.from(s.querySelectorAll('a'));
    expect(click(w)).toBe(true);
    expect(opened).toEqual([]);
    for (const a of [w, f, sms, j]) expect(click(a, { metaKey: true })).toBe(true);
    expect(opened).toEqual(['https://e.com/w']);
  });
});

describe('task checkbox in a block with forged reserved names (U10)', () => {
  it('is not toggled and writes nothing; the same box in an ordinary block toggles its line', () => {
    const html = '<ul><li class="task-list-item" data-l="3"><input type="checkbox"> a</li></ul>';
    const forged = block(1, html, true).querySelector('input')!;
    expect(click(forged)).toBe(true);
    forged.dispatchEvent(new Event('change', { bubbles: true }));
    expect(edits).toEqual([]);
    const plain = block(2, html).querySelector('input')!;
    expect(click(plain)).toBe(false);   // the click's own activation fires change
    expect(edits).toEqual([23]);
  });
});
