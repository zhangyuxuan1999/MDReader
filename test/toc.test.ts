// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToc } from '../src/preview/toc';
import { createBus } from '../src/shared/bus';
import type { OutlineEntry } from '../src/shared/types';

const entry = (level: OutlineEntry['level'], text: string, line: number, i: number): OutlineEntry =>
  ({ level, text, slug: `${text}-${i}`, line, blockId: i + 1 });

const outline: OutlineEntry[] = [
  entry(1, '一', 1, 0), entry(2, '一点一', 10, 1), entry(3, '细节', 20, 2), entry(2, '一点二', 30, 3), entry(1, '二', 40, 4),
];

function setup() {
  const parent = document.createElement('aside');
  document.body.appendChild(parent);
  const bus = createBus();
  const toc = createToc(parent, bus);
  const nav = parent.querySelector<HTMLElement>('nav.mdr-toc')!;
  return { toc, bus, nav };
}
const items = (nav: HTMLElement): HTMLAnchorElement[] => Array.from(nav.querySelectorAll('a.mdr-toc__item'));

const frame = (): void => { vi.advanceTimersByTime(17); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('createToc', () => {
  it('renders items with level classes and data-line', () => {
    const { toc, nav } = setup();
    toc.setOutline(outline);
    const a = items(nav);
    expect(a.length).toBe(5);
    expect(a[2].className).toBe('mdr-toc__item mdr-toc__item--h3');
    expect(a[2].dataset.line).toBe('20');
    expect(a[2].textContent).toBe('细节');
    expect(nav.classList.contains('mdr-toc--collapsed')).toBe(false);
  });

  it('keeps element identity keyed on level+text; line shifts patch data-line in place', () => {
    const { toc, nav } = setup();
    toc.setOutline(outline);
    const before = items(nav);
    toc.setOutline(outline.map((e) => ({ ...e })));
    expect(items(nav)).toEqual(before);
    // Enter above every heading: only the lines change
    toc.setOutline(outline.map((e) => ({ ...e, line: e.line + 1 })));
    expect(items(nav)).toEqual(before);
    expect(items(nav).map((a) => a.dataset.line)).toEqual(['2', '11', '21', '31', '41']);
    toc.setActiveLine(21);
    expect(nav.querySelector('.is-active')!.textContent).toBe('细节');
    // append: every existing entry keeps its element
    toc.setOutline([...outline, entry(2, '二点一', 50, 5)]);
    expect(items(nav).slice(0, 5)).toEqual(before);
    expect(items(nav).length).toBe(6);
    // insert in the middle: untouched entries keep their element
    const grown = [outline[0], outline[1], entry(3, '新', 15, 9), ...outline.slice(2), entry(2, '二点一', 50, 5)];
    toc.setOutline(grown);
    const after = items(nav);
    expect(after.length).toBe(7);
    expect([after[0], after[1], after[3], after[4], after[5]]).toEqual(before);
    expect(after[2].textContent).toBe('新');
    expect(after.map((a) => a.dataset.line)).toEqual(['1', '10', '15', '20', '30', '40', '50']);
    // typing inside a heading rewrites that entry in place
    const typed = grown.map((e, i) => (i === 3 ? { ...e, text: '细节x', slug: 'xi' } : e));
    toc.setOutline(typed);
    expect(items(nav)[3]).toBe(after[3]);
    expect(after[3].textContent).toBe('细节x');
    expect(after[3].getAttribute('href')).toBe('#xi');
    // removal in the middle
    toc.setOutline(typed.filter((_, i) => i !== 2));
    expect(items(nav).length).toBe(6);
    expect(items(nav)[2]).toBe(after[3]);
  });

  it('setOutline reads no layout, even for thousands of entries', () => {
    const { toc, nav } = setup();
    Object.defineProperty(nav, 'clientHeight', { value: 100, configurable: true });
    let reads = 0;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { reads++; return 0; } });
    try {
      const many = Array.from({ length: 6000 }, (_, i) => entry(2, `h${i}`, i * 10 + 1, i));
      toc.setOutline(many);
      toc.setActiveLine(30_001);
      // the first build of a large outline is sliced across frames; let it finish (no reveal: an outline
      // never scrolls the nav, only a cursor move does)
      for (let i = 0; i < 40; i++) frame();
      expect(items(nav).length).toBe(6000);
      expect(reads).toBe(0);
      // two real cursor moves, so the reveal bookkeeping is primed on h3000
      toc.setActiveLine(1);
      frame();
      toc.setActiveLine(30_001);
      frame();
      reads = 0;
      for (let k = 1; k <= 5; k++) {
        // Enter above the headings: the outline shifts, then the cursor event of the same keystroke follows
        toc.setOutline(many.map((e) => ({ ...e, line: e.line + k })));
        toc.setActiveLine(30_001 + k);
        frame();
      }
      expect(reads).toBe(0);
      expect(items(nav)[3000].dataset.line).toBe(String(3000 * 10 + 6));
      expect(nav.querySelector('.is-active')!.textContent).toBe('h3000');
      toc.setActiveLine(30_016);
      frame();
      expect(nav.querySelector('.is-active')!.textContent).toBe('h3001');
      expect(reads).toBe(1);   // one read for the reveal of the newly active item, none per outline
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', desc);
    }
  });

  it('builds a very large first outline in frame slices instead of one long task', () => {
    const { toc, nav } = setup();
    const many = Array.from({ length: 6000 }, (_, i) => entry(2, `h${i}`, i * 10 + 1, i));
    toc.setOutline(many);
    const first = items(nav).length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6000);          // sliced: the rest lands on later frames
    for (let i = 0; i < 40; i++) frame();
    expect(items(nav).length).toBe(6000);
    expect(items(nav).map((a) => a.dataset.line).slice(0, 3)).toEqual(['1', '11', '21']);
    // an outline that lands mid-build (here: after it finished) still reconciles incrementally
    const before = items(nav);
    toc.setOutline(many.map((e) => ({ ...e, line: e.line + 1 })));
    expect(items(nav)).toEqual(before);
    toc.setActiveLine(30_002);
    frame();
    expect(nav.querySelector('.is-active')!.textContent).toBe('h3000');
  });

  it('restarts the build when a structural outline change lands while it is still slicing', () => {
    const { toc, nav } = setup();
    const many = Array.from({ length: 4000 }, (_, i) => entry(2, `h${i}`, i * 10 + 1, i));
    toc.setOutline(many);
    expect(items(nav).length).toBeLessThan(4000);
    const shorter = many.slice(0, 1500).map((e, i) => ({ ...e, text: `x${i}`, slug: `x${i}` }));
    toc.setOutline(shorter);
    for (let i = 0; i < 40; i++) frame();
    const a = items(nav);
    expect(a.length).toBe(1500);
    expect(a.map((x) => x.textContent).slice(0, 2)).toEqual(['x0', 'x1']);
    expect(a[1499].dataset.line).toBe(String(1499 * 10 + 1));
    toc.setActiveLine(1499 * 10 + 5);
    frame();
    expect(nav.querySelector('.is-active')!.textContent).toBe('x1499');
  });

  it('selects the last entry at or before the cursor line', () => {
    const { toc, nav } = setup();
    toc.setOutline(outline);
    const active = (): string | undefined => nav.querySelector<HTMLElement>('.is-active')?.dataset.line;
    toc.setActiveLine(0);
    expect(active()).toBeUndefined();
    toc.setActiveLine(1);
    expect(active()).toBe('1');
    toc.setActiveLine(25);
    expect(active()).toBe('20');
    toc.setActiveLine(30);
    expect(active()).toBe('30');
    toc.setActiveLine(9999);
    expect(active()).toBe('40');
    expect(nav.querySelectorAll('.is-active').length).toBe(1);
  });

  it('scrolls the active item into view only when it is outside the visible box', () => {
    const { toc, nav } = setup();
    const many = Array.from({ length: 50 }, (_, i) => entry(2, `h${i}`, i * 10 + 1, i));
    toc.setOutline(many);
    Object.defineProperty(nav, 'clientHeight', { value: 100, configurable: true });
    const anchors = items(nav);
    anchors.forEach((a, i) => {
      Object.defineProperty(a, 'offsetTop', { value: i * 20, configurable: true });
      Object.defineProperty(a, 'offsetHeight', { value: 20, configurable: true });
      a.scrollIntoView = vi.fn();
    });
    toc.setActiveLine(21);   // item 2, offset 40 → inside [0, 100)
    frame();
    expect(anchors[2].scrollIntoView).not.toHaveBeenCalled();
    toc.setActiveLine(201);  // item 20, offset 400 → outside
    frame();
    expect(anchors[20].scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    nav.scrollTop = 400;
    toc.setActiveLine(211);  // item 21, offset 420 → inside [400, 500)
    frame();
    expect(anchors[21].scrollIntoView).not.toHaveBeenCalled();
    // a transient change within one frame (outline before cursor) reveals nothing
    toc.setActiveLine(401);
    toc.setActiveLine(211);
    frame();
    expect(anchors[40].scrollIntoView).not.toHaveBeenCalled();
  });

  it('emits nav:gotoLine on click', () => {
    const { toc, bus, nav } = setup();
    toc.setOutline(outline);
    const seen: unknown[] = [];
    bus.on('nav:gotoLine', (e) => { seen.push(e); });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    items(nav)[3].dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ line: 30, source: 'toc' }]);
  });

  it('gives levels ≥ 3 no element at all while a very large outline is collapsed', () => {
    const { toc, nav } = setup();
    const huge = Array.from({ length: 6000 }, (_, i) => entry(((i % 6) + 1) as OutlineEntry['level'], `h${i}`, i + 1, i));
    toc.setOutline(huge);
    for (let i = 0; i < 60; i++) frame();
    expect(nav.classList.contains('mdr-toc--collapsed')).toBe(true);
    expect(nav.querySelector('.mdr-toc__expand')!.textContent).toBe('展开全部层级');
    // 1/3 of the entries are level 1 or 2 — the other 4000 anchors are never created
    expect(items(nav).length).toBe(2000);
    expect(items(nav).every((a) => /--h[12]\b/.test(a.className))).toBe(true);
    // lines shift (Enter above everything): still no deep items, prefix items keep their element
    const before = items(nav);
    toc.setOutline(huge.map((e) => ({ ...e, line: e.line + 1 })));
    for (let i = 0; i < 60; i++) frame();
    expect(items(nav)).toEqual(before);
    expect(items(nav)[0].dataset.line).toBe('2');
    // expanding materializes the deep levels (sliced)
    nav.querySelector<HTMLButtonElement>('.mdr-toc__expand')!.click();
    for (let i = 0; i < 60; i++) frame();
    expect(nav.classList.contains('mdr-toc--collapsed')).toBe(false);
    expect(nav.querySelector('.mdr-toc__expand')!.textContent).toBe('仅显示一、二级');
    expect(items(nav).length).toBe(6000);
    expect(items(nav)[2].dataset.line).toBe('4');
    toc.setActiveLine(4);
    frame();
    expect(nav.querySelector('.is-active')!.textContent).toBe('h2');
    // collapsing again releases them
    nav.querySelector<HTMLButtonElement>('.mdr-toc__expand')!.click();
    for (let i = 0; i < 60; i++) frame();
    expect(items(nav).length).toBe(2000);
  });

  it('materializes an entry whose level rises above the collapsed cut while staying keyed', () => {
    const { toc, nav } = setup();
    const base = Array.from({ length: 4000 }, (_, i) => entry(((i % 4) + 1) as OutlineEntry['level'], `h${i}`, i + 1, i));
    toc.setOutline(base);
    for (let i = 0; i < 60; i++) frame();
    const shown = items(nav).length;
    expect(shown).toBe(2000);   // levels 1..4 cycling → half are 1 or 2
    // entry 2 was level 3 (hidden): promote it to level 2
    const promoted = base.map((e, i) => (i === 2 ? { ...e, level: 2 as OutlineEntry['level'] } : e));
    toc.setOutline(promoted);
    for (let i = 0; i < 60; i++) frame();
    expect(items(nav).length).toBe(shown + 1);
    expect(items(nav)[2].textContent).toBe('h2');
    expect(items(nav)[2].dataset.line).toBe('3');
    // and demoting it again drops the element
    toc.setOutline(base);
    for (let i = 0; i < 60; i++) frame();
    expect(items(nav).length).toBe(shown);
  });

  it('collapses levels ≥ 3 for very large outlines, with an expand toggle that survives edits', () => {
    const { toc, nav } = setup();
    const huge = Array.from({ length: 3200 }, (_, i) => entry(((i % 4) + 1) as OutlineEntry['level'], `h${i}`, i + 1, i));
    toc.setOutline(huge);
    expect(nav.classList.contains('mdr-toc--collapsed')).toBe(true);
    const btn = nav.querySelector<HTMLButtonElement>('.mdr-toc__expand')!;
    expect(nav.firstElementChild).toBe(btn);
    btn.click();
    expect(nav.classList.contains('mdr-toc--collapsed')).toBe(false);
    toc.setOutline(huge.map((e) => ({ ...e, line: e.line + 1 })));
    expect(nav.classList.contains('mdr-toc--collapsed')).toBe(false);   // the user's choice is kept
    expect(nav.querySelector('.mdr-toc__expand')).toBe(btn);
    toc.setOutline(huge.slice(0, 10));
    expect(nav.querySelector('.mdr-toc__expand')).toBeNull();
    expect(items(nav).length).toBe(10);
  });

  it('setVisible hides the nav', () => {
    const { toc, nav } = setup();
    toc.setVisible(false);
    expect(nav.hidden).toBe(true);
    toc.setVisible(true);
    expect(nav.hidden).toBe(false);
  });
});
