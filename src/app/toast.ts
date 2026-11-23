// src/app/toast.ts — bottom-centre toast bar inside the overlay. Toasts with actions stay until a
// button is pressed (or timeoutMs is given); plain toasts auto-dismiss. Repeating the same action
// (e.g. clicking a relative link five times) must not stack five identical toasts: an action-less
// toast whose text+kind is already ON SCREEN only restarts that toast's timer and counts up (「… ×3」).
// "On screen" is checked, not assumed: an element removed from the DOM by anyone other than its own
// dismiss (a test harness, a future overlay teardown) used to leave its coalescing entry behind, and
// the next identical toast then bumped a detached element — a message the user never saw.
import type { ToastSpec } from '../shared/types';

const INFO_MS = 4000;
const ERROR_MS = 8000;

export interface ToastApi {
  show(spec: ToastSpec): () => void;
  /** G34: a persistent failure that belongs to `key` (an open's path): it replaces an earlier failure of
   *  the same key. At most MAX_FAILURES are on screen (the newest); older ones fold into one counting line. */
  failure(key: string, spec: ToastSpec): void;
  /** `key` opened fine: its failure toast (if any) goes. */
  clearFailure(key: string): void;
  dispose(): void;
}

/** G34: failure toasts on screen at once; the rest fold into one line (「另有 N 个文件无法打开」). */
export const MAX_FAILURES = 3;
export const FAILURES_FOLDED = (n: number): string => `另有 ${n} 个文件无法打开`;

/** A toast on screen: `el` is null when it was coalesced into an existing one. */
interface Shown { dismiss(): void; setText(t: string): void; el: HTMLElement | null }

interface LiveToast { count: number; bump(): void; dismiss(): void; onScreen(): boolean }

export function createToasts(parent: HTMLElement): ToastApi {
  const doc = parent.ownerDocument;
  const host = doc.createElement('div');
  host.className = 'mdr-toasts';
  parent.appendChild(host);
  /** Action-less toasts currently on screen, keyed by kind + text. */
  const live = new Map<string, LiveToast>();

  /** `own`: a keyed failure toast or the counting line (G34) — never coalesced with another toast; `onClose`
   *  runs when the user presses its ×; `setText` replaces its text in place. */
  const showToast = (spec: ToastSpec, own?: { onClose(): void }): Shown => {
    // Only plain notifications coalesce: two toasts with buttons are two different decisions.
    const key = own || spec.actions?.length ? null : `${spec.kind ?? 'info'}\u0000${spec.text}`;
    const existing = key ? live.get(key) : undefined;
    if (existing && existing.onScreen()) {
      existing.bump();
      return { dismiss: existing.dismiss, setText: () => {}, el: null };
    }
    existing?.dismiss(); // detached: forget it and show a fresh toast

    const el = doc.createElement('div');
    el.className = 'mdr-toast' + (spec.kind === 'error' ? ' mdr-toast--error' : '');
    el.setAttribute('role', spec.kind === 'error' ? 'alert' : 'status');

    const text = doc.createElement('span');
    text.className = 'mdr-toast__text';
    text.textContent = spec.text;
    el.appendChild(text);

    let timer = 0;
    const dismiss = (): void => {
      if (timer) clearTimeout(timer);
      timer = 0;
      if (key) live.delete(key);
      el.remove();
    };

    for (const a of spec.actions ?? []) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'mdr-toast__btn';
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        dismiss();
        a.run();
      });
      el.appendChild(btn);
    }

    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'mdr-toast__close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', () => {
      dismiss();
      own?.onClose();
    });
    el.appendChild(close);

    host.appendChild(el);
    const ms = spec.timeoutMs ?? (spec.actions?.length ? 0 : spec.kind === 'error' ? ERROR_MS : INFO_MS);
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = ms > 0 ? window.setTimeout(dismiss, ms) : 0;
    };
    arm();
    if (key) {
      const entry: LiveToast = {
        count: 1,
        onScreen: () => el.isConnected,
        bump() {
          entry.count++;
          text.textContent = `${spec.text} ×${entry.count}`;
          arm();
        },
        dismiss,
      };
      live.set(key, entry);
    }
    return { dismiss, setText: (t) => { text.textContent = t; }, el };
  };
  const show = (spec: ToastSpec): (() => void) => showToast(spec).dismiss;

  // ---- failure toasts by key (G34): oldest first; `dismiss` is set while the entry is on screen.
  interface Failure { key: string; spec: ToastSpec; shown: Shown | null }
  let failures: Failure[] = [];
  let folded: Shown | null = null;
  const renderFailures = (): void => {
    const hidden = Math.max(0, failures.length - MAX_FAILURES);
    failures.forEach((f, i) => {
      if (i < hidden && f.shown) { f.shown.dismiss(); f.shown = null; }
    });
    for (const f of failures.slice(hidden)) {
      if (f.shown) continue;
      const entry = f;
      entry.shown = showToast(entry.spec, {
        onClose() {
          // × on the toast: that failure is acknowledged; an older one may move up.
          entry.shown = null;
          failures = failures.filter((x) => x !== entry);
          renderFailures();
        },
      });
    }
    if (hidden === 0) {
      folded?.dismiss();
      folded = null;
    } else if (folded) {
      folded.setText(FAILURES_FOLDED(hidden));
    } else {
      folded = showToast({ text: FAILURES_FOLDED(hidden), kind: 'error', timeoutMs: 0 }, {
        onClose() {
          // × on the counting line acknowledges every failure it stands for.
          folded = null;
          failures = failures.slice(Math.max(0, failures.length - MAX_FAILURES));
          renderFailures();
        },
      });
    }
    // Oldest first: the counting line (the oldest failures), then the visible ones in order.
    if (folded?.el) host.appendChild(folded.el);
    for (const f of failures.slice(hidden)) if (f.shown?.el) host.appendChild(f.shown.el);
  };
  const dropFailure = (key: string): void => {
    const f = failures.find((x) => x.key === key);
    if (!f) return;
    f.shown?.dismiss();
    failures = failures.filter((x) => x !== f);
  };

  return {
    show,
    failure(key, spec) {
      dropFailure(key);
      failures.push({ key, spec, shown: null });
      renderFailures();
    },
    clearFailure(key) {
      if (!failures.some((x) => x.key === key)) return;
      dropFailure(key);
      renderFailures();
    },
    dispose() {
      for (const f of failures) f.shown?.dismiss();
      failures = [];
      folded?.dismiss();
      folded = null;
      for (const t of Array.from(live.values())) t.dismiss();
      live.clear();
      host.remove();
    },
  };
}
