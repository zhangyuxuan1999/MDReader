// @vitest-environment jsdom
// test/review-toc-active.test.ts — verifier: editing the text of the heading the cursor is in must not
// drop the TOC's `.is-active` highlight (toc.ts reconcile same-count path rewrites className).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToc } from '../src/preview/toc';
import { createBus } from '../src/shared/bus';
import type { OutlineEntry } from '../src/shared/types';

const entry = (text: string, line: number, level: OutlineEntry['level'] = 1): OutlineEntry => ({
  level, text, slug: text.toLowerCase(), line, blockId: line,
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe('review: toc keeps the active highlight while the active heading is edited', () => {
  it('same-count outline update (typing inside the active heading) keeps .is-active', () => {
    const parent = document.createElement('aside');
    document.body.appendChild(parent);
    const toc = createToc(parent, createBus());
    const nav = parent.querySelector<HTMLElement>('nav.mdr-toc')!;
    toc.setOutline([entry('Intro', 1), entry('Usage', 10)]);
    toc.setActiveLine(12);
    vi.advanceTimersByTime(17);
    const actives = (): string[] => Array.from(nav.querySelectorAll('a.is-active'), (a) => a.textContent ?? '');
    expect(actives()).toEqual(['Usage']);
    // The user types one character into the "Usage" heading: same heading count, one text differs.
    toc.setOutline([entry('Intro', 1), entry('Usages', 10)]);
    vi.advanceTimersByTime(17);
    expect(actives()).toEqual(['Usages']);
    // And a later cursor move inside the same heading must still show it active.
    toc.setActiveLine(13);
    vi.advanceTimersByTime(17);
    expect(actives()).toEqual(['Usages']);
  });
});
