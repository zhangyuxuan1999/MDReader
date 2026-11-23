// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerClient, MAX_RESTARTS, PING_AFTER_MS, PING_WAIT_MS, RESTART_WINDOW_MS, SILENCE_MS, VIEWPORT_THROTTLE_MS } from '../src/app/workerClient';
import type { FromWorker, ToWorker, WorkerClientHandlers } from '../src/shared/types';
import { T } from '../src/shared/i18n';

/** Records posted messages; tests push worker → main messages via `emit`. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: ToWorker[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor(public url: URL, public opts?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }
  postMessage(m: ToWorker): void {
    this.posted.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(m: FromWorker | { type: string }): void {
    this.onmessage?.({ data: m } as MessageEvent);
  }
  crash(): void {
    this.onerror?.({ message: 'crash', preventDefault() {} } as unknown as ErrorEvent);
  }
}

const structure = (version: number): FromWorker => ({
  type: 'structure', version, blocks: new Int32Array(0), changed: new Int32Array(0), lineCount: 1,
  stats: { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: 1, readingMinutes: 0 }, outlineVersion: 0,
});

const delta = (version: number): FromWorker => ({
  type: 'structureDelta', version, index: 3, removed: 1, inserted: new Int32Array([7, 4, 2, 0]), lineDelta: 1,
  changed: new Int32Array([7]), lineCount: 9,
  stats: { chars: 9, charsNoSpace: 8, cjk: 0, latinWords: 2, lines: 9, readingMinutes: 1 }, outlineVersion: 2,
});

function handlers(): WorkerClientHandlers & { errors: Array<[string, boolean]> } {
  const errors: Array<[string, boolean]> = [];
  return {
    errors,
    onStructure: vi.fn(), onStructureDelta: vi.fn(), onOutline: vi.fn(), onHtml: vi.fn(), onIdle: vi.fn(), onDraftSaved: vi.fn(),
    onError: (m, fatal) => errors.push([m, fatal]),
    onRestart: vi.fn(() => ({ docId: 'd', version: 5, text: 'hello' })),
  };
}

const current = (): FakeWorker => FakeWorker.instances[FakeWorker.instances.length - 1];
const types = (w: FakeWorker): string[] => w.posted.map((m) => m.type);

describe('createWorkerClient', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a module worker and posts init first', () => {
    const client = createWorkerClient(handlers());
    const w = current();
    expect(w.opts?.type).toBe('module');
    expect(String(w.url)).toMatch(/render\.worker\.ts/);
    expect(w.posted[0]).toMatchObject({ type: 'init', options: { math: true, highlight: true } });
    client.dispose();
    expect(w.terminated).toBe(true);
  });

  it('forwards validated messages to handlers and ignores junk', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    const w = current();
    w.emit({ type: 'bogus' });
    w.emit({ type: 'ready' });
    w.emit({ type: 'outline', outlineVersion: 1, items: [] });
    w.emit({ type: 'idle', version: 3 });
    w.emit({ type: 'draftSaved', docId: 'd', version: 3, at: 1 });
    w.emit({ type: 'error', message: 'katex', fatal: false });
    expect(h.onOutline).toHaveBeenCalledWith([]);
    expect(h.onIdle).toHaveBeenCalledWith(3);
    expect(h.onDraftSaved).toHaveBeenCalledWith('d', 3, 1);
    expect(h.errors).toEqual([['katex', false]]);
    expect(FakeWorker.instances).toHaveLength(1);
    client.dispose();
  });

  it('throttles viewport to one message per 100 ms, last wins', () => {
    const client = createWorkerClient(handlers());
    const w = current();
    client.viewport(1, 10);
    client.viewport(2, 20);
    client.viewport(3, 30);
    const vps = () => w.posted.filter((m) => m.type === 'viewport');
    expect(vps()).toEqual([{ type: 'viewport', firstLine: 1, lastLine: 10 }]);
    vi.advanceTimersByTime(VIEWPORT_THROTTLE_MS - 1);
    expect(vps()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(vps()).toHaveLength(2);
    expect(vps()[1]).toEqual({ type: 'viewport', firstLine: 3, lastLine: 30 });
    vi.advanceTimersByTime(500);
    expect(vps()).toHaveLength(2);
    client.dispose();
  });

  it('coalesces need() per animation frame and dedupes ids', () => {
    const client = createWorkerClient(handlers());
    const w = current();
    client.need([1, 2]);
    client.need([2, 3]);
    client.need([]);
    expect(types(w)).toEqual(['init']);
    vi.advanceTimersByTime(20);
    const needs = w.posted.filter((m) => m.type === 'need');
    expect(needs).toEqual([{ type: 'need', ids: [1, 2, 3] }]);
    client.dispose();
  });

  it('resolves exportHtml by requestId', async () => {
    const client = createWorkerClient(handlers());
    const w = current();
    const p1 = client.exportHtml();
    const p2 = client.exportHtml();
    const reqs = w.posted.filter((m): m is Extract<ToWorker, { type: 'exportHtml' }> => m.type === 'exportHtml');
    expect(reqs.map((r) => r.requestId)).toEqual([1, 2]);
    w.emit({ type: 'exportHtml', requestId: 2, html: '<p>two</p>' });
    w.emit({ type: 'exportHtml', requestId: 1, html: '<p>one</p>' });
    await expect(p1).resolves.toBe('<p>one</p>');
    await expect(p2).resolves.toBe('<p>two</p>');
    client.dispose();
  });

  it('restarts on worker error: terminate, new worker, init, setDoc(onRestart()), toast', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    const first = current();
    const pending = client.exportHtml();
    pending.catch(() => {});
    first.crash();
    expect(first.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    const second = current();
    expect(h.onRestart).toHaveBeenCalledTimes(1);
    expect(second.posted).toEqual([
      { type: 'init', options: expect.any(Object) },
      { type: 'setDoc', docId: 'd', version: 5, text: 'hello' },
    ]);
    expect(h.errors).toEqual([[T.rendererRestarted, false]]);
    return expect(pending).rejects.toThrow(/restarted/).then(() => client.dispose());
  });

  it('restart replays the accumulated setOptions and the draft enable state', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    client.setOptions({ math: false });
    client.setOptions({ breaks: true });
    client.draft('enable');
    client.draft('flush');
    current().crash();
    expect(types(current())).toEqual(['init', 'setOptions', 'setDoc', 'draft']);
    expect(current().posted[1]).toEqual({ type: 'setOptions', options: { math: false, breaks: true } });
    expect(current().posted[3]).toEqual({ type: 'draft', action: 'enable' });
    // disable → not replayed
    client.draft('disable');
    current().emit(structure(5));
    current().crash();
    expect(types(current())).toEqual(['init', 'setOptions', 'setDoc']);
    client.dispose();
  });

  it('restart replays the last viewport after setDoc (the new worker starts at lines 1..1)', () => {
    const client = createWorkerClient(handlers());
    client.setDoc('d', 1, 'x');
    current().emit(structure(1));
    client.viewport(3000, 3040);
    vi.advanceTimersByTime(VIEWPORT_THROTTLE_MS + 1);
    expect(current().posted.at(-1)).toEqual({ type: 'viewport', firstLine: 3000, lastLine: 3040 });

    current().crash();
    const after = current();
    expect(types(after)).toEqual(['init', 'setDoc', 'viewport']);
    const i = types(after).indexOf('viewport');
    expect(i).toBeGreaterThan(types(after).indexOf('setDoc'));
    expect(after.posted[i]).toEqual({ type: 'viewport', firstLine: 3000, lastLine: 3040 });
    client.dispose();
  });

  // findings-final / lead decision 5: the s07b flake. The preview sends a window ONCE (it re-emits only
  // when the first/last line changes), so a window swallowed by the 100 ms throttle and then dropped by
  // the restart left the new worker auto-pushing lines 1..84 while the user was editing at line 3000.
  it('restart replays the newest window even when the throttle was still holding it', () => {
    const client = createWorkerClient(handlers());
    client.setDoc('d', 1, 'x');
    current().emit(structure(1));
    client.viewport(1, 84);
    vi.advanceTimersByTime(10);
    // the preview moves to line 3000; this one is still inside the throttle window when the worker dies
    client.viewport(2935, 3076);
    expect(current().posted.filter((m) => m.type === 'viewport')).toHaveLength(1);
    current().crash();

    const after = current();
    expect(types(after)).toEqual(['init', 'setDoc', 'viewport']);
    expect(after.posted.at(-1)).toEqual({ type: 'viewport', firstLine: 2935, lastLine: 3076 });
    // the dropped throttle timer must not fire a stale duplicate into the new worker either
    vi.advanceTimersByTime(VIEWPORT_THROTTLE_MS * 5);
    expect(after.posted.filter((m) => m.type === 'viewport')).toHaveLength(1);
    // …and a genuinely new window still gets through afterwards
    client.viewport(4000, 4100);
    vi.advanceTimersByTime(VIEWPORT_THROTTLE_MS + 1);
    expect(after.posted.at(-1)).toEqual({ type: 'viewport', firstLine: 4000, lastLine: 4100 });
    client.dispose();
  });

  // CONTRACT §8 / lead decision 4.
  it('resync() posts one coalesced resync per animation frame', () => {
    const client = createWorkerClient(handlers());
    const w = current();
    client.resync();
    client.resync();
    client.resync();
    expect(types(w)).toEqual(['init']);
    vi.advanceTimersByTime(20);
    expect(w.posted.filter((m) => m.type === 'resync')).toEqual([{ type: 'resync' }]);
    // a later rejection asks again
    client.resync();
    vi.advanceTimersByTime(20);
    expect(w.posted.filter((m) => m.type === 'resync')).toHaveLength(2);
    client.dispose();
  });

  it('a resync waiting for its frame is dropped by a restart (the restart sends a full structure itself)', () => {
    const client = createWorkerClient(handlers());
    client.resync();
    current().crash();
    vi.advanceTimersByTime(50);
    expect(types(current())).toEqual(['init', 'setDoc']);
    client.dispose();
  });

  it('an unanswered resync arms the request watchdog like any other request', () => {
    const client = createWorkerClient(handlers());
    client.resync();
    vi.advanceTimersByTime(20);
    expect(current().posted.at(-1)).toEqual({ type: 'resync' });
    vi.advanceTimersByTime(PING_AFTER_MS);
    expect(current().posted.at(-1)).toMatchObject({ type: 'init' }); // ping
    expect(FakeWorker.instances).toHaveLength(1);
    vi.advanceTimersByTime(PING_WAIT_MS);
    expect(FakeWorker.instances).toHaveLength(2);
    client.dispose();
  });

  it('exportHtml asks for html-only math output (standalone export, CONTRACT §6)', () => {
    const client = createWorkerClient(handlers());
    void client.exportHtml().catch(() => {});
    expect(current().posted.at(-1)).toEqual({ type: 'exportHtml', requestId: 1, mathOutput: 'html' });
    client.dispose();
  });

  it('restarts on a fatal error message and on 10 s of structure silence', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    current().emit({ type: 'error', message: 'oom', fatal: true });
    expect(FakeWorker.instances).toHaveLength(2);
    expect(h.errors).toEqual([['oom', true], [T.rendererRestarted, false]]);

    // The restart itself sent setDoc → silence timer is armed; a structure reply clears it.
    current().emit(structure(5));
    vi.advanceTimersByTime(SILENCE_MS + 1);
    expect(FakeWorker.instances).toHaveLength(2);

    client.edit(6, [{ from: 0, to: 0, insert: 'x' }]);
    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(FakeWorker.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWorker.instances).toHaveLength(3);
    client.dispose();
  });

  // A worker killed by the OS fires no error event; a reader who only scrolls never sends setDoc/edit,
  // so the request watchdog is the only thing that can notice (findings: s07c silent death).
  it('detects a silently killed worker while only reading: need arms a ping, then a restart', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    const first = current();
    client.setDoc('d', 1, 'hello');
    first.emit(structure(1)); // clears the setDoc silence timer
    client.need([1, 2]);
    vi.advanceTimersByTime(20); // rAF → 'need' posted, watchdog armed
    expect(types(first)).toContain('need');
    vi.advanceTimersByTime(PING_AFTER_MS);
    expect(first.posted.at(-1)).toMatchObject({ type: 'init' }); // ping, answered with 'ready' by a live worker
    expect(FakeWorker.instances).toHaveLength(1);
    vi.advanceTimersByTime(PING_WAIT_MS);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(h.onRestart).toHaveBeenCalledTimes(1);
    expect(types(current())).toEqual(['init', 'setDoc']);
    expect(h.errors).toEqual([[T.rendererRestarted, false]]);
    client.dispose();
  });

  it('never restarts a worker that is only quiet (viewport with nothing to do): the ping is answered', () => {
    const client = createWorkerClient(handlers());
    client.setOptions({ math: false });
    const w = current();
    client.viewport(1, 40);
    vi.advanceTimersByTime(PING_AFTER_MS);
    // The ping carries the effective options so the probe cannot change the worker's rendering.
    expect(w.posted.at(-1)).toEqual({ type: 'init', options: expect.objectContaining({ math: false }) });
    w.emit({ type: 'ready' });
    vi.advanceTimersByTime(SILENCE_MS * 3);
    expect(FakeWorker.instances).toHaveLength(1);
    client.dispose();
  });

  it('any reply disarms the request watchdog', () => {
    const client = createWorkerClient(handlers());
    const w = current();
    client.need([7]);
    vi.advanceTimersByTime(20);
    w.emit({ type: 'idle', version: 1 });
    vi.advanceTimersByTime(SILENCE_MS * 3);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(w.posted.filter((m) => m.type === 'init')).toHaveLength(1); // no ping needed
    client.dispose();
  });

  // CONTRACT §7: an edit is answered with a delta, not a full structure — it must reach the handler
  // and it must count as the reply that ends the 10 s structure-silence window.
  it('forwards structureDelta and lets it satisfy the structure-silence watchdog', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    client.edit(6, [{ from: 0, to: 0, insert: 'x' }]);
    current().emit(delta(6));
    expect(h.onStructureDelta).toHaveBeenCalledTimes(1);
    expect((h.onStructureDelta as unknown as { mock: { calls: [{ index: number }][] } }).mock.calls[0][0].index).toBe(3);
    expect(h.onStructure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(FakeWorker.instances).toHaveLength(1);
    client.dispose();
  });

  it('stops spawning after 3 restarts within a minute and reports a fatal error', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    for (let i = 0; i < MAX_RESTARTS; i++) {
      current().crash();
      vi.advanceTimersByTime(1000);
    }
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 1);
    current().crash();
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 1);
    expect(current().terminated).toBe(true);
    expect(h.errors[h.errors.length - 1]).toEqual([T.rendererFailed, true]);
    // While the window is full nothing spawns a worker: silence timers and further errors are inert.
    client.setDoc('d', 1, '');
    vi.advanceTimersByTime(SILENCE_MS * 2);
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 1);
    // …and the fatal notice is reported once per exhausted window, not once per refused attempt.
    expect(h.errors.filter(([m, fatal]) => fatal && m === T.rendererFailed)).toHaveLength(1);
    client.dispose();
  });

  // The limit is a RATE limit (SPEC §8/§9 "≤ 3 restarts/min"), not a one-way latch: the old code set
  // `gaveUp = true` and never consulted the sliding window again, so the renderer stayed dead — preview
  // frozen and worker-side draft autosave stopped — for the rest of the session.
  it('retries by itself once the restart window drains, and is not a permanent latch', () => {
    const h = handlers();
    const client = createWorkerClient(h);
    for (let i = 0; i < MAX_RESTARTS; i++) {
      current().crash();
      vi.advanceTimersByTime(1000);
      current().emit(structure(i));
    }
    current().crash();                                   // refused: the window is full
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 1);
    expect(h.errors.at(-1)).toEqual([T.rendererFailed, true]);

    // Nothing is scheduled before the oldest restart ages out…
    vi.advanceTimersByTime(RESTART_WINDOW_MS - 5000);
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 1);
    // …and the moment it does, the client spawns a fresh worker and replays the document.
    vi.advanceTimersByTime(6000);
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 2);
    expect(types(current())).toEqual(['init', 'setDoc']);
    expect(h.errors.at(-1)).toEqual([T.rendererRestarted, false]);
    client.dispose();
  });

  it('dispose cancels the pending window-reopen retry', () => {
    const client = createWorkerClient(handlers());
    for (let i = 0; i < MAX_RESTARTS + 1; i++) {
      current().crash();
      vi.advanceTimersByTime(1000);
    }
    const n = FakeWorker.instances.length;
    client.dispose();
    vi.advanceTimersByTime(RESTART_WINDOW_MS * 3);
    expect(FakeWorker.instances).toHaveLength(n);
  });

  it('allows restarts again once the minute window has passed', () => {
    const client = createWorkerClient(handlers());
    for (let i = 0; i < MAX_RESTARTS; i++) {
      current().crash();
      current().emit(structure(5)); // answer the re-sent setDoc so the silence timer does not fire
    }
    vi.advanceTimersByTime(61_000);
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 1);
    current().crash();
    expect(FakeWorker.instances).toHaveLength(MAX_RESTARTS + 2);
    client.dispose();
  });
});
