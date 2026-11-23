// src/worker/render.worker.ts — module Worker entry: forwards messages to the render core.
import { isToWorker } from '../shared/protocol';
import { createRenderCore } from './core';
import { registerLanguages } from './highlight';

// highlight.js's languages at start, as importing highlight.js/lib/common did (highlight.ts explains why it no longer does).
registerLanguages();
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const core = createRenderCore((m, transfer) => ctx.postMessage(m, transfer ?? []));
// Guard: anything that is not a ToWorker message (a stray postMessage from an extension or a port
// handshake) is ignored instead of throwing inside the core. `isToWorker` only checks `.type`, so the
// core validates the payload shape itself; the try/catch is the last net — an exception escaping
// `onmessage` reaches the client as a worker `error` event and costs a full renderer restart.
ctx.onmessage = (e: MessageEvent<unknown>) => {
  if (!isToWorker(e.data)) return;
  try {
    core.handle(e.data);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: false });
  }
};
