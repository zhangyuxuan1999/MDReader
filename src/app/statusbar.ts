// src/app/statusbar.ts — footer items: 行 L, 列 C · 字数 N · 字符 N · 约 M 分钟 · <file state> · <mode> · 渲染中 37%
// Each setter writes textContent of exactly one span; no layout reads.
import type { DocStats, FileState, Line, Mode, StatusBarApi } from '../shared/types';
import { T } from '../shared/i18n';

export type StatId = 'pos' | 'words' | 'chars' | 'reading' | 'file' | 'mode' | 'progress';
const ORDER: StatId[] = ['pos', 'words', 'chars', 'reading', 'file', 'mode', 'progress'];

const MODE_LABEL: Record<Mode, string> = { edit: T.modeEdit, split: T.modeSplit, preview: T.modePreview };
const STATE_LABEL: Record<FileState, string> = {
  untitled: T.untitledState, saved: T.saved, dirty: T.unsaved, draft: T.draftSaved,
};

/** Pure formatters (unit-tested). */
export const fmt = {
  pos: (line: Line, col: number): string => `${T.line} ${line}, ${T.col} ${col + 1}`,
  words: (s: DocStats): string => `${T.words} ${s.cjk + s.latinWords}`,
  chars: (s: DocStats): string => `${T.chars} ${s.chars}`,
  reading: (s: DocStats): string => `${T.readingAbout} ${s.readingMinutes} ${T.minutes}`,
  file: (name: string, state: FileState): string => `${name} · ${STATE_LABEL[state]}`,
  mode: (m: Mode): string => MODE_LABEL[m],
  progress: (fraction: number): string => `${T.rendering} ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`,
};

/** StatusBarApi (shared/types) is frozen, so the teardown hook lives in a side table keyed by the
 *  instance (the same pattern as disposeTheme / disposeLayout). */
const extras = new WeakMap<StatusBarApi, { dispose(): void; setPreviewEditing(on: boolean, label: string): void }>();

/** In-preview editing (CONTRACT §11): while a block is being edited in the preview the mode slot reads
 *  e.g. 「分栏 · 预览编辑」 and carries data-preview-edit (layout.css tints it). StatusBarApi is frozen, so
 *  this is a side-table accessor like disposeStatusBar. */
export function setStatusPreviewEditing(bar: StatusBarApi, on: boolean, label: string): void {
  extras.get(bar)?.setPreviewEditing(on, label);
}

/** Removes the spans `createStatusBar` appended to its parent (no-op for an unknown status bar). */
export function disposeStatusBar(bar: StatusBarApi): void {
  extras.get(bar)?.dispose();
}

export function createStatusBar(parent: HTMLElement): StatusBarApi {
  const doc = parent.ownerDocument;
  const items = {} as Record<StatId, HTMLSpanElement>;
  for (const id of ORDER) {
    const span = doc.createElement('span');
    span.className = 'mdr-statusbar__item';
    span.dataset.stat = id;
    parent.appendChild(span);
    items[id] = span;
  }
  items.pos.textContent = fmt.pos(1, 0);
  items.progress.hidden = true;
  let mode: Mode | null = null;
  let editingLabel: string | null = null;
  const renderMode = (): void => {
    const base = mode ? fmt.mode(mode) : '';
    items.mode.textContent = editingLabel ? (base ? `${base} · ${editingLabel}` : editingLabel) : base;
    if (editingLabel) items.mode.dataset.previewEdit = '1';
    else delete items.mode.dataset.previewEdit;
  };

  const api: StatusBarApi = {
    setStats(s) {
      items.words.textContent = fmt.words(s);
      items.chars.textContent = fmt.chars(s);
      items.reading.textContent = fmt.reading(s);
      items.reading.hidden = s.readingMinutes === 0;
    },
    setCursor(line, col) {
      items.pos.textContent = fmt.pos(line, col);
    },
    setFile(name, state) {
      items.file.textContent = fmt.file(name, state);
      items.file.dataset.state = state;
      items.file.title = name;
    },
    setMode(m) {
      mode = m;
      renderMode();
    },
    setProgress(fraction) {
      if (fraction === null) {
        items.progress.hidden = true;
        return;
      }
      items.progress.hidden = false;
      items.progress.textContent = fmt.progress(fraction);
    },
  };
  extras.set(api, {
    setPreviewEditing(on, label) {
      editingLabel = on ? label : null;
      renderMode();
    },
    dispose() {
      for (const id of ORDER) items[id].remove();
    },
  });
  return api;
}
