// Adversarial review (verify:review#1, 2026-11-20): model-based interleavings of the open queue as
// electron/main.mjs drives it. A tiny model of the window lifecycle (none / loading / live / closing,
// renderer crash + reload) feeds the REAL createOpenFileQueue with a deliver() that, like main.mjs,
// returns true only when a live subscribed renderer took the path. Invariants checked after every
// random schedule: no path pushed is lost, no path is delivered twice to the same renderer, nothing
// is ever delivered to a dead/closing/unsubscribed renderer, and order is preserved.
import { describe, expect, it } from 'vitest';
import { createOpenFileQueue } from '../electron/openQueue.mjs';

type Win = { id: number; state: 'loading' | 'live' | 'closing' | 'dead'; subscribed: boolean; got: string[] };

function makeWorld() {
  let win: Win | null = null;
  let nextId = 1;
  const wrongDeliveries: string[] = [];
  const allGot: string[] = [];
  const q = createOpenFileQueue((p: string) => {
    if (!win || win.state !== 'live') return false; // liveWindow() === null or crashed
    if (!win.subscribed) wrongDeliveries.push(p); // sent into a page that has no listener
    win.got.push(p);
    allGot.push(p);
    return true;
  });
  const world = {
    q,
    get win() {
      return win;
    },
    wrongDeliveries,
    allGot,
    // main.mjs: ensureWindow() -> createWindow() (resets the queue) when no live window
    ensureWindow() {
      if (win && win.state === 'closing') return 'deferred';
      if (!win || win.state === 'dead') {
        win = { id: nextId++, state: 'loading', subscribed: false, got: [] };
        q.reset();
      }
      return 'ok';
    },
    openFile(p: string) {
      q.push(p);
      world.ensureWindow();
    },
    activate() {
      world.ensureWindow();
    },
    readyForFiles() {
      if (!win || win.state !== 'loading') return;
      win.state = 'live';
      win.subscribed = true;
      q.markReady();
    },
    close() {
      if (!win || win.state === 'dead' || win.state === 'closing') return;
      win.state = 'closing';
      q.reset();
    },
    closed() {
      if (!win || win.state !== 'closing') return;
      win.state = 'dead';
      win = null;
      q.reset();
    },
    crashAndReload() {
      if (!win || win.state !== 'live') return;
      // render-process-gone -> reset, then loadURL -> did-start-navigation -> reset
      win.state = 'loading';
      win.subscribed = false;
      q.reset();
    },
    reloadNavigation() {
      if (!win || win.state !== 'live') return;
      win.state = 'loading';
      win.subscribed = false;
      q.reset(); // did-start-navigation
    },
  };
  return world;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('review: open queue under random window lifecycles', () => {
  it('never loses, duplicates or mis-delivers a path across 3000 random schedules', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const w = makeWorld();
      const pushed: string[] = [];
      let n = 0;
      for (let step = 0; step < 40; step++) {
        const x = r();
        if (x < 0.3) {
          const p = `/doc/${seed}-${n++}.md`;
          pushed.push(p);
          w.openFile(p);
        } else if (x < 0.45) w.readyForFiles();
        else if (x < 0.55) w.close();
        else if (x < 0.65) {
          // the 'closed' handler: reopen if a document arrived while closing (reopenAfterClose)
          const hadPending = w.q.pending().length > 0;
          w.closed();
          if (hadPending) w.ensureWindow();
        } else if (x < 0.72) w.activate();
        else if (x < 0.8) w.crashAndReload();
        else if (x < 0.85) w.reloadNavigation();
      }
      // Drain: let the system settle (finish closing, reopen, subscribe).
      for (let i = 0; i < 4; i++) {
        const hadPending = w.q.pending().length > 0;
        w.closed();
        if (hadPending) w.ensureWindow();
        w.readyForFiles();
      }
      expect(w.wrongDeliveries, `seed ${seed}`).toEqual([]);
      // every pushed path delivered exactly once (pushes are unique here), in push order
      expect(w.allGot, `seed ${seed}`).toEqual(pushed);
      expect(w.q.pending(), `seed ${seed}`).toEqual([]);
    }
  });

  it('a path re-pushed while it is still pending is opened once', () => {
    const w = makeWorld();
    w.openFile('/a.md');
    w.openFile('/a.md');
    w.readyForFiles();
    expect(w.allGot).toEqual(['/a.md']);
  });

  it('deliver() throwing mid-flush (documents current behaviour)', () => {
    let calls = 0;
    const got: string[] = [];
    const q = createOpenFileQueue((p: string) => {
      calls++;
      if (calls === 1) throw new Error('send failed');
      got.push(p);
      return true;
    });
    q.push('/one.md');
    q.push('/two.md');
    expect(() => q.markReady()).toThrow('send failed');
    // After a throw the queue is left "ready" with paths still pending; a later push jumps the line.
    const state = { ready: q.isReady(), pending: q.pending() };
    q.push('/three.md');
    expect(state).toEqual({ ready: true, pending: ['/one.md', '/two.md'] });
    expect(got).toEqual(['/three.md']);
  });
});
