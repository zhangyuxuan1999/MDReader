// electron/openQueue.mjs — the launch-document queue (CONTRACT §10, §10a addendum).
// macOS delivers 'open-file' before app.ready and long before the renderer has subscribed to
// mdrNative.onOpenFile, so every path is buffered until the renderer sends 'ready-for-files' and
// then flushed in arrival order. Later paths go straight through.
//
// Nothing is ever dropped: `deliver(path)` returns true ONLY when the path was handed to a live
// window's webContents. When it returns false (the window was closed — on macOS the app keeps
// running in the Dock — or is being torn down), the queue falls back to buffering, keeps that path
// and every path after it, and waits for the next renderer's 'ready-for-files'.
// Pure (no 'electron' import) so test/electron.openQueue.test.ts can drive it in Node.

export function createOpenFileQueue(deliver) {
  let ready = false;
  let queue = [];

  /** Buffer one path; the same path twice while buffering is one open (argv + Apple event). The
   *  entry moves to the end, so the LAST request is shown last (A, B, A while buffering ends on A). */
  const keep = (p) => {
    const i = queue.indexOf(p);
    if (i !== -1) queue.splice(i, 1);
    queue.push(p);
  };

  return {
    /** Queue (no live consumer) or deliver (live consumer) one absolute path. */
    push(p) {
      if (typeof p !== 'string' || p.length === 0) return false;
      if (ready) {
        if (deliver(p) === true) return true;
        // The consumer is gone: back to buffering, keep the path for the next window.
        ready = false;
      }
      keep(p);
      return true;
    },
    /**
     * The renderer subscribed: flush everything collected so far, in order. Returns the paths that
     * were actually delivered. If the consumer vanishes mid-flush, the undelivered rest stays queued.
     */
    markReady() {
      if (ready) return [];
      ready = true;
      const flushed = [];
      while (queue.length > 0) {
        const p = queue[0];
        if (deliver(p) !== true) {
          ready = false;
          return flushed;
        }
        queue.shift();
        flushed.push(p);
      }
      return flushed;
    },
    /**
     * Buffer `p` AHEAD of everything pending (deduplicated: an existing entry moves to the front).
     * Always buffers — the caller has just reset the queue (renderer crashed: the document it showed
     * must be reopened before whatever arrived later, so the newest request still ends up on screen).
     */
    pushFront(p) {
      if (typeof p !== 'string' || p.length === 0) return false;
      ready = false;
      queue = [p, ...queue.filter((x) => x !== p)];
      return true;
    },
    /** Withdraw a pending path the shell queued itself (a crash restore whose window went away). */
    remove(p) {
      const i = queue.indexOf(p);
      if (i === -1) return false;
      queue.splice(i, 1);
      return true;
    },
    /** The consumer is gone or new (window closed / being created): buffer again, keep pending paths. */
    reset() {
      ready = false;
    },
    isReady() {
      return ready;
    },
    pending() {
      return queue.slice();
    },
  };
}
