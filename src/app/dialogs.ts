// src/app/dialogs.ts — custom confirm dialog (centred, with backdrop) rendered in the overlay.
// Escape = cancel; Enter activates the focused button only. The default focus is the confirm button,
// except for destructive dialogs (danger:true) where it is 取消 so a reflex Enter never loses data.
// Focus is returned to the previously focused element.

export interface ConfirmOptions {
  text: string;
  ok: string;
  cancel?: string;
  /** Style the confirm button as destructive (e.g. discard changes). */
  danger?: boolean;
}

export interface ChoiceOption {
  id: string;
  label: string;
  /** Visual weight only; which button Enter/Escape pick is decided by `defaultId` / `cancelId`. */
  kind?: 'primary' | 'danger';
}
export interface ChoiceOptions {
  text: string;
  /** In DOM order, left to right (macOS convention: the destructive answer far left, the default far right). */
  choices: ChoiceOption[];
  /** Focused when the dialog opens, so Enter picks it. */
  defaultId: string;
  /** Escape, a click on the backdrop, and Enter with focus outside any button all resolve to this. */
  cancelId: string;
}

/**
 * Multi-answer dialog (the desktop close guard needs 保存 / 不保存 / 取消 — three outcomes, not two).
 * Same shell, focus handling and keyboard rules as `confirmDialog`; resolves with the chosen id.
 */
export function chooseDialog(parent: HTMLElement, o: ChoiceOptions): Promise<string> {
  const doc = parent.ownerDocument;
  const prevFocus = doc.activeElement as HTMLElement | null;

  const backdrop = doc.createElement('div');
  backdrop.className = 'mdr-dialog-backdrop';
  const dialog = doc.createElement('div');
  dialog.className = 'mdr-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const text = doc.createElement('p');
  text.className = 'mdr-dialog__text';
  text.textContent = o.text;
  const actions = doc.createElement('div');
  actions.className = 'mdr-dialog__actions';

  const buttons = new Map<string, HTMLButtonElement>();
  for (const c of o.choices) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'mdr-dialog__btn' + (c.kind ? ` mdr-dialog__btn--${c.kind}` : '');
    b.textContent = c.label;
    b.dataset.choice = c.id;
    actions.appendChild(b);
    buttons.set(c.id, b);
  }

  dialog.append(text, actions);
  backdrop.appendChild(dialog);

  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (id: string): void => {
      if (done) return;
      done = true;
      backdrop.remove();
      prevFocus?.focus?.();
      resolve(id);
    };
    for (const [id, b] of buttons) b.addEventListener('click', () => finish(id));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(o.cancelId);
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(o.cancelId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const active = doc.activeElement as HTMLElement | null;
        const id = active?.dataset?.choice;
        finish(id && buttons.has(id) ? id : o.cancelId);
      }
    });
    parent.appendChild(backdrop);
    (buttons.get(o.defaultId) ?? dialog).focus();
  });
}

export function confirmDialog(parent: HTMLElement, o: ConfirmOptions): Promise<boolean> {
  const doc = parent.ownerDocument;
  const prevFocus = doc.activeElement as HTMLElement | null;

  const backdrop = doc.createElement('div');
  backdrop.className = 'mdr-dialog-backdrop';
  const dialog = doc.createElement('div');
  dialog.className = 'mdr-dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;

  const text = doc.createElement('p');
  text.className = 'mdr-dialog__text';
  text.textContent = o.text;
  const actions = doc.createElement('div');
  actions.className = 'mdr-dialog__actions';

  const mkButton = (label: string, cls: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'mdr-dialog__btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    actions.appendChild(b);
    return b;
  };
  const cancelBtn = mkButton(o.cancel ?? '取消', '');
  const okBtn = mkButton(o.ok, o.danger ? 'mdr-dialog__btn--danger' : 'mdr-dialog__btn--primary');

  dialog.append(text, actions);
  backdrop.appendChild(dialog);

  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      backdrop.remove();
      prevFocus?.focus?.();
      resolve(value);
    };
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(false);
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        // Enter only ever activates the focused button; with focus elsewhere in the dialog it means cancel.
        e.preventDefault();
        finish(doc.activeElement === okBtn);
      }
    });
    parent.appendChild(backdrop);
    (o.danger ? cancelBtn : okBtn).focus();
  });
}

// ---------------------------------------------------------------- one question at a time (CONTRACT §11, R1)

/**
 * Serialises the app's modal questions (the 取消 / 丢弃 discard question, the desktop 不保存 / 取消 / 保存
 * close question): a question asked while another is on screen waits for that one to be answered
 * instead of being stacked on top of it — or refused. Callers run in arrival order. `ask` should
 * re-check whether its question is still needed: the answer to the earlier one may have settled it.
 */
export interface QuestionGate {
  ask<T>(ask: () => Promise<T>): Promise<T>;
  /** True while a question is on screen or waiting for its turn. */
  busy(): boolean;
}

export function createQuestionGate(): QuestionGate {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    ask<T>(fn: () => Promise<T>): Promise<T> {
      pending++;
      const go = async (): Promise<T> => {
        try {
          return await fn();
        } finally {
          pending--;
        }
      };
      const p = tail.then(go, go);
      tail = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    busy: () => pending > 0,
  };
}

export interface DocumentGuardOptions {
  /** True when the current document has unsaved changes (App commits a live preview session first). */
  isDirty(): boolean;
  /** Puts the 取消 / 丢弃 question on screen; true = 丢弃. */
  ask(): Promise<boolean>;
  /** Shared with the desktop close question; a private gate when omitted. */
  gate?: QuestionGate;
}

/**
 * The discard guard of every document-replacing operation (新建, 打开…, a recent entry, a drop, a
 * document the OS sends). Finding F4: the old single-flight guard answered `false` to a second caller
 * while the question was on screen, and the caller took that for "the user kept the document" — a
 * double-clicked file that arrived during 新建's question was silently dropped. Now:
 *   - `run(op)` runs ONE operation at a time, in arrival order. The next one starts only after the
 *     previous one has finished — including its load — so it sees the document that operation left
 *     behind and asks its own question only if that one is still dirty. Nothing is refused.
 *   - `confirmDiscard()` (called by an operation) asks through the shared gate, so the discard question
 *     never stacks on the close question and vice versa; it re-checks `isDirty()` when its turn comes.
 *   - `discardDecided()` is true from a 丢弃 answer until the operation that asked has finished: a close
 *     request that waited for that answer needs no question of its own — the user already threw the
 *     text away.
 * Never call `run` from inside an operation: it would wait for itself.
 */
export interface DocumentGuard {
  readonly gate: QuestionGate;
  run<T>(op: () => Promise<T>): Promise<T>;
  confirmDiscard(): Promise<boolean>;
  discardDecided(): boolean;
}

export function createDocumentGuard(o: DocumentGuardOptions): DocumentGuard {
  const gate = o.gate ?? createQuestionGate();
  let tail: Promise<unknown> = Promise.resolve();
  let decided = false;
  return {
    gate,
    run<T>(op: () => Promise<T>): Promise<T> {
      const go = async (): Promise<T> => {
        try {
          return await op();
        } finally {
          decided = false;
        }
      };
      const p = tail.then(go, go);
      tail = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    confirmDiscard: () =>
      gate.ask(async () => {
        if (!o.isDirty()) return true;
        const yes = await o.ask();
        if (yes) decided = true;
        return yes;
      }),
    discardDecided: () => decided,
  };
}
