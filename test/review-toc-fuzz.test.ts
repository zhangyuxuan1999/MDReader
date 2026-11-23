// @vitest-environment jsdom
// test/review-toc-fuzz.test.ts — verifier: toc.ts reconciles the nav DOM incrementally (prefix/suffix by
// level+text, in-place patch of lines/slugs). Cross-check the DOM after random outline sequences against
// what a from-scratch build would produce.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToc } from '../src/preview/toc';
import { createBus } from '../src/shared/bus';
import type { OutlineEntry } from '../src/shared/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
const TEXTS = ['一', '二', '三', 'alpha', 'beta', 'gamma', '标题 x'];
const LEVELS: OutlineEntry['level'][] = [1, 2, 3, 4];

function withSlugs(items: Array<{ level: OutlineEntry['level']; text: string; line: number }>): OutlineEntry[] {
  const seen = new Map<string, number>();
  return items.map((e, i) => {
    const base = e.text.toLowerCase().replace(/\s+/g, '-');
    const r = seen.get(base) ?? 0;
    seen.set(base, r + 1);
    return { level: e.level, text: e.text, slug: r ? `${base}-${r}` : base, line: e.line, blockId: i + 1 };
  });
}

function snapshot(nav: HTMLElement): string[] {
  return Array.from(nav.querySelectorAll<HTMLAnchorElement>('a.mdr-toc__item'), (a) =>
    `${a.className.replace(" is-active", "")}|${a.getAttribute('href')}|${a.dataset.line}|${a.textContent}|${a.title}`,
  );
}
function expected(items: OutlineEntry[]): string[] {
  return items.map((e) => `mdr-toc__item mdr-toc__item--h${e.level}|#${e.slug}|${e.line}|${e.text}|${e.text}`);
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('review: toc reconcile equals a fresh build', () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const parent = document.createElement('aside');
      document.body.appendChild(parent);
      const bus = createBus();
      const toc = createToc(parent, bus);
      const nav = parent.querySelector<HTMLElement>('nav.mdr-toc')!;
      let raw: Array<{ level: OutlineEntry['level']; text: string; line: number }> = [];
      const n0 = Math.floor(r() * 8);
      let line = 1;
      for (let i = 0; i < n0; i++) { raw.push({ level: LEVELS[Math.floor(r() * 4)], text: TEXTS[Math.floor(r() * TEXTS.length)], line }); line += 1 + Math.floor(r() * 5); }
      for (let step = 0; step < 40; step++) {
        const k = r();
        const next = raw.map((e) => ({ ...e }));
        if (k < 0.25 && next.length) {
          const i = Math.floor(r() * next.length);
          next[i].text = TEXTS[Math.floor(r() * TEXTS.length)];
        } else if (k < 0.4 && next.length) {
          const i = Math.floor(r() * next.length);
          next[i].level = LEVELS[Math.floor(r() * 4)];
        } else if (k < 0.6) {
          const i = Math.floor(r() * (next.length + 1));
          const at = i < next.length ? next[i].line : (next.length ? next[next.length - 1].line + 1 : 1);
          next.splice(i, 0, { level: LEVELS[Math.floor(r() * 4)], text: TEXTS[Math.floor(r() * TEXTS.length)], line: at });
          for (let j = i + 1; j < next.length; j++) next[j].line += 2;
        } else if (k < 0.75 && next.length) {
          const i = Math.floor(r() * next.length);
          const cnt = 1 + Math.floor(r() * 3);
          next.splice(i, cnt);
        } else if (k < 0.85) {
          const i = Math.floor(r() * (next.length + 1));
          for (let j = i; j < next.length; j++) next[j].line += 1 + Math.floor(r() * 3);
        } else if (k < 0.92) {
          // same count, everything rewritten (paste over a heading block)
          for (const e of next) { e.text = TEXTS[Math.floor(r() * TEXTS.length)]; }
        } else {
          next.length = 0;
        }
        // keep lines strictly ascending
        for (let j = 1; j < next.length; j++) if (next[j].line <= next[j - 1].line) next[j].line = next[j - 1].line + 1;
        raw = next;
        const items = withSlugs(raw);
        toc.setOutline(items);
        const ctx = `seed ${seed} step ${step}\n${JSON.stringify(items)}`;
        expect(snapshot(nav), ctx).toEqual(expected(items));
        // active item = last entry with line <= cursor line
        const cursor = 1 + Math.floor(r() * 60);
        toc.setActiveLine(cursor);
        vi.advanceTimersByTime(17);
        let want = -1;
        for (let j = 0; j < items.length; j++) if (items[j].line <= cursor) want = j;
        const active = Array.from(nav.querySelectorAll('a.mdr-toc__item')).findIndex((a) => a.classList.contains('is-active'));
        expect(active, `${ctx}\ncursor ${cursor}`).toBe(want);
      }
    });
  }
});
