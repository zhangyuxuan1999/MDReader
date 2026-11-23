// src/app/perfOverlay.ts — ?perf=1 diagnostics panel. Refreshes on a 500 ms interval only; the
// bus listener just appends to a ring buffer (no DOM work on the hot path).
import type { EventBus, PreviewApi } from '../shared/types';

export interface PerfOverlayOptions {
  parent: HTMLElement;
  bus: EventBus;
  preview: PreviewApi;
  workerIdle(): boolean;
}
export interface PerfOverlayApi {
  /** Called by App from editor.onChanges: timestamps the keystroke for the mount-latency row. */
  markKeystroke(): void;
  dispose(): void;
}

const SAMPLE_ROWS = 20;
const REFRESH_MS = 500;

/** `mdr:open` → `mdr:first-visible` in ms for the latest open, or null. */
export function openToFirstVisibleMs(): number | null {
  const opens = performance.getEntriesByName('mdr:open');
  if (opens.length === 0) return null;
  const open = opens[opens.length - 1].startTime;
  const fv = performance.getEntriesByName('mdr:first-visible').find((e) => e.startTime >= open);
  return fv ? fv.startTime - open : null;
}

export function createPerfOverlay(o: PerfOverlayOptions): PerfOverlayApi {
  const doc = o.parent.ownerDocument;
  const panel = doc.createElement('div');
  panel.className = 'mdr-perf';
  panel.setAttribute('aria-hidden', 'true');

  const rows: Record<string, HTMLElement> = {};
  const addRow = (key: string, label: string): void => {
    const row = doc.createElement('div');
    row.className = 'mdr-perf__row';
    const l = doc.createElement('span');
    l.textContent = label;
    const v = doc.createElement('b');
    v.textContent = '–';
    row.append(l, v);
    panel.appendChild(row);
    rows[key] = v;
  };
  addRow('open', 'open → first-visible');
  addRow('latency', 'keystroke → mount');
  addRow('longtasks', 'long tasks');
  addRow('mounted', 'mounted blocks');
  addRow('worker', 'worker');
  const samplesEl = doc.createElement('pre');
  samplesEl.className = 'mdr-perf__samples';
  panel.appendChild(samplesEl);
  o.parent.appendChild(panel);

  const samples: Array<{ name: string; ms: number }> = [];
  let lastKeystroke = 0;
  let lastLatency: number | null = null;
  let longTasks = 0;

  const offSample = o.bus.on('perf:sample', (s) => {
    samples.push(s);
    if (samples.length > SAMPLE_ROWS) samples.shift();
    if (s.name === 'mount' && lastKeystroke > 0) {
      lastLatency = performance.now() - lastKeystroke;
      lastKeystroke = 0;
    }
  });

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    observer = null;
  }

  const fmtMs = (ms: number | null): string => (ms === null ? '–' : `${ms.toFixed(1)} ms`);
  const refresh = (): void => {
    rows.open.textContent = fmtMs(openToFirstVisibleMs());
    rows.latency.textContent = fmtMs(lastLatency);
    rows.longtasks.textContent = observer ? String(longTasks) : 'n/a';
    const mountedCount =
      (o.preview as PreviewApi & { mountedCount?(): number }).mountedCount?.() ??
      o.preview.el.querySelectorAll('.md-block:not(.is-pending)').length;
    rows.mounted.textContent = `${mountedCount} / ${o.preview.blockCount()}`;
    rows.worker.textContent = o.workerIdle() ? 'idle' : 'busy';
    samplesEl.textContent = samples.map((s) => `${s.name.padEnd(12)} ${s.ms.toFixed(2).padStart(8)} ms`).join('\n');
  };
  const timer = window.setInterval(refresh, REFRESH_MS);
  refresh();

  return {
    markKeystroke() {
      lastKeystroke = performance.now();
    },
    dispose() {
      clearInterval(timer);
      offSample();
      observer?.disconnect();
      panel.remove();
    },
  };
}
