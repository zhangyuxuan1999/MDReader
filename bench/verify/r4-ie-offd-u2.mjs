// bench/verify/r4-ie-offd-u2.mjs — fix-session-e (0.2.0 stage 2e), B2 (U2 as amended, RVS-4): a copy of the audit's
// bench/verify/v5-offd-matrix.mjs that compares EVERY observation BUT the event log `ev`. For ⌘Z / ⇧⌘Z cases the
// event log can never be equal: 0.1.1 reaches CodeMirror through the browser's beforeinput historyUndo at the editor,
// the candidate through its keydown (U2). Everything else (source, caret, both panes' scroll, the focus line, the
// editor's line classes, the active element, toasts, …) is compared exactly as the audit's script does, and every
// step is compared (an ev-only difference no longer stops the case at that step). Use it only for the U2 cases:
//   MDR_PORT=5468 MDR_BASE_PORT=5478 MDR_SCRATCH=<dir> node bench/verify/r4-ie-offd-u2.mjs app-undo k-Meta+z ks-Meta+z app-redo
// The only change against the original is the `ignore: ['ev']` of the last runBoth call (marked r4-ie).
// bench/verify/v5-offd-matrix.mjs — audit-off-diff: every gesture on every document, in split and preview mode,
// candidate (switch OFF) against 0.1.1, observation by observation (bench/verify/v5-offd-lib.mjs).
//   MDR_PORT=5521 MDR_BASE_PORT=5522 node bench/verify/v5-offd-matrix.mjs [pattern ...] [--shard i/n] [--list] [--all-diffs]
// A pattern is a substring of a case name (doc/mode/gesture); all cases run when none is given. Prints PASS / DIFF /
// SKIP per case (DIFF with the first differing observation of both builds) and writes the JSON of every DIFF to
// $MDR_SCRATCH/matrix-<shard>.json. Exit code 0 always (it is a report), 3 on the global timeout.
// Duration on this machine: about 2.5 s per case alone; the whole list (≈2100 cases) took about 20 min per shard with
// --shard 0/4 … 3/4 in parallel (and other agents' browsers running). MDR_TIMEOUT (ms) raises the global timeout.
// Known differences it reports on every run: see the header of v5-offd-lib.mjs. MDR_CONTROL=1 with both ports on the
// baseline gives the noise floor (long-document End / raw scroll offsets / mode switches / focus line after ⌘F).
import * as L from './v5-offd-lib.mjs';

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
let shard = null;
const pats = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--shard') { const [a, b] = argv[++i].split('/').map(Number); shard = { i: a, n: b }; continue; }
  if (argv[i].startsWith('--')) continue;
  pats.push(argv[i]);
}

// ---------------------------------------------------------------- targets
const T = {
  text: { inCss: 'p', o: 3 },
  text2: { inCss: 'p', o: 14 },
  textB: { inCss: 'p', nth: 1, o: 6 },
  word: { inCss: 'p', o: 4 },
  heading: { inCss: 'h1, h2, h3', o: 2 },
  link: { css: 'a[href]' },
  image: { css: 'img' },
  formula: { css: '.katex' },
  dformula: { css: '.katex-display' },
  code: { inCss: 'pre', o: 5 },
  cell: { inCss: 'td', o: 2 },
  li: { inCss: 'li', o: 2 },
  quote: { inCss: 'blockquote', o: 3 },
  task: { css: 'li input[type="checkbox"]' },
  taskText: { inCss: 'li.task-list-item', o: 4 },
  rawBox: { css: '.note input[type="checkbox"]' },
  rawLabel: { inCss: '.note label', o: 3 },
  summary: { css: 'summary' },
  beside: { beside: null },
  below: { below: true },
  vb0: { vb: 0, o: 2 },
  vb1: { vb: 1, o: 3 },
  vb2: { vb: 2, o: 5 },
  ed: { pane: 'ed', fx: 0.5, fy: 0.35 },
  edLine: { edLine: 3, endOfLine: true },
};

// ---------------------------------------------------------------- gestures
const POINTER = {
  'click-text': [['click', T.text]],
  'click-heading': [['click', T.heading]],
  'click-link': [['click', T.link]],
  'click-image': [['click', T.image]],
  'click-formula': [['click', T.formula]],
  'click-dformula': [['click', T.dformula]],
  'click-code': [['click', T.code]],
  'click-cell': [['click', T.cell]],
  'click-li': [['click', T.li]],
  'click-quote': [['click', T.quote]],
  'click-task': [['click', T.task]],
  'click-tasktext': [['click', T.taskText]],
  'click-rawbox': [['click', T.rawBox]],
  'click-rawlabel': [['click', T.rawLabel]],
  'click-summary': [['click', T.summary]],
  'click-beside': [['click', T.beside]],
  'click-below': [['click', T.below]],
  'click-hold': [['click', T.text, { hold: 700 }]],
  'dbl-word': [['click', T.word, { count: 2 }]],
  'triple-line': [['click', T.word, { count: 3 }]],
  'dbl-code': [['click', T.code, { count: 2 }]],
  'triple-li': [['click', T.li, { count: 3 }]],
  'dbl-cell': [['click', T.cell, { count: 2 }]],
  'dbl-heading': [['click', T.heading, { count: 2 }]],
  'dbl-link': [['click', T.link, { count: 2 }]],
  'triple-quote': [['click', T.quote, { count: 3 }]],
  'shift-click': [['click', T.text], ['click', T.vb2, { mods: ['Shift'] }]],
  'shift-click-back': [['click', T.vb2], ['click', T.text, { mods: ['Shift'] }]],
  'shift-click-dbl': [['click', T.word, { count: 2 }], ['click', T.vb1, { mods: ['Shift'] }]],
  'drag-in-block': [['drag', T.text, T.text2]],
  'drag-3-blocks': [['drag', T.vb0, T.vb2]],
  'drag-3-blocks-up': [['drag', T.vb2, T.vb0]],
  'drag-to-editor': [['drag', T.vb0, T.ed]],
  'drag-to-editor-back': [['drag', T.vb0, T.vb1, { via: T.ed }]],
  'drag-from-editor': [['drag', T.edLine, T.vb1]],
  'drag-selected': [['click', T.word, { count: 2 }], ['drag', T.word, T.vb2]],
  'drag-selected-editor': [['click', T.word, { count: 2 }], ['drag', T.word, T.ed]],
  'drag-image': [['drag', T.image, T.vb0]],
  'drag-image-editor': [['drag', T.image, T.ed]],
  'drag-link': [['drag', T.link, T.vb2]],
  'drag-code': [['drag', T.code, { inCss: 'pre', o: 30 }]],
  'drag-cells': [['drag', T.cell, { inCss: 'td', nth: 3, o: 2 }]],
  'drag-out-top': [['drag', T.vb1, { pane: 'pv', fx: 0.5, fy: -0.05 }]],
  'ctx-text': [['click', T.text, { button: 'right' }]],
  'ctx-sel': [['click', T.word, { count: 2 }], ['click', T.word, { button: 'right' }]],
  'ctx-link': [['click', T.link, { button: 'right' }]],
  'ctx-image': [['click', T.image, { button: 'right' }]],
  'middle-link': [['click', T.link, { button: 'middle' }]],
  'wheel-pv': [['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, 500]],
  'wheel-pv-up': [['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, 500], ['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, -300]],
  'wheel-ed': [['wheel', { pane: 'ed', fx: 0.5, fy: 0.5 }, 500]],
  'alt-click': [['click', T.text, { mods: ['Alt'] }]],
  'alt-click-li': [['click', T.li, { mods: ['Alt'] }]],
  'alt-click-cell': [['click', T.cell, { mods: ['Alt'] }]],
  'alt-click-code': [['click', T.code, { mods: ['Alt'] }]],
  'alt-click-heading': [['click', T.heading, { mods: ['Alt'] }]],
  'alt-click-link': [['click', T.link, { mods: ['Alt'] }]],
  'cmd-click': [['click', T.text, { mods: ['Meta'] }]],
  'cmd-click-link': [['click', T.link, { mods: ['Meta'] }]],
  'cmd-click-task': [['click', T.task, { mods: ['Meta'] }]],
  'shift-click-link': [['click', T.link, { mods: ['Shift'] }]],
  'hover-link': [['hover', T.link]],
  'click-text-then-editor': [['click', T.text], ['click', T.edLine]],
  'click-editor-then-text': [['click', T.edLine], ['click', T.text]],
  'click-link-then-key': [['click', T.link], ['key', 'ArrowDown']],
  'click-task-twice': [['click', T.task], ['click', T.task]],
  'paste-evt': [['click', T.text], ['pasteEvt', 'pasted words', T.text]],
  'drop-text': [['dropText', T.text, 'dropped words']],
  'drop-text-editor': [['dropText', T.ed, 'dropped words']],
  'ime': [['click', T.text], ['ime', '中文']],
  'ime-sel': [['click', T.word, { count: 2 }], ['ime', '中文']],
};
const needsEditor = (name, steps) => steps.some((s) => JSON.stringify(s).includes('"pane":"ed"') || JSON.stringify(s).includes('edLine') || s[0] === 'edit' || s[0] === 'find');

const KEYS = ['a', 'Z', '5', ',', 'Shift+Digit1', 'Enter', 'Shift+Enter', 'Backspace', 'Delete', 'Tab', 'Shift+Tab', 'Space', 'Shift+Space',
  'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight',
  'Meta+ArrowUp', 'Meta+ArrowDown', 'Meta+ArrowLeft', 'Meta+ArrowRight', 'Meta+Shift+ArrowDown', 'Meta+Shift+ArrowRight', 'Alt+ArrowRight', 'Alt+Shift+ArrowLeft',
  'Escape', 'Meta+a', 'Meta+c', 'Meta+x', 'Meta+v', 'Meta+z', 'Meta+Shift+z', 'Meta+b', 'Meta+i', 'Meta+e', 'Meta+k', 'Meta+f', 'Meta+s', 'Meta+Shift+e'];
const keySteps = (k, ctx) => {
  const pre = ctx === 'sel' ? [['click', T.word, { count: 2 }]] : ctx === 'drag' ? [['drag', T.vb0, T.vb1]] : [['click', T.text]];
  if (k === 'Meta+v') return [['clip', 'clip words'], ...pre, ['key', 'Meta+v']];
  if (k === 'Meta+z' || k === 'Meta+Shift+z') return [['edit', { at: T.edLine, text: ' xy' }], ...pre, ['key', k], ['key', k]];
  if (k === 'Meta+Shift+e') return [...pre, ['key', 'Meta+Shift+e'], ['key', 'Meta+Shift+e', { after: 600 }], ['click', T.textB], ['key', 'ArrowDown'], ['click', T.word, { count: 2 }], ['key', 'Meta+c']];
  if (k === 'Meta+a') return [...pre, ['key', 'Meta+a'], ['key', 'Meta+c']];
  if (k === 'Meta+x') return [...pre, ['key', 'Meta+x'], ['key', 'Meta+v']];
  return [...pre, ['key', k]];
};
const keyOpts = (k) => {
  if (k === 'Meta+Shift+e') return { toggle: true };
  return {};
};

// copy: [A, B] programmatic ranges then ⌘C (rich unless noted)
const COPY = {
  'in-para': [{ t: 'plain words' }, { t: 'plain words', k: 11 }],
  'across-emph': [{ t: 'here' }, { t: '斜体 italic', k: 4 }],
  'across-both-emph': [{ t: '加粗 bold', k: 3 }, { t: '粗斜 both', k: 4 }],
  'across-formula': [{ t: '行内公式' }, { t: '结束', k: 2 }],
  'link-autolink': [{ t: '普通链接' }, { t: 'auto', k: 4 }],
  'code-strike': [{ t: 'inline code' }, { t: 'struck', k: 6 }],
  'img-inline': [{ t: '高亮' }, { t: 'after image', k: 11 }],
  'hard-break': [{ t: 'hard break' }, { t: 'next line', k: 9 }],
  'whole-li': [{ t: '列表一' }, { t: 'item one', k: 8 }],
  'across-items': [{ t: '列表一', k: 1 }, { t: '列表三', k: 2 }],
  'nested-items': [{ t: '嵌套甲' }, { t: '有序二', k: 3 }],
  'task-items': [{ t: '任务甲' }, { t: '子任务丙', k: 4 }],
  'cell': [{ t: '单元一' }, { t: 'cell1', k: 5 }],
  'row': [{ t: '单元四' }, { t: '单元六 cell6', k: 9 }],
  'code-block': [{ t: 'function demo' }, { t: '代码注释', k: 4 }],
  'indented': [{ t: 'indented code line one' }, { t: 'line two', k: 8 }],
  'quote': [{ t: '引用第一行' }, { t: 'quoted item', k: 11 }],
  'blocks': [{ t: 'wrapped line' }, { t: '列表二', k: 2 }],
  'heading-para': [{ t: '全部块类型' }, { t: 'plain words', k: 5 }],
  'display-math-img': [{ t: '单元五' }, { t: '原始标签', k: 2 }],
  'details': [{ t: '摘要' }, { t: 'details body', k: 12 }],
  'tail': [{ t: '最后一段' }, { t: 'ending words', k: 12 }],
  'whole': ['start', 'end'],
};
const COPY_SMALL = {
  'small-para-table': [{ t: '这是一个用于性能测试' }, { t: '| a', k: 0 }],
  'small-section': [{ t: '第 1 节' }, { t: '引用块', k: 3 }],
  'small-code-math': [{ t: 'export function f1' }, { t: '行内公式', k: 4 }],
};

// app behaviour around the preview
const APP = {
  'sync-wheel-pv': { steps: [['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, 900]], editor: true },
  'sync-wheel-ed': { steps: [['wheel', { pane: 'ed', fx: 0.5, fy: 0.5 }, 900]], editor: true },
  'sync-key-pv': { steps: [['click', T.text], ['key', 'PageDown'], ['key', 'Space'], ['key', 'End']] },
  'sync-key-ed': { steps: [['edit', { at: T.edLine, keys: ['PageDown', 'PageDown'] }]], editor: true },
  'sync-prog-pv': { steps: [['scrollPv', 0.5], ['scrollPv', 0.1]] },
  'sync-prog-ed': { steps: [['scrollEd', 0.5], ['scrollEd', 0.2]], editor: true },
  'focusline-ed': { steps: [['edit', { at: { edLine: 6 } }], ['edit', { at: { edLine: 12 } }]], editor: true },
  'focusline-pv': { steps: [['click', T.text], ['click', T.vb2]] },
  'focusline-pv-sel': { steps: [['drag', T.vb0, T.vb1]] },
  'toc-click': { steps: [['click', { toc: 2 }], ['click', { toc: 4 }]] },
  'find-next': { steps: [['find', 'item'], ['key', 'Enter'], ['key', 'Enter']], editor: true },
  'find-next-pv': { steps: [['find', '段落'], ['key', 'Enter'], ['key', 'Escape']], editor: true },
  'task-at-rest': { steps: [['click', T.task], ['wait', 300], ['click', { css: 'li input[type="checkbox"]', nth: 2 }]] },
  'modes': { steps: [['mode', 'preview'], ['mode', 'edit'], ['mode', 'split'], ['mode', 'preview']] },
  'modes-cmd': { steps: [['click', T.text], ['key', 'Meta+/'], ['key', 'Meta+/'], ['key', 'Meta+/']] },
  'edit-while-sel': { steps: [['click', T.word, { count: 2 }], ['edit', { at: T.edLine, text: ' 新字' }]], editor: true },
  'edit-above-sel': { steps: [['drag', T.vb1, T.vb2], ['edit', { at: { edLine: 0 }, keys: ['Home', 'Enter'] }]], editor: true },
  'undo-far': { steps: [['edit', { at: { edLine: 2, endOfLine: true }, text: ' XY' }], ['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, 2500], ['click', T.text], ['key', 'Meta+z']], editor: true },
  'redo-far': { steps: [['edit', { at: { edLine: 2, endOfLine: true }, text: ' XY' }], ['key', 'Meta+z'], ['wheel', { pane: 'pv', fx: 0.5, fy: 0.5 }, 2500], ['click', T.text], ['key', 'Meta+Shift+z']], editor: true },
  'undo-task-preview': { steps: [['click', T.task], ['key', 'Meta+z']] },
  'task-right-after-edit': { steps: [['edit', { at: { edLine: 0, endOfLine: true }, text: ' z', fast: true }], ['click', T.task]], editor: true },
  'task-right-after-enter': { steps: [['edit', { at: { edLine: 0, endOfLine: true }, keys: ['Enter', 'Enter'], fast: true }], ['click', T.task]], editor: true },
  'task-after-edit-2nd': { steps: [['edit', { at: { edLine: 0, endOfLine: true }, keys: ['Enter'], fast: true }], ['click', { css: 'li input[type="checkbox"]', nth: 1 }]], editor: true },
  'sel-evicted': { steps: [['drag', T.text, T.text2], ['scrollLine', 0.81], ['key', 'Meta+c'], ['scrollLine', 0], ['click', T.vb2, { mods: ['Shift'] }], ['key', 'Meta+c']] },
  'sel-evicted-2': { steps: [['drag', { vb: 3, o: 2 }, { vb: 3, o: 9 }], ['scrollLine', 0.81], ['scrollLine', 0], ['click', { vb: 6, o: 3 }, { mods: ['Shift'] }], ['key', 'Meta+c']] },
  'undo-in-preview': { steps: [['edit', { at: T.edLine, text: ' 改' }], ['click', T.text], ['key', 'Meta+z'], ['key', 'Meta+Shift+z']], editor: true },
  'palette': { steps: [['click', T.text], ['key', 'Meta+Shift+p'], ['type', '模式'], ['key', 'Escape']] },
  'theme': { steps: [['click', T.text], ['key', 'Meta+Shift+l']] },
  'toggle-cmd-twice': { steps: [['cmd', 'view.togglePreviewEdit'], ['cmd', 'view.togglePreviewEdit'], ['click', T.text], ['key', 'ArrowDown'], ['drag', T.vb0, T.vb1], ['key', 'Meta+c']], toggle: true },
  'toggle-btn-twice': { steps: [['click', T.text], ['wait', 50]], toggleBtn: true },
};

// ---------------------------------------------------------------- the case list
const DOCS_ALL = ['rich', 'small', 'readme', 'tasks', 'empty', 'one', 'large'];
const DOCS_KEYS = ['rich', 'small', 'large', 'empty'];
const DOCS_SELKEYS = ['rich', 'small', 'large'];
const cases = [];
for (const mode of ['split', 'preview']) {
  for (const doc of DOCS_ALL) {
    for (const [g, steps] of Object.entries(POINTER)) {
      if (mode === 'preview' && needsEditor(g, steps)) continue;
      cases.push({ name: `${doc}/${mode}/${g}`, doc, mode, steps });
    }
    for (const [g, a] of Object.entries(APP)) {
      if (mode === 'preview' && (a.editor || needsEditor(g, a.steps))) continue;
      cases.push({ name: `${doc}/${mode}/app-${g}`, doc, mode, steps: a.steps, toggle: a.toggle, toggleBtn: a.toggleBtn });
    }
  }
  for (const doc of DOCS_KEYS) for (const k of KEYS) {
    const steps = keySteps(k, 'click');
    if (mode === 'preview' && needsEditor(k, steps)) continue;
    cases.push({ name: `${doc}/${mode}/k-${k}`, doc, mode, steps, ...keyOpts(k) });
  }
  for (const doc of DOCS_SELKEYS) for (const k of KEYS) {
    const steps = keySteps(k, 'sel');
    if (mode === 'preview' && needsEditor(k, steps)) continue;
    cases.push({ name: `${doc}/${mode}/ks-${k}`, doc, mode, steps, ...keyOpts(k) });
  }
  for (const k of ['Shift+ArrowDown', 'Meta+c', 'Space', 'Backspace', 'a', 'Enter', 'Meta+a', 'Escape']) {
    cases.push({ name: `rich/${mode}/kd-${k}`, doc: 'rich', mode, steps: keySteps(k, 'drag'), ...keyOpts(k) });
  }
  for (const [g, [A, B]] of Object.entries(COPY)) {
    cases.push({ name: `rich/${mode}/copy-${g}`, doc: 'rich', mode, steps: [['select', A, B], ['key', 'Meta+c']] });
    cases.push({ name: `rich/${mode}/cut-${g}`, doc: 'rich', mode, steps: [['select', A, B], ['key', 'Meta+x']] });
  }
  for (const [g, [A, B]] of Object.entries(COPY_SMALL)) cases.push({ name: `small/${mode}/copy-${g}`, doc: 'small', mode, steps: [['select', A, B], ['key', 'Meta+c']] });
  for (const doc of ['readme', 'large', 'tasks']) {
    cases.push({ name: `${doc}/${mode}/copy-drag3`, doc, mode, steps: [['drag', T.vb0, T.vb2], ['key', 'Meta+c']] });
    cases.push({ name: `${doc}/${mode}/copy-cmda`, doc, mode, steps: [['click', T.text], ['key', 'Meta+a'], ['key', 'Meta+c']] });
    cases.push({ name: `${doc}/${mode}/copy-dbl`, doc, mode, steps: [['click', T.word, { count: 2 }], ['key', 'Meta+c']] });
    cases.push({ name: `${doc}/${mode}/copy-triple`, doc, mode, steps: [['click', T.li, { count: 3 }], ['key', 'Meta+c']] });
  }
  cases.push({ name: `rich/${mode}/copy-mouse-drag3`, doc: 'rich', mode, steps: [['drag', T.vb0, T.vb2], ['key', 'Meta+c']] });
  cases.push({ name: `rich/${mode}/copy-mouse-table`, doc: 'rich', mode, steps: [['drag', T.cell, { inCss: 'td', nth: 5, o: 3 }], ['key', 'Meta+c']] });
  cases.push({ name: `rich/${mode}/copy-mouse-code`, doc: 'rich', mode, steps: [['drag', T.code, { inCss: 'pre', o: 40 }], ['key', 'Meta+c']] });
}

// links: anchors (both panes navigate), a relative .md link (toast, no navigation), external links (new tab), mailto
for (const mode of ['split', 'preview']) {
  for (let n = 0; n < 9; n++) {
    const L0 = { css: 'a[href]', nth: n };
    cases.push({ name: `links/${mode}/link${n}-click`, doc: 'links', mode, steps: [['click', L0], ['wait', 400]] });
    cases.push({ name: `links/${mode}/link${n}-cmd`, doc: 'links', mode, steps: [['click', L0, { mods: ['Meta'] }]] });
    cases.push({ name: `links/${mode}/link${n}-alt`, doc: 'links', mode, steps: [['click', L0, { mods: ['Alt'] }]] });
    cases.push({ name: `links/${mode}/link${n}-middle`, doc: 'links', mode, steps: [['click', L0, { button: 'middle' }]] });
    cases.push({ name: `links/${mode}/link${n}-key`, doc: 'links', mode, steps: [['click', L0], ['key', 'Enter'], ['key', 'ArrowDown']] });
  }
  cases.push({ name: `links/${mode}/tail-back`, doc: 'links', mode, steps: [['click', { inCss: 'h2', nth: 2, o: 1 }], ['click', { css: 'a[href="#alpha-beta-标题"]', nth: 1 }]] });
}

let todo = cases.filter((c) => !pats.length || pats.some((p) => c.name.includes(p)));
if (shard) todo = todo.filter((_, i) => i % shard.n === shard.i);
if (listOnly) { for (const c of todo) console.log(c.name); console.log(`${todo.length} cases`); process.exit(0); }

// switch toasts are the intended difference of the toggle cases: listed, not compared
const SWITCH_T = /^预览可编辑/;
async function runCase(P, c) {
  const run = async () => {
    await Promise.all([L.reset(P.cand, c.doc, c.mode), L.reset(P.base, c.doc, c.mode)]);
    if (c.doc === 'large' && (P.cand.deepTop === 0)) await L.setupDeep(P);
    let steps = c.steps;
    if (c.toggleBtn) {
      // the toolbar button of the switch exists only in the candidate: press it twice there, then compare
      await P.cand.page.click('[data-cmd="view.togglePreviewEdit"]'); await L.sleep(300);
      await P.cand.page.click('[data-cmd="view.togglePreviewEdit"]'); await L.settle(P.cand, 500);
      await P.cand.page.evaluate(() => { const O = window.__offd; O.ev.length = 0; O.toasts.length = 0; });
      steps = [['click', T.text], ['key', 'ArrowDown'], ['click', T.word, { count: 2 }], ['key', 'Meta+c'], ['drag', T.vb0, T.vb2], ['key', 'Meta+c']];
    }
    if (c.toggle) {
      // compare after the second press only; the switch toasts are filtered
      for (const st of steps) {
        const [ec, eb] = await Promise.all([L.step(P.cand, st).then(() => null, (e) => e.message.split('\n')[0]), L.step(P.base, st).then(() => null, (e) => e.message.split('\n')[0])]);
        if (ec && ec === eb) return { ok: true, skipped: ec };
        if (ec || eb) return { ok: false, at: -2, step: st, diffs: [{ field: 'stepResult', cand: ec, base: eb }] };
      }
      const [co, bo] = await Promise.all([L.obs(P.cand, { clip: true }), L.obs(P.base, { clip: true })]);
      co.toasts = co.toasts.filter((t) => !SWITCH_T.test(t)); bo.toasts = bo.toasts.filter((t) => !SWITCH_T.test(t));
      const d = L.diff(co, bo, { ignore: ['ev'], tol: c.doc === 'rich' || c.doc === 'tasks' || c.doc === 'one' ? 1 : 64 });
      // the key events of ⌘⇧E themselves are compared separately (prevented or not)
      return d.length ? { ok: false, at: steps.length - 1, step: 'final (after toggling twice)', diffs: d, c: co, b: bo } : { ok: true };
    }
    // a jump to the end of a long document, or to a raw scrollbar offset, lands within some tens of px of the same
    // place: 0.1.1 against itself differs the same way (MDR_CONTROL=1), the far heights are estimates until measured
    const loose = c.doc !== 'rich' && c.doc !== 'tasks' && c.doc !== 'one' && /End|Meta\+ArrowDown|Meta\+Shift\+ArrowDown|sync-prog|sync-key|toggle/.test(c.name);
    return L.runBoth(P, steps, { tol: loose ? 64 : 1, ignore: ['ev'] });   // r4-ie: every field but ev
  };
  try { return await run(); } catch (e) { return { ok: false, at: -2, step: 'threw', diffs: [{ field: 'THREW', cand: String(e.message).split('\n')[0], base: '' }] }; }
}

L.globalTimeout(Number(process.env.MDR_TIMEOUT || 3_000_000));
const tag = shard ? `${shard.i}of${shard.n}` : (pats.length ? 'sel' : 'all');
const outFile = `${L.SCRATCH}/matrix-${tag}.json`;
const t0 = Date.now();
const diffs = [];
let pass = 0, skip = 0;
let P;
try {
  P = await L.openPair({ mode: 'split' });
  for (const c of todo) {
    const r = await runCase(P, c);
    if (r.skipped) { skip++; console.log(`SKIP  ${c.name}  (${r.skipped})`); continue; }
    if (r.ok) { pass++; console.log(`PASS  ${c.name}`); continue; }
    let extra = '';
    const bd = r.diffs.find((d) => d.field === 'blocks');
    if (bd && bd.idx) {
      const i = bd.idx[0];
      const [hc, hb] = await Promise.all([L.blockHtml(P.cand, i), L.blockHtml(P.base, i)]);
      let k = 0; while (hc && hb && k < hc.length && hc[k] === hb[k]) k++;
      extra = `\n      block ${i} html from ${k}: cand ${JSON.stringify((hc || '').slice(Math.max(0, k - 60), k + 140))}\n                         base ${JSON.stringify((hb || '').slice(Math.max(0, k - 60), k + 140))}`;
    }
    console.log(`DIFF  ${c.name}  step ${r.at} ${JSON.stringify(r.step).slice(0, 120)}  ${L.fmtDiff(r.diffs)}${extra}`);
    diffs.push({ name: c.name, at: r.at, step: r.step, diffs: r.diffs.map((d) => ({ ...d, cand: typeof d.cand === 'string' ? d.cand.slice(0, 3000) : d.cand, base: typeof d.base === 'string' ? d.base.slice(0, 3000) : d.base })) });
    L.writeJson(outFile, diffs);
    // a difference can leave a side in another state: start the next case from a fresh page pair
    await L.closeAll();
    P = await L.openPair({ mode: 'split' });
  }
} finally {
  await L.closeAll();
  L.writeJson(outFile, diffs);
  console.log(`matrix ${tag}: ${todo.length} cases, ${pass} same, ${diffs.length} differ, ${skip} skipped (target absent in both); ${Math.round((Date.now() - t0) / 1000)} s; diffs in ${outFile}`);
}
