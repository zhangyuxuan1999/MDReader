// @vitest-environment jsdom
// The per-item list cache of src/preview/serialize.ts (finding medium 8, docs/FINDINGS-inline-r1.md):
// a cached serialization must be byte-identical to the one-pass (uncached) serialization of the same DOM,
// and an item whose DOM changed must always be serialized again. Default: a deterministic sample; the
// long fuzz with MDR_FULL_FUZZ=1 (CONTRACT §11 decision T1).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { CARET_MARK, listCacheStats, resetListCache, serializeBlock, serializeBlockWithCaret } from '../src/preview/serialize';

const FULL = process.env.MDR_FULL_FUZZ === '1';
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
  for (const e of Array.from(w.querySelectorAll('span, font'))) e.setAttribute('data-mdr-o', '');
  return w;
}

const rng = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const BODIES = [
  '列表项 **粗体** 与 `code`', 'plain *em* text', 'a [link](http://x.y/p "t") here', 'math $x^2$ inline',
  'snake_case and a * b', '~~del~~ and 5 $ each', 'trailing \\\\ backslash', 'C:\\dir', 'emoji 😀',
  'https://bare.example/x', 'a <kbd>K</kbd> b', '中文，标点。',
];

function listSource(r: () => number, n: number, shape: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const body = BODIES[Math.floor(r() * BODIES.length)] + ' ' + i;
    const marker = shape === 1 ? `${i + 1}.` : '-';
    const task = shape === 2 ? (r() < 0.5 ? '[ ] ' : '[x] ') : '';
    lines.push(`${marker} ${task}${body}`);
    if (r() < 0.15) lines.push(`${' '.repeat(marker.length + 1)}- nested ${i}`);
  }
  return lines.join(shape === 3 ? '\n\n' : '\n');
}

describe('list cache: one changed item', () => {
  it.each([[0, 'bullet'], [1, 'ordered'], [2, 'task'], [3, 'loose']])('shape %i (%s): 300 items, mutate one', (shape) => {
    resetListCache();
    const r = rng(1000 + (shape as number));
    const el = mount(listSource(r, 300, shape as number));
    const first = serializeBlock(el, BlockKind.List, { editing: true });
    expect(listCacheStats.misses).toBe(300);
    expect(first).toBe(serializeBlock(el, BlockKind.List, { editing: true, uncached: true }));
    // unchanged DOM: every item is a hit
    resetListCache();
    serializeBlock(el, BlockKind.List, { editing: true });
    listCacheStats.hits = 0; listCacheStats.misses = 0;
    expect(serializeBlock(el, BlockKind.List, { editing: true })).toBe(first);
    expect([listCacheStats.hits, listCacheStats.misses]).toEqual([300, 0]);
    // one item's text changes: exactly that item is redone, and the output is the uncached one
    const li = el.querySelectorAll(':scope > ul > li, :scope > ol > li')[150];
    const walker = document.createTreeWalker(li, 4);
    let tn = walker.nextNode() as Text;
    while (tn.data.trim() === '') tn = walker.nextNode() as Text;
    tn.data = tn.data + '*x';
    listCacheStats.hits = 0; listCacheStats.misses = 0;
    const second = serializeBlock(el, BlockKind.List, { editing: true });
    expect([listCacheStats.hits, listCacheStats.misses]).toEqual([299, 1]);
    expect(second).toBe(serializeBlock(el, BlockKind.List, { editing: true, uncached: true }));
    const a = first.split('\n'), b = second.split('\n');
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i]).length).toBe(1);
    el.remove();
  });

  it('a checkbox toggled through the property (not visible in the HTML) invalidates its item', () => {
    resetListCache();
    const el = mount(Array.from({ length: 10 }, (_, i) => `- [ ] t${i}`).join('\n'));
    expect(serializeBlock(el, BlockKind.List).split('\n')[4]).toBe('- [ ] t4');
    (el.querySelectorAll('input')[4] as HTMLInputElement).checked = true;
    expect(serializeBlock(el, BlockKind.List).split('\n')[4]).toBe('- [x] t4');
    el.remove();
  });

  it('a renumbered ordered item (an item inserted above it) is redone', () => {
    resetListCache();
    const el = mount(Array.from({ length: 12 }, (_, i) => `${i + 1}. o${i}`).join('\n'));
    serializeBlock(el, BlockKind.List);
    const ol = el.querySelector('ol')!;
    ol.insertBefore(ol.children[3].cloneNode(true), ol.children[0]);
    const md = serializeBlock(el, BlockKind.List);
    expect(md).toBe(serializeBlock(el, BlockKind.List, { uncached: true }));
    expect(md.split('\n')[0]).toBe('1. o3');
    expect(md.split('\n')[12]).toBe('13. o11');
    el.remove();
  });

  it('serializeBlockWithCaret on a large list equals the one-pass result', () => {
    const el = mount(listSource(rng(7), 40, 0));
    const tn = document.createTreeWalker(el.querySelectorAll('li')[20], 4).nextNode() as Text;
    const a = serializeBlockWithCaret(el, BlockKind.List, tn, 3, { editing: true });
    const b = serializeBlockWithCaret(el, BlockKind.List, tn, 3, { editing: true, uncached: true });
    expect(a).toBe(b);
    expect(a!.includes(CARET_MARK)).toBe(true);
    // the caret item is never cached: a following plain serialization has no mark
    expect(serializeBlock(el, BlockKind.List, { editing: true }).includes(CARET_MARK)).toBe(false);
    el.remove();
  });
});

describe('list cache: random DOM edits, cached === uncached', () => {
  const ALPHA = ['a', 'b', ' ', '\u00a0', '*', '_', '`', '[', ']', '#', '1.', '-', '$', '\\', '<', '&', '~', '|', '中', '😀', '\n'];
  const SEEDS = FULL ? 120 : 10;
  const STEPS = FULL ? 120 : 30;

  it(`${SEEDS} seeds × ${STEPS} edits`, () => {
    let compared = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      resetListCache();
      const r = rng(seed * 7919);
      const pick = <T>(a: ArrayLike<T>): T => a[Math.floor(r() * a.length)];
      const el = mount(listSource(r, 8 + Math.floor(r() * 30), seed % 4));
      const list = el.querySelector(':scope > ul, :scope > ol') as HTMLElement;
      const textNodes = (): Text[] => {
        const out: Text[] = [];
        const w = document.createTreeWalker(list, 4);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (!(n.parentElement?.closest('.md-math'))) out.push(n as Text);
        return out;
      };
      const items = (): Element[] => Array.from(list.children).filter((c) => c.tagName === 'LI');
      for (let step = 0; step < STEPS; step++) {
        const op = Math.floor(r() * 13);
        const ts = textNodes();
        const lis = items();
        try {
          if (op <= 3 && ts.length) {                       // type a character
            const t = pick(ts); const at = Math.floor(r() * (t.data.length + 1));
            t.data = t.data.slice(0, at) + pick(ALPHA) + t.data.slice(at);
          } else if (op === 4 && ts.length) {               // delete a character
            const t = pick(ts); const at = Math.floor(r() * t.data.length);
            t.data = t.data.slice(0, at) + t.data.slice(at + 1);
          } else if (op === 5 && ts.length) {               // format part of a text
            const t = pick(ts);
            if (t.data.length > 1) {
              const tail = t.splitText(Math.floor(r() * t.data.length));
              const e = document.createElement(pick(['strong', 'em', 'del', 'code', 'b']));
              tail.replaceWith(e); e.append(tail);
            }
          } else if (op === 6 && lis.length) {              // duplicate an item
            list.insertBefore(pick(lis).cloneNode(true), pick(lis));
          } else if (op === 7 && lis.length > 1) {          // remove an item
            pick(lis).remove();
          } else if (op === 8 && lis.length > 1) {          // move an item
            list.insertBefore(pick(lis), pick(lis));
          } else if (op === 9) {                            // toggle a checkbox / renumber
            const box = el.querySelector('input');
            if (box && r() < 0.5) (box as HTMLInputElement).checked = !(box as HTMLInputElement).checked;
            else if (list.tagName === 'OL') list.setAttribute('start', String(Math.floor(r() * 12)));
          } else if (op === 10 && lis.length) {             // nested list / paragraph (loose) / break
            const li = pick(lis);
            const k = r();
            if (k < 0.4) { const ul = document.createElement('ul'); ul.innerHTML = '<li>nested *x*</li>'; li.append(ul); }
            else if (k < 0.7) { const p = document.createElement('p'); while (li.firstChild && li.firstChild.nodeName !== 'UL') p.append(li.firstChild); li.prepend(p); }
            else if (ts.length) { const t = pick(ts); t.parentNode!.insertBefore(document.createElement('br'), t.nextSibling); }
          } else if (op === 11 && ts.length) {              // browser editing artefacts
            const t = pick(ts);
            const sp = document.createElement('span'); sp.setAttribute('style', 'font-size: 16px'); sp.textContent = 's';
            t.parentNode!.insertBefore(sp, t);
          } else if (op === 12 && lis.length) {             // empty an item
            pick(lis).replaceChildren();
          }
        } catch { /* an edit that does not apply here is skipped */ }
        if (items().length === 0) break;
        for (const editing of [true, false]) {
          const a = serializeBlock(el, BlockKind.List, { editing });
          const b = serializeBlock(el, BlockKind.List, { editing, uncached: true });
          if (a !== b) {
            throw new Error(`seed ${seed} step ${step} op ${op} editing ${editing}: cached != uncached\nDOM: ${list.outerHTML.slice(0, 2000)}\ncached:\n${a}\nuncached:\n${b}`);
          }
          compared++;
        }
        const tnow = textNodes();
        if (tnow.length && r() < 0.3) {
          const t = pick(tnow); const at = Math.floor(r() * (t.data.length + 1));
          const a = serializeBlockWithCaret(el, BlockKind.List, t, at, { editing: true });
          const b = serializeBlockWithCaret(el, BlockKind.List, t, at, { editing: true, uncached: true });
          if (a !== b) throw new Error(`seed ${seed} step ${step}: caret cached != uncached\ncached:\n${a}\nuncached:\n${b}`);
        }
      }
      el.remove();
    }
    expect(compared).toBeGreaterThan(SEEDS * 10);
  }, FULL ? 600_000 : 60_000);
});
