// Adversarial review (verify:review#2, 2026-11-20) of the 0.1.1 hotfix's open queue
// (electron/openQueue.mjs). Each test states the behaviour the user expects; a failing test is a
// demonstrated defect, not a flaky one.
import { describe, expect, it } from 'vitest';
import { createOpenFileQueue } from '../electron/openQueue.mjs';

function consumer() {
  const got: string[] = [];
  let live = false;
  const q = createOpenFileQueue((p: string) => {
    if (!live) return false;
    got.push(p);
    return true;
  });
  return { q, got, setLive: (v: boolean) => { live = v; } };
}

describe('review#2: open queue', () => {
  it('the window closed, A / B / A double-clicked while the next window loads: A (the last request) is shown last', () => {
    const { q, got, setLive } = consumer();
    q.reset(); // window closed
    q.push('/d/A.md');
    q.push('/d/B.md');
    q.push('/d/A.md');
    setLive(true);
    q.markReady();
    // With the window open (live queue) the same three double-clicks leave A on screen.
    expect(got.at(-1)).toBe('/d/A.md');
  });

  it('a live consumer gets A / B / A in order (reference for the case above)', () => {
    const { q, got, setLive } = consumer();
    setLive(true);
    q.markReady();
    q.push('/d/A.md');
    q.push('/d/B.md');
    q.push('/d/A.md');
    expect(got).toEqual(['/d/A.md', '/d/B.md', '/d/A.md']);
  });

  it('a path pushed while the consumer is gone is delivered exactly once to the next consumer', () => {
    const { q, got, setLive } = consumer();
    setLive(true);
    q.markReady();
    setLive(false); // window closed without reset (the original bug's state)
    q.push('/d/X.md');
    setLive(true);
    q.markReady();
    q.markReady(); // a duplicate ready-for-files
    expect(got).toEqual(['/d/X.md']);
  });
});
