// src/app/workerClient.ts — main-thread side of the render worker (SPEC §8 "WorkerClient").
// Throttles `viewport` (≤ 1 / 100 ms, last wins), coalesces `need` per animation frame, tracks
// exportHtml requests, and restarts the worker on crash / fatal error / 10 s structure silence
// (RATE limited to ≤ 3 per rolling minute: the client reports a fatal onError and stops spawning while
// the window is full, but schedules one retry for the moment it drains — never a permanent give-up).
// A restart replays init, setDoc
// (from onRestart), the accumulated setOptions and the draft enable state so the new worker behaves
// exactly like the one it replaces.
import {
  DEFAULT_RENDER_OPTIONS,
  type CreateWorkerClient,
  type FromWorker,
  type Line,
  type RenderOptions,
  type TextChange,
  type ToWorker,
} from '../shared/types';
import { isFromWorker } from '../shared/protocol';
import { T } from '../shared/i18n';

export const VIEWPORT_THROTTLE_MS = 100;
export const SILENCE_MS = 10_000;
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 60_000;
/** A worker killed by the OS fires no `error` event. While a `need`/`viewport` request is unanswered
 *  the client pings after this long and restarts if the ping is not answered either (SILENCE_MS total).
 *  The ping is a repeated `init` (the worker answers it with `ready` and keeps its cache), so a worker
 *  that is merely quiet — an unknown id, a viewport with nothing left to do — is never restarted. */
export const PING_AFTER_MS = 8_000;
export const PING_WAIT_MS = SILENCE_MS - PING_AFTER_MS;

interface PendingExport { resolve(html: string): void; reject(err: Error): void }

const raf: (fn: () => void) => number =
  typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16) as unknown as number;

export const createWorkerClient: CreateWorkerClient = (h, options = DEFAULT_RENDER_OPTIONS) => {
  let worker: Worker | null = null;
  let disposed = false;
  /** True while the rolling window is full: no worker is running and a retry is scheduled for the
   *  moment the oldest restart ages out. NOT a permanent latch — see `restart`. */
  let coolingDown = false;
  let retryTimer = 0;
  const restartTimes: number[] = [];

  let silenceTimer = 0;
  let vpPending: { firstLine: Line; lastLine: Line } | null = null;
  let vpTimer = 0;
  let vpSentAt = -Infinity;
  const needIds = new Set<number>();
  let needFrame = 0;
  let exportSeq = 0;
  let resyncPending = false;
  let resyncFrame = 0;
  const exports = new Map<number, PendingExport>();
  /** Session state replayed after a restart (the new worker starts from init defaults). */
  let optionOverrides: Partial<RenderOptions> | null = null;
  let draftEnabled = false;
  /** Last window the PREVIEW asked for — recorded when the request arrives, not when the throttle lets it
   *  out. A restarted worker is a fresh instance whose viewport defaults to {1,1}, and the preview only
   *  re-emits `viewport` when the window's first/last line changes, so without this replay the new worker
   *  auto-pushes nothing and every mounted block stays `.is-stale` until the user scrolls far enough.
   *  Recording it at flush time was the s07b race (findings-final): the newest window can still be sitting
   *  in the 100 ms throttle when the worker dies, `kill()` drops it, and the replay then re-armed the NEW
   *  worker with a window the user left seconds ago (observed: `viewport(1,84)` while both panes were at
   *  line 3000, so every edit at the cursor rendered outside the auto-push window). */
  let lastViewport: { firstLine: Line; lastLine: Line } | null = null;

  const post = (m: ToWorker): void => {
    worker?.postMessage(m);
  };

  const clearSilence = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = 0;
  };
  const armSilence = (): void => {
    clearSilence();
    silenceTimer = window.setTimeout(() => restart('no structure within 10 s'), SILENCE_MS);
  };

  // ---- request watchdog: a reader who only scrolls never sends setDoc/edit, so the structure-silence
  // timer above would never notice a worker that died without an error event. Any outgoing request
  // arms this watchdog; ANY incoming message disarms it (the worker is alive), so it only ever fires
  // for a worker that has gone completely silent while the preview is waiting for HTML.
  let waitingSince = 0;
  let watchTimer = 0;
  const clearWatch = (): void => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = 0;
    waitingSince = 0;
  };
  const afterPing = (): void => {
    watchTimer = 0;
    if (waitingSince === 0) return; // the ping (or anything else) came back: the worker is alive
    restart('renderer unresponsive: no reply to a render request within 10 s');
  };
  const onWatchDue = (): void => {
    watchTimer = 0;
    if (waitingSince === 0) return;
    // Ping with the *effective* options so the worker's markdown instance is unchanged by the probe.
    post({ type: 'init', options: { ...options, ...optionOverrides } });
    watchTimer = window.setTimeout(afterPing, PING_WAIT_MS);
  };
  const armWatch = (): void => {
    if (waitingSince !== 0 || watchTimer) return;
    waitingSince = Date.now();
    watchTimer = window.setTimeout(onWatchDue, PING_AFTER_MS);
  };

  const onMessage = (e: MessageEvent): void => {
    const m: unknown = e.data;
    if (!isFromWorker(m)) return;
    // Any message proves the worker is alive — including `ready` from the watchdog's own ping.
    clearWatch();
    dispatch(m);
  };

  const dispatch = (m: FromWorker): void => {
    switch (m.type) {
      case 'ready':
        return;
      case 'structure':
        clearSilence();
        h.onStructure(m);
        return;
      // CONTRACT §7: after an edit flush the worker answers with a delta instead of a full structure.
      // It ends the same silence window — it is the reply to the `edit` that armed it.
      case 'structureDelta':
        clearSilence();
        h.onStructureDelta(m);
        return;
      case 'outline':
        h.onOutline(m.items);
        return;
      case 'html':
        h.onHtml(m);
        return;
      case 'idle':
        h.onIdle(m.version);
        return;
      case 'draftSaved':
        h.onDraftSaved(m.docId, m.version, m.at);
        return;
      case 'exportHtml': {
        const p = exports.get(m.requestId);
        exports.delete(m.requestId);
        p?.resolve(m.html);
        return;
      }
      case 'error':
        h.onError(m.message, m.fatal);
        if (m.fatal) restart(m.message);
        return;
    }
  };

  const rejectExports = (reason: string): void => {
    for (const p of exports.values()) p.reject(new Error(reason));
    exports.clear();
  };

  const kill = (): void => {
    clearSilence();
    clearWatch();
    if (vpTimer) clearTimeout(vpTimer);
    vpTimer = 0;
    vpPending = null;
    needIds.clear();
    needFrame = 0;
    // A restart answers with a full `structure` by itself, which is exactly what a resync asks for.
    resyncPending = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
  };

  const spawn = (): void => {
    const w = new Worker(new URL('../worker/render.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = onMessage;
    w.onerror = (ev) => {
      ev.preventDefault?.();
      restart(ev.message || 'worker error');
    };
    worker = w;
    post({ type: 'init', options });
  };

  const restart = (reason: string): void => {
    if (disposed) return;
    console.warn('[workerClient] restarting render worker:', reason);
    const now = Date.now();
    while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
    kill();
    rejectExports('renderer restarted');
    if (restartTimes.length >= MAX_RESTARTS) {
      // SPEC §8/§9 specify a RATE limit ("≤ 3 restarts per minute"), not a one-way latch: a crash loop
      // must stop hammering, but an app that is quiet for a minute has to be able to heal itself.
      // The oldest restart in the window ages out at restartTimes[0] + RESTART_WINDOW_MS; schedule the
      // next attempt for then instead of refusing forever.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        restart('restart window reopened');
      }, Math.max(1, restartTimes[0] + RESTART_WINDOW_MS - now + 1));
      // One fatal notice per exhausted window, not one per refused attempt.
      if (!coolingDown) {
        coolingDown = true;
        h.onError(T.rendererFailed, true);
      }
      return;
    }
    coolingDown = false;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = 0;
    restartTimes.push(now);
    spawn();
    if (optionOverrides) post({ type: 'setOptions', options: optionOverrides });
    const d = h.onRestart();
    api.setDoc(d.docId, d.version, d.text);
    // Replay the window unthrottled, before anything else: setDoc reset the new worker's to {1,1}, and
    // the preview has no reason to repeat a window it already sent. `vpSentAt` moves with it so the next
    // genuine window change is throttled against this post rather than against the dead worker's.
    if (lastViewport) {
      post({ type: 'viewport', firstLine: lastViewport.firstLine, lastLine: lastViewport.lastLine });
      vpSentAt = Date.now();
    }
    if (draftEnabled) post({ type: 'draft', action: 'enable' });
    h.onError(T.rendererRestarted, false);
  };

  const flushViewport = (): void => {
    vpTimer = 0;
    if (!vpPending) return;
    post({ type: 'viewport', firstLine: vpPending.firstLine, lastLine: vpPending.lastLine });
    vpPending = null;
    vpSentAt = Date.now();
    armWatch();
  };

  const flushNeed = (): void => {
    needFrame = 0;
    if (needIds.size === 0) return;
    post({ type: 'need', ids: Array.from(needIds) });
    needIds.clear();
    armWatch();
  };

  /** CONTRACT §8. The preview calls `resync()` when it cannot apply a `structureDelta`; the worker answers
   *  with a full `structure` for the current version. Coalesced per frame so a burst of rejected deltas
   *  costs one message, and armed with the request watchdog like any other outgoing request. */
  const flushResync = (): void => {
    resyncFrame = 0;
    if (!resyncPending) return;
    resyncPending = false;
    post({ type: 'resync' });
    armWatch();
  };

  const api = {
    setDoc(docId: string, version: number, text: string) {
      post({ type: 'setDoc', docId, version, text });
      armSilence();
    },
    edit(version: number, changes: TextChange[]) {
      post({ type: 'edit', version, changes });
      armSilence();
    },
    viewport(firstLine: Line, lastLine: Line) {
      vpPending = { firstLine, lastLine };
      lastViewport = vpPending;   // survives the throttle AND a restart that drops the pending message
      if (vpTimer) return;
      const wait = VIEWPORT_THROTTLE_MS - (Date.now() - vpSentAt);
      if (wait <= 0) flushViewport();
      else vpTimer = window.setTimeout(flushViewport, wait);
    },
    need(ids: number[]) {
      for (const id of ids) needIds.add(id);
      if (!needFrame && needIds.size > 0) needFrame = raf(flushNeed);
    },
    setOptions(o: Partial<RenderOptions>) {
      optionOverrides = { ...optionOverrides, ...o };
      post({ type: 'setOptions', options: o });
    },
    draft(action: 'enable' | 'disable' | 'clear' | 'flush') {
      if (action === 'enable') draftEnabled = true;
      else if (action === 'disable') draftEnabled = false;
      post({ type: 'draft', action });
    },
    exportHtml() {
      if (!worker) return Promise.reject(new Error('renderer unavailable'));
      const requestId = ++exportSeq;
      return new Promise<string>((resolve, reject) => {
        exports.set(requestId, { resolve, reject });
        // 'html' output (CONTRACT §6): a standalone export must never show a formula twice offline.
        post({ type: 'exportHtml', requestId, mathOutput: 'html' });
      });
    },
    resync() {
      resyncPending = true;
      if (!resyncFrame) resyncFrame = raf(flushResync);
    },
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = 0;
      kill();
      rejectExports('disposed');
    },
  };

  spawn();
  return api;
};
