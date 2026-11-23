// src/preview/inlineEditLoader.ts — rule L (CONTRACT §11, "Round-4 verification decisions": the editing code is loaded
// on demand). src/preview/inlineEdit.ts and everything only it needs (serialize.ts, fidelity.ts, turndown and its gfm
// plugin, the main-thread markdown-it with its plugins, linkify, mdurl, punycode, entities, the main-thread copies of
// the worker's segmenter / md / math) are ONE chunk, fetched by the dynamic import() below the first time the preview
// is told to become editable. With 预览可编辑 off the page never requests it, so nothing of it runs, listens, ticks or
// sits in the DOM.
//
// This module is part of the main chunk: it may import TYPES from './inlineEdit' (erased) and nothing else of it.
import type { InlineEditApi } from './inlineEdit';

export type InlineEditModule = typeof import('./inlineEdit');

let loaded: InlineEditModule | null = null;
let loading: Promise<InlineEditModule> | null = null;

/** The editing module, when its chunk has arrived (synchronous: createPreview installs it at once then). */
export function inlineEditLoaded(): InlineEditModule | null {
  return loaded;
}

/** Fetches the editing chunk (once; concurrent callers share the request). A failure is not remembered here: the next
 *  call asks again (Chromium then answers from its module map without fetching: only a reload of the page helps). */
export function loadInlineEdit(): Promise<InlineEditModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('./inlineEdit').then(
    (m) => { loaded = m; loading = null; return m; },
    (err: unknown) => { loading = null; throw err; },
  );
  return loading;
}

/**
 * THE stand-in for the session API until the module is installed (rule L2). Every member answers exactly what
 * createInlineEdit's API answers with the switch off and no session — the state the real one is in when it was never
 * turned on: no session `s`, no `resume`, no `pendingToggle`, no `keptSel`, no `deferred`, `editable` false.
 *   setEditable(false): real: editable = false, end() and cancelResume(), both no-ops without a session / resume.
 *     (setEditable(true) never reaches the stand-in: createPreview installs the real module first.)
 *   isEditable: false · activeId: null · end / flush: no-ops without a session · afterStructure: retrack only with a
 *   session, tryResume only with a resume, replayToggle only with a pending toggle: nothing · afterMount: restoreKept
 *   only with a kept selection, then the same two: nothing · keepsRemoved: false (needs a session on that block) ·
 *   isEditingTarget: false (needs a session) · isResuming: false · dispose: nothing was installed, nothing to remove.
 */
export const INLINE_EDIT_OFF: InlineEditApi = Object.freeze({
  setEditable(): void {},
  isEditable: (): boolean => false,
  activeId: (): number | null => null,
  end(): void {},
  flush(): void {},
  afterStructure(): void {},
  keepsRemoved: (): boolean => false,
  afterMount(): void {},
  isEditingTarget: (): boolean => false,
  isResuming: (): boolean => false,
  dispose(): void {},
});
