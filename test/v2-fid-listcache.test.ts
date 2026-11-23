// @vitest-environment jsdom
// verify-fidelity (0.2.0 stage 2a), I4: the per-item list cache of src/preview/serialize.ts must give
// exactly the one-pass (uncached) serialization after ANY sequence of edits on the SAME live element.
// The cache only applies to a block that is one list of ≥ 8 items, so every list here has 8–40 items, of
// mixed kinds, and the edits are structural (remove / insert / move / split / merge items, change
// looseness, start number, checkbox state, nested list type) as well as textual.
// MDR_FID_N lists (default 300), MDR_FID_SEED (default 11).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { CARET_MARK, listCacheStats, resetListCache, serializeBlock, serializeBlockWithCaret } from '../src/preview/serialize';

const N = Number(process.env.MDR_FID_N ?? 300);
const SEED = Number(process.env.MDR_FID_SEED ?? 11);
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
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  document.body.appendChild(w);
  return w;
}
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const BODIES = ['项目 **粗** `c`', 'a [l](https://e.example/x) b', '$x^2$ and $5', 'snake_case a * b', '~~d~~ ~ x', '&nbsp;a&nbsp;b', 'trail \\\\', 'C:\\d', '😀 中文', 'https://bare.example/p q', '<kbd>K</kbd>', '[ ] not a task'];
function listSrc(r: () => number): string {
  const n = 8 + Math.floor(r() * 33);
  const kind = Math.floor(r() * 4); // 0 bullet 1 ordered 2 task 3 ordered from start
  const loose = r() < 0.3;
  const start = kind === 3 ? Math.floor(r() * 120) : 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = kind === 1 || kind === 3 ? `${start + i}.` : '-';
    const ind = ' '.repeat(m.length + 1);
    let it = `${m} ${kind === 2 ? (r() < 0.5 ? '[ ] ' : '[x] ') : ''}${BODIES[Math.floor(r() * BODIES.length)]} ${i}`;
    const x = r();
    if (x < 0.12) it += `\n${ind}- nested ${i}\n${ind}  1. deeper ${i}`;
    else if (x < 0.18) it += `\n${ind}1. nested ord ${i}\n${ind}2. two`;
    else if (x < 0.22) it += `\n\n${ind}\`\`\`\n${ind}code ${i}\n${ind}\`\`\``;
    else if (x < 0.26) it += `\n\n${ind}> quote ${i}`;
    else if (x < 0.29) it += `\n\n${ind}| a | b |\n${ind}|---|:-:|\n${ind}| ${i} | y |`;
    else if (x < 0.33) it += `\n\n${ind}second paragraph ${i}`;
    else if (x < 0.37) it += `  \n${ind}hard break ${i}`;
    out.push(it);
  }
  return out.join(loose ? '\n\n' : '\n');
}
function items(w: Element): HTMLLIElement[] {
  const list = w.querySelector(':scope > ul, :scope > ol');
  return list ? Array.from(list.children).filter((c) => c.tagName === 'LI') as HTMLLIElement[] : [];
}
function mutate(r: () => number, w: Element): string {
  const list = w.querySelector(':scope > ul, :scope > ol')!;
  const its = items(w);
  if (its.length === 0) return 'none';
  const li = its[Math.floor(r() * its.length)];
  const k = Math.floor(r() * 13);
  const doc = w.ownerDocument;
  switch (k) {
    case 0: { li.remove(); return 'remove'; }
    case 1: { const c = li.cloneNode(true); li.after(c); return 'duplicate'; }
    case 2: { const o = its[Math.floor(r() * its.length)]; if (o !== li) o.before(li); return 'move'; }
    case 3: { const tw = doc.createTreeWalker(li, 4); const t = tw.nextNode() as Text | null; if (t) t.data = ''; return 'empty-first-text'; }
    case 4: { // split: browser Enter in the middle of the first text
      const tw = doc.createTreeWalker(li, 4); const t = tw.nextNode() as Text | null;
      if (!t || t.data.length < 2) return 'split-skip';
      const at = Math.floor(t.data.length / 2); const tail = t.data.slice(at); t.data = t.data.slice(0, at);
      const n = doc.createElement('li'); n.textContent = tail; li.after(n); return 'split';
    }
    case 5: { const nx = li.nextElementSibling; if (nx) { while (nx.firstChild) li.appendChild(nx.firstChild); nx.remove(); } return 'merge'; }
    case 6: { const p = doc.createElement('p'); p.textContent = 'added para'; li.appendChild(p); return 'add-p (looseness)'; }
    case 7: { for (const p of Array.from(list.querySelectorAll(':scope > li > p'))) { while (p.firstChild) p.before(p.firstChild); p.remove(); } return 'unwrap-all-p'; }
    case 8: { const cb = li.querySelector('input[type=checkbox]') as HTMLInputElement | null; if (cb) cb.checked = !cb.checked; return 'toggle-checkbox'; }
    case 9: { if (list.tagName === 'OL') { list.setAttribute('start', String(Math.floor(r() * 50))); return 'start'; } return 'start-skip'; }
    case 10: { const nest = li.querySelector('ul, ol'); if (nest) { const repl = doc.createElement(nest.tagName === 'UL' ? 'ol' : 'ul'); while (nest.firstChild) repl.appendChild(nest.firstChild); nest.replaceWith(repl); return 'nested-type'; } return 'nested-skip'; }
    case 11: { const tw = doc.createTreeWalker(li, 4); const ts: Text[] = []; for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!(n as Text).parentElement?.closest('pre, code, .md-math')) ts.push(n as Text); const t = ts[Math.floor(r() * ts.length)]; if (t) t.data += ['*', '$', '~', '[', ']', '\u00a0', ' 1. ', '`'][Math.floor(r() * 8)]; return 'text'; }
    default: { li.replaceChildren(); return 'clear-item'; }
  }
}

describe('verify-fidelity I4: list cache after structural edit sequences', () => {
  it(`${N} lists × up to 12 edits: cached === uncached (also with a caret mark)`, () => {
    const r = rng(SEED);
    const bad: string[] = [];
    let compares = 0;
    resetListCache();
    const t0 = Date.now();
    for (let d = 0; d < N && Date.now() - t0 < 7_000; d++) {
      const src = listSrc(r);
      const w = mount(src);
      const hints = { editing: true, ...(r() < 0.3 ? { keepNbsp: true } : {}) };
      const seq: string[] = [];
      serializeBlock(w, BlockKind.List, hints);          // fill the cache
      const steps = 1 + Math.floor(r() * 12);
      for (let s = 0; s < steps; s++) {
        seq.push(mutate(r, w));
        const a = serializeBlock(w, BlockKind.List, hints);
        const b = serializeBlock(w, BlockKind.List, { ...hints, uncached: true });
        compares++;
        if (a !== b) { bad.push(`list ${d} after [${seq.join(', ')}]\nsrc ${JSON.stringify(src.slice(0, 300))}\ncached   ${JSON.stringify(a.slice(0, 400))}\nuncached ${JSON.stringify(b.slice(0, 400))}`); break; }
        // caret variant: caret in a random text node of a random item
        const its = items(w);
        if (its.length > 0) {
          const li = its[Math.floor(r() * its.length)];
          const tw = document.createTreeWalker(li, 4);
          // harness repair (fix-serial, round 3): a caret is never inside a formula (a session makes .md-math
          // contenteditable=false); take the item's first text node outside one
          let t = tw.nextNode() as Text | null;
          while (t && t.parentElement?.closest('.md-math')) t = tw.nextNode() as Text | null;
          if (t) {
            const off = Math.floor(r() * (t.data.length + 1));
            const ca = serializeBlockWithCaret(w, BlockKind.List, t, off, hints);
            const cb = serializeBlockWithCaret(w, BlockKind.List, t, off, { ...hints, uncached: true });
            compares++;
            if (ca !== cb) { bad.push(`caret list ${d} after [${seq.join(', ')}]\ncached   ${JSON.stringify(ca)}\nuncached ${JSON.stringify(cb)}`); break; }
            if (ca !== null && !ca.includes(CARET_MARK)) { bad.push(`caret mark lost in list ${d}`); break; }
          }
        }
      }
      w.remove();
    }
    console.log(`I4: ${compares} comparisons, cache hits ${listCacheStats.hits}, misses ${listCacheStats.misses}, mismatches ${bad.length}`);
    for (const b of bad.slice(0, 8)) console.log(b);
    expect(listCacheStats.hits).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  }, 20_000);

  it('1000-item list: edit one item, cache equals uncached and hits 999', () => {
    resetListCache();
    const src = Array.from({ length: 1000 }, (_, i) => `${i + 1}. item ${i} **b** $x$`).join('\n');
    const w = mount(src);
    serializeBlock(w, BlockKind.List, { editing: true });
    const li = items(w)[500];
    (li.firstChild as Text).data += ' typed*';
    listCacheStats.hits = 0; listCacheStats.misses = 0;
    const a = serializeBlock(w, BlockKind.List, { editing: true });
    expect(listCacheStats.misses).toBe(1);
    expect(a).toBe(serializeBlock(w, BlockKind.List, { editing: true, uncached: true }));
    w.remove();
  }, 20_000);
});
