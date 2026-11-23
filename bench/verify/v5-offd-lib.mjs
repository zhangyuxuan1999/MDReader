// bench/verify/v5-offd-lib.mjs — audit-off-diff (0.2.0, switch-off audit): the side-by-side instrument.
//
// Opens the same document in two builds and applies ONE gesture to both, then compares what the user can observe:
//   MDR_PORT       the candidate (a dev server: hooks always on). localStorage mdr.previewEdit = "0" is put in place
//                  before the app starts (context.addInitScript), and every observation asserts that the toolbar button
//                  of view.togglePreviewEdit is not pressed.
//   MDR_BASE_PORT  the 0.1.1 baseline (vite preview of release/baseline-0.1.1.noindex/dist), opened with ?perf=1 for
//                  the hooks; its perf HUD is hidden (display:none) so it does not cover the preview.
//   MDR_SCRATCH    where logs / JSON results go (never inside the tree).
//   MDR_ON=1       debugging aid only: leave the candidate's switch alone (= on in test mode).
// Observations (obs()): source text, document title, status bar, toasts added since the step began, the active element
// (tag / class / pane), the selection (text, and per end the pane, block index and offset inside the block's text),
// CodeMirror's own selection and focus, the preview / editor scroll positions, the preview's blocks (count and a hash
// of each block's HTML after removing what CONTRACT §11 lets differ: data-mdr-x on a block wrapper, elements marked
// data-mdr-ui, data-id), the outline's active entry, open panels / palette / dialogs, pane geometry, every input
// event the page received with whether its default action was prevented, page errors, and after a copy / cut the
// clipboard's text/plain and text/html. diff() lists the fields that differ; the first one is printed with both values.
// Writes nothing into the tree. Every script built on it has a global timeout and closes its browsers in finally.
//
// Serving the two builds (never on the fixer's tree or ports; never a second Vite on the project's node_modules/.vite):
//   candidate  a copy of index.html, package.json, tsconfig.json, public/, test-data/ and the src/ to test, node_modules
//              symlinked to the project's, and a vite.config.ts of its own with cacheDir in the scratch directory AND
//              server.fs.allow = [<the copy>, '<project>/node_modules'] (without it Vite refuses the KaTeX fonts through
//              the symlink and every formula is narrower than in 0.1.1); then  npx vite --port 5521 --strictPort
//              A production build of the candidate also works: vite preview of it, with MDR_CAND_PERF=1 (opens it
//              with ?perf=1 for the hooks) and MDR_STRICT_CLIP=1 (copied HTML compared byte for byte, style="" too).
//   baseline   node <project>/node_modules/vite/bin/vite.js preview --outDir <project>/release/baseline-0.1.1.noindex/dist
//              --port 5522 --strictPort   (from a directory without a vite config)
// Known differences the scripts report on every run (audit-off-diff, 2026-11-21): U2 history outside the editor
// (app-undo-far, app-redo-far, app-undo-task-preview, *-k-Meta+z: OFFD-1), the U15 flag in copied HTML (copy-whole,
// copy-details, rich k-Meta+a: OFFD-2), and 0.1.1 bugs the candidate fixed (large click-task / task-at-rest: the 0.1.1
// preview jumps after a checkbox click; links *-middle: 0.1.1 opens a new tab for an in-document link), and the
// intended U16 / U24 cancel of a raw HTML checkbox or its label (rich click-rawbox / click-rawlabel).
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';

export const ROOT = new URL('../..', import.meta.url).pathname;
export const PORT = Number(process.env.MDR_PORT || 5521);
export const BASE_PORT = Number(process.env.MDR_BASE_PORT || 5522);
export const SCRATCH = process.env.MDR_SCRATCH || '/private/tmp/claude-501/-Users-zyx-LocalDocuments-MDReader/4f5354f2-9475-450d-8fc7-4e2d17b1cb3d/scratchpad/offd';
mkdirSync(SCRATCH, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browsers = new Set();
export async function closeAll() {
  for (const b of browsers) { try { await Promise.race([b.close(), sleep(4000)]); } catch { /* */ } }
  browsers.clear();
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await closeAll(); process.exit(143); });
/** Exits with code 3 after `ms`, closing every browser first. */
export function globalTimeout(ms) {
  const t = setTimeout(async () => { console.log(`GLOBAL TIMEOUT after ${ms} ms`); await closeAll(); process.exit(3); }, ms);
  t.unref?.();
  return t;
}

/** Seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.int = (n) => Math.floor(f() * n);
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  return f;
}

// ---------------------------------------------------------------- documents
import { deflateSync } from 'node:zlib';
/** A solid-colour PNG as a data: URI (markdown-it accepts data:image/png, not svg). */
function PNG_SVG(w, h, fill) {
  const rgb = [1, 3, 5].map((i) => parseInt(fill.length === 4 ? fill[(i + 1) / 2].repeat(2) : fill.slice(i, i + 2), 16));
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; } }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
export const RICH = [
  '# 全部块类型 All block kinds',
  '',
  `第一段 plain words here，**加粗 bold**、*斜体 italic*、***粗斜 both***、\`inline code\`、~~删除 struck~~、[普通链接](https://example.com/a)、<https://example.org/auto>、[引用链接][ref1]、行内公式 $a^2+b^2=c^2$ 结束、脚注[^1]、<kbd>Ctrl</kbd> 和 <mark>高亮</mark>、小图 ![小图](${PNG_SVG(40, 20, '#c33')}) 后文 after image。`,
  '',
  '第二段 second paragraph with a hard break  ',
  'next line after break and a soft',
  'wrapped line end.',
  '',
  '## 第二节 Lists',
  '',
  '- 列表一 item one',
  '- 列表二 item two',
  '  - 嵌套甲 nested alpha',
  '  - 嵌套乙 nested beta',
  '    1. 有序一 ordered one',
  '    2. 有序二 ordered two',
  '- 列表三 item three',
  '',
  '1. 第一步 first step',
  '2. 第二步 second step',
  '',
  '- [ ] 任务甲 task alpha',
  '- [x] 任务乙 task beta',
  '  - [ ] 子任务丙 subtask gamma',
  '',
  '> 引用第一行 quote line one',
  '> 引用第二行 **quote bold**',
  '>',
  '> - 引用里的列表 quoted item',
  '',
  '```js',
  'function demo(x) {',
  '  return x * 2; // 代码注释 comment',
  '}',
  '```',
  '',
  '    indented code line one',
  '    indented code line two',
  '',
  '| 左 Left | 中 Center | 右 Right |',
  '|:--------|:--------:|--------:|',
  '| 单元一 cell1 | **单元二** cell2 | `cell3` |',
  '| 单元四 cell4 | 单元五 cell5 | 单元六 cell6 |',
  '',
  '$$',
  String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`,
  '$$',
  '',
  `![大图 big image](${PNG_SVG(240, 90, '#36c')})`,
  '',
  '<div class="note"><label><input type="checkbox"> 原始标签 raw label</label> 原始 HTML 段 raw html</div>',
  '',
  '<details>',
  '<summary>摘要 summary text</summary>',
  '',
  '详情内容 details body paragraph.',
  '',
  '</details>',
  '',
  '<div data-l="9" class="md-fake">保留名 reserved names</div>',
  '',
  '---',
  '',
  '最后一段 last paragraph 带链接 [尾链接](https://example.com/tail) 和结尾文字 ending words.',
  '',
  '[ref1]: https://example.com/ref "引用标题"',
  '[^1]: 脚注内容 footnote text.',
  '',
].join('\n');

export const TASKS = [
  '# 任务清单 Tasks',
  '',
  '- [ ] 第一项 first task',
  '- [x] 第二项 second task',
  '- [ ] 第三项 third task',
  '  - [ ] 嵌套任务 nested task',
  '  - [x] 嵌套完成 nested done',
  '',
  '一段文字 between lists.',
  '',
  '1. [ ] 有序任务 ordered task',
  '2. [x] 有序完成 ordered done',
  '',
  '> - [ ] 引用任务 quoted task',
  '',
  '- [ ] 同名 same',
  '- [ ] 同名 same',
  '',
].join('\n');

export const ONE = 'Just one line with a [link](https://example.com/x) and *emphasis* inside.';

export const LINKS = [
  '# Alpha Beta 标题',
  '',
  '锚点 [jump anchor](#alpha-beta-标题)、相对 [relative md](./other.md)、外部 [external](https://example.com/ext)、邮件 <mailto:a@example.com>、裸链接 https://example.org/bare 结束。',
  '',
  '## Second 第二',
  '',
  '[raw slug](#second-第二) 和 [missing](#nowhere) 以及 [图片链接 ![i](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC)](https://example.com/img)',
  '',
  ...Array.from({ length: 40 }, (_, i) => `填充段落 filler paragraph ${i + 1}，让锚点跳转需要滚动。`).flatMap((l) => [l, '']),
  '## Tail 尾',
  '',
  '[back to top](#alpha-beta-标题)',
  '',
].join('\n');

let cache = {};
export function docText(name) {
  if (cache[name] !== undefined) return cache[name];
  let t;
  switch (name) {
    case 'small': t = readFileSync(`${ROOT}test-data/small.md`, 'utf8'); break;
    case 'readme': t = readFileSync(`${ROOT}README.md`, 'utf8'); break;
    case 'rich': t = RICH; break;
    case 'tasks': t = TASKS; break;
    case 'empty': t = ''; break;
    case 'one': t = ONE; break;
    case 'links': t = LINKS; break;
    case 'large': t = readFileSync(`${ROOT}test-data/large.md`, 'utf8'); break;
    default: throw new Error('unknown doc ' + name);
  }
  cache[name] = t;
  return t;
}
export const DOC_NAMES = ['small', 'readme', 'rich', 'tasks', 'empty', 'one', 'large'];

// ---------------------------------------------------------------- page-side code
function INIT() {
  const TYPES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'keydown', 'keyup', 'keypress',
    'beforeinput', 'input', 'wheel', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'paste', 'copy', 'cut', 'selectstart',
    'compositionstart', 'compositionupdate', 'compositionend', 'focusin', 'focusout', 'submit'];
  const O = (window.__offd = { ev: [], toasts: [], errs: [] });
  const whereOf = (t) => {
    if (!t || t === window) return 'win';
    if (t === document) return 'doc';
    const el = t.nodeType === 1 ? t : t.parentElement;
    if (!el) return 'none';
    if (el.closest('.mdr-preview')) return el.closest('[data-mdr-ui]') ? 'pv-ui' : 'pv';
    if (el.closest('.cm-editor')) return 'ed';
    if (el === document.body) return 'body';
    const c = typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName;
    return c;
  };
  for (const t of TYPES) {
    window.addEventListener(t, (e) => {
      const rec = { t, w: whereOf(e.target), tr: e.isTrusted ? 1 : 0 };
      setTimeout(() => { rec.p = e.defaultPrevented ? 1 : 0; O.ev.push(rec); }, 0);
    }, { capture: true, passive: true });
  }
  window.addEventListener('error', (e) => O.errs.push(String(e.message)));
  const watch = () => {
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains('mdr-toast')) O.toasts.push(n);
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
}

function OBS() {
  const root = document.querySelector('.mdr-preview');
  const cmEl = document.querySelector('.cm-editor');
  const scroller = document.querySelector('.cm-scroller');
  const sections = root ? Array.from(root.querySelectorAll('section.md-block')) : [];
  // blocks are named by their block id (data-id, assigned by the worker: the same in both builds for the same
  // text and edits), not by their place among the DOM's sections: the DOM holds a window of the document whose
  // extent is timing on long documents (0.1.1 has no PreviewApi.blockOfElement)
  const pvApi = window.__mdr && window.__mdr.app ? window.__mdr.app.preview : null;
  const idxOf = (s) => (s && s.dataset && s.dataset.id !== undefined ? Number(s.dataset.id) : -1);
  const paneOf = (n) => {
    if (!n) return 'none';
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (!el) return 'none';
    if (root && root.contains(el)) return el.closest('[data-mdr-ui]') ? 'pv-ui' : 'pv';
    if (cmEl && cmEl.contains(el)) return 'ed';
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    return 'other:' + (typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName);
  };
  const endOf = (node, off) => {
    const w = paneOf(node);
    if (w !== 'pv' && w !== 'pv-ui') return { w, n: node ? node.nodeName : null, off: w === 'ed' ? undefined : off };
    const el = node.nodeType === 1 ? node : node.parentElement;
    const s = el.closest('section.md-block');
    if (!s) return { w, block: -1, n: node.nodeName, off: node.nodeType === 1 && node.childNodes[off] && node.childNodes[off].nodeType === 1 && node.childNodes[off].matches('section.md-block') ? 'before#' + idxOf(node.childNodes[off]) : off };
    const r = document.createRange();
    r.setStart(s, 0);
    try { r.setEnd(node, off); } catch { return { w, block: idxOf(s), off: 'bad' }; }
    return { w, block: idxOf(s), off: r.toString().length };
  };
  const sel = getSelection();
  const ae = document.activeElement;
  const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
  const uiSeen = [];
  const norm = (s) => {
    const c = s.cloneNode(true);
    for (const u of c.querySelectorAll('[data-mdr-ui]')) { uiSeen.push(u.tagName + '.' + u.className); u.remove(); }
    c.removeAttribute('data-mdr-x');
    c.removeAttribute('data-id');
    for (const e of [c, ...c.querySelectorAll('[class=""]')]) if (e.getAttribute('class') === '') e.removeAttribute('class');
    return c.outerHTML;
  };
  // blocks outside the preview's viewport are compared only by their place (their mount / measure state is timing);
  // what they show is compared once they are scrolled into view, and their source by the source text
  const pbox = root ? root.getBoundingClientRect() : null;
  const blocks = [];
  for (const s of sections) { const r = s.getBoundingClientRect(); if (pbox && pbox.height > 0 && r.bottom > pbox.top + 2 && r.top < pbox.bottom - 2) blocks.push(`${idxOf(s)}:${fnv(norm(s))}`); }
  const rootUi = Array.from(document.querySelectorAll('[data-mdr-ui]')).filter((u) => !u.closest('section.md-block')).map((u) => {
    const cs = getComputedStyle(u); const r = u.getBoundingClientRect();
    return `${u.tagName}.${u.className} display=${cs.display} vis=${cs.visibility} ${Math.round(r.width)}x${Math.round(r.height)} text=${JSON.stringify(u.textContent.slice(0, 40))}`;
  });
  const O = window.__offd || { ev: [], toasts: [], errs: [] };
  const ev = [];
  for (const e of O.ev) {
    const k = `${e.t}@${e.w}${e.p ? '!' : ''}${e.tr ? '' : '~'}`;
    if (ev.length && ev[ev.length - 1] === k && /^(dragover|wheel|keydown|keyup)/.test(e.t)) continue;
    ev.push(k);
  }
  const view = window.__mdr && window.__mdr.app && window.__mdr.app.editor && window.__mdr.app.editor.view;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); };
  const vis = (el) => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const btn = document.querySelector('[data-cmd="view.togglePreviewEdit"]');
  const edLines = [];
  if (view) {
    for (const l of document.querySelectorAll('.cm-content .cm-line')) {
      const cls = l.className.split(' ').filter((c) => c !== 'cm-line').sort().join(' ');
      if (!cls) continue;
      let n = -1; try { n = view.state.doc.lineAt(view.posAtDOM(l)).number; } catch { /* */ }
      edLines.push(`${n}:${cls}`);
    }
  }
  const tocActive = Array.from(document.querySelectorAll('.mdr-toc .is-active, .mdr-toc [aria-current="true"]')).map((e) => e.textContent.trim().slice(0, 40));
  return {
    src: window.__mdr ? window.__mdr.app.getText() : null,
    version: window.__mdr ? window.__mdr.version() : null,
    title: document.title,
    status: (document.querySelector('.mdr-statusbar') || {}).textContent || '',
    toasts: O.toasts.map((t) => (t.querySelector('.mdr-toast__text') || t).textContent.trim()),
    active: ae ? { tag: ae.tagName, cls: typeof ae.className === 'string' ? ae.className.split(' ').filter((c) => !/^cm-focused$/.test(c)).join(' ') : '', pane: paneOf(ae) } : null,
    // a page-wide selection (⌘A with the focus on the body: outline, editor DOM, preview DOM window, overlay) is named by
    // its ends' panes only: its text holds CodeMirror's rendered viewport and the preview's DOM window (timing)
    sel: (() => {
      const a = sel.anchorNode ? endOf(sel.anchorNode, sel.anchorOffset) : null, f = sel.focusNode ? endOf(sel.focusNode, sel.focusOffset) : null;
      const inPane = (e) => !e || e.w === 'pv' || e.w === 'ed' || e.w === 'pv-ui';
      if (inPane(a) && inPane(f)) return { type: sel.type, text: sel.toString(), a, f };
      const p = (e) => (e ? (/^other:mdr-(toasts|overlay)/.test(e.w) ? 'overlay' : e.w) : null);
      return { type: sel.type, pageWide: true, a: p(a), f: p(f) };
    })(),
    cm: view ? { ranges: view.state.selection.ranges.map((r) => `${r.anchor}-${r.head}`).join(' '), focus: view.hasFocus } : null,
    // what is at the top of each pane (block index / editor line, and how far it is scrolled past), not the raw
    // offsets: far blocks have estimated heights until measured, so raw offsets of a long scroll are timing
    scroll: (() => {
      const o = { pv: null, pvEnd: null, ed: null, edEnd: null, pvx: root ? Math.round(root.scrollLeft) : null, win: Math.round(window.scrollY) };
      if (root && pbox && pbox.height > 0) {
        const i = sections.findIndex((s) => s.getBoundingClientRect().bottom > pbox.top + 2);
        o.pv = i < 0 ? `none@${Math.round(root.scrollTop)}` : `${idxOf(sections[i])}+${Math.round(pbox.top - sections[i].getBoundingClientRect().top)}`;
        o.pvEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
        if (root.scrollTop < 2) o.pv = 'top';
      }
      if (scroller && view && scroller.getBoundingClientRect().height > 0) {
        let ed = 'none';
        try {
          const pad = view.documentPadding ? view.documentPadding.top : 0;
          const blk = view.lineBlockAtHeight(Math.max(0, scroller.scrollTop - pad));
          ed = `${view.state.doc.lineAt(blk.from).number}+${Math.round(scroller.scrollTop - pad - blk.top)}`;
        } catch { /* */ }
        o.ed = scroller.scrollTop < 2 ? 'top' : ed;
        o.edEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      }
      return o;
    })(),
    scrollRaw: { pv: root ? Math.round(root.scrollTop) : null, ed: scroller ? Math.round(scroller.scrollTop) : null },
    blockCount: pvApi ? pvApi.blockCount() : sections.length,
    domSections: sections.length,
    blocks,
    rootUi,
    ui: Array.from(new Set(uiSeen)),
    toc: tocActive.join(' | '),
    edLines,
    panels: {
      search: vis(document.querySelector('.cm-search')),
      palette: vis(document.querySelector('.mdr-palette')),
      dialog: Array.from(document.querySelectorAll('.mdr-dialog')).filter(vis).map((d) => d.textContent.trim().slice(0, 80)),
      overlay: Array.from(document.querySelectorAll('.mdr-overlay > *')).filter((e) => vis(e) && !e.classList.contains('mdr-perf') && !e.classList.contains('mdr-toasts')).map((e) => e.className),
    },
    geom: { pv: rect(root), ed: rect(cmEl) },
    ev,
    errs: O.errs.slice(),
    switchPressed: btn ? btn.getAttribute('aria-pressed') : null,
  };
}

// ---------------------------------------------------------------- sides
/** One build in its own headless Chromium (its own clipboard). kind: 'cand' | 'base'. */
export async function openSide(kind, { mode = 'split', viewport = { width: 1400, height: 900 } } = {}) {
  // MDR_CONTROL=1: a noise-floor run, the baseline against itself (MDR_PORT = MDR_BASE_PORT = the baseline)
  const port = kind === 'cand' ? PORT : BASE_PORT;
  const perf = kind === 'base' || !!process.env.MDR_CONTROL || !!process.env.MDR_CAND_PERF;
  const origin = `http://localhost:${port}`;
  const browser = await chromium.launch({ headless: true });
  browsers.add(browser);
  const context = await browser.newContext({ viewport, colorScheme: 'light', deviceScaleFactor: 1 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  if (kind === 'cand' && !process.env.MDR_ON) await context.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  // a navigation away (a link that was not prevented) is an observation, never a crash of the script
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
  context.on('page', async (p) => {
    // a new tab: its URL once it left about:blank (at most 1 s), then closed
    let u = p.url();
    for (let i = 0; i < 20 && u === 'about:blank'; i++) { await sleep(50); u = p.url(); }
    // external hosts are blocked (route below): such a tab shows about:blank or chrome-error depending on when it is
    // looked at, so both read as one value; a tab of this origin keeps its URL
    navs.push('popup:' + (u === 'about:blank' || u.startsWith('chrome-error:') ? '(external or blank)' : u));
    p.close().catch(() => {});
  });
  // nothing leaves this machine: requests to any other host are aborted (a link may open https://example.com/…)
  await context.route((u) => !/^(http:\/\/localhost[:/]|data:|blob:|about:)/.test(String(u)), (r) => r.abort().catch(() => {}));
  const url = `${origin}/?mode=${mode}${perf ? '&perf=1' : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__mdr && window.__mdr.app), null, { timeout: 60000 });
  if (perf) await page.addStyleTag({ content: '.mdr-perf{display:none!important}' });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
  navs.length = 0;
  const side = { kind, port, browser, context, page, pageErrors, navs, url, mode, doc: null, docVersion: null, deepTop: 0, pts: [] };
  return side;
}

export async function openPair(opts = {}) {
  const [cand, base] = await Promise.all([openSide('cand', opts), openSide('base', opts)]);
  return { cand, base };
}

/** Waits until the worker is idle and both scroll positions have stopped moving. */
export async function settle(S, ms = 250) {
  await sleep(ms);
  await Promise.race([S.page.evaluate(() => window.__mdr.waitIdle()), sleep(4000)]);
  let last = null;
  for (let i = 0; i < 25; i++) {
    const now = await S.page.evaluate(() => { const r = document.querySelector('.mdr-preview'); const s = document.querySelector('.cm-scroller'); return `${r ? Math.round(r.scrollTop) : 0}/${s ? Math.round(s.scrollTop) : 0}`; });
    if (now === last) break;
    last = now;
    await sleep(90);
  }
}

/** Loads `docName` (or reuses it when unchanged), puts mode, scroll, selection, focus, clipboard and the logs at rest. */
export async function reset(S, docName, mode = 'split', { fresh = false } = {}) {
  const p = S.page;
  // close what a previous gesture may have opened
  for (let i = 0; i < 3; i++) {
    const open = await p.evaluate(() => {
      const vis = (el) => !!el && el.getBoundingClientRect().width > 0;
      return vis(document.querySelector('.cm-search')) || vis(document.querySelector('.mdr-palette')) || Array.from(document.querySelectorAll('.mdr-dialog')).some(vis);
    });
    if (!open) break;
    await p.evaluate(() => { const e = document.querySelector('.cm-search input, .mdr-palette__input, .mdr-dialog button'); e && e.focus(); });
    await p.keyboard.press('Escape');
    await sleep(150);
  }
  for (const k of ['Shift', 'Alt', 'Meta', 'Control']) await p.keyboard.up(k).catch(() => {});
  await p.mouse.up().catch(() => {});
  await p.mouse.move(5, 895);
  if (S.mode !== mode) { await p.evaluate((m) => window.__mdr.mode(m), mode); S.mode = mode; await sleep(250); }
  const version = await p.evaluate(() => window.__mdr.version());
  const reload = fresh || S.doc !== docName || docName !== 'large' || version !== S.docVersion;
  if (reload) {
    await p.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: docText(docName), n: `${docName}.md` });
    S.doc = docName;
    await settle(S, docName === 'large' ? 900 : 250);
    S.docVersion = await p.evaluate(() => window.__mdr.version());
  }
  await p.evaluate(() => { getSelection().removeAllRanges(); const a = document.activeElement; if (a && a !== document.body) a.blur(); });
  if (docName === 'large' && S.deepLine) {
    // the same CONTENT on both sides (a raw offset would show different blocks: far heights are estimates)
    await p.evaluate((line) => { const s = document.querySelector('.cm-scroller'); if (s) s.scrollTop = 0; window.__mdr.app.preview.scrollToLine(line, 0, 'instant'); }, S.deepLine);
    await settle(S, 1200);
    // whether scroll sync follows a programmatic preview scroll is timing: a small user scroll there and back
    // makes the editor follow on both sides (split mode)
    if (S.mode === 'split') {
      const b = await p.evaluate(() => { const r = document.querySelector('.mdr-preview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await p.mouse.move(b.x, b.y); await p.mouse.wheel(0, 60); await sleep(250); await p.mouse.wheel(0, -60);
      await settle(S, 900);
      await p.mouse.move(5, 895);
    }
  } else {
    await p.evaluate(() => {
      const r = document.querySelector('.mdr-preview'); const s = document.querySelector('.cm-scroller');
      if (s && Math.round(s.scrollTop) !== 0) s.scrollTop = 0;
      if (r && Math.round(r.scrollTop) !== 0) r.scrollTop = 0;
    });
    await settle(S, 700);
  }
  await p.evaluate(() => navigator.clipboard.writeText('<<offd-none>>'));
  await p.evaluate(() => { const O = window.__offd; O.ev.length = 0; O.toasts.length = 0; O.errs.length = 0; });
  S.pageErrors.length = 0; S.navs.length = 0; S.pts = [];
}

/** For the large document: a deep preview position, the same number on both sides (taken from the candidate). */
export async function setupDeep(P) {
  // 60 % into test-data/large.md: the line of the heading 「## 第 1800 节」
  const line = docText('large').split('\n').findIndex((l) => l.startsWith('## 第 1800 节')) + 1;
  P.cand.deepLine = line; P.base.deepLine = line;
  P.cand.deepTop = 1; P.base.deepTop = 1;
  await Promise.all([reset(P.cand, 'large', P.cand.mode), reset(P.base, 'large', P.base.mode)]);
}

export async function obs(S, { clip = false } = {}) {
  await sleep(20);
  const o = await S.page.evaluate(OBS);
  o.pageErrors = S.pageErrors.slice();
  o.navs = S.navs.slice();
  o.pts = S.pts.slice();
  if (clip) {
    o.clip = await S.page.evaluate(async () => {
      try {
        const items = await navigator.clipboard.read();
        const out = {};
        for (const it of items) for (const t of it.types) out[t] = await (await it.getType(t)).text();
        return out;
      } catch (e) { return { error: String(e) }; }
    });
  }
  return o;
}

const FIELDS = ['pageErrors', 'errs', 'navs', 'src', 'title', 'status', 'toasts', 'active', 'sel', 'cm', 'scroll', 'blockCount', 'blocks', 'toc', 'edLines', 'panels', 'geom', 'ev', 'clip', 'pts', 'rootUi'];
const J = (v) => JSON.stringify(v);
/** Fields that differ between the two observations: [{field, cand, base, detail}]. `ignore`: field names to skip. */
export const INTENDED_PREVENT = /^Meta\+(Shift\+)?z$|^Meta\+Shift\+e$/;
// knownClip: leave out the U15 flag data-mdr-x="" that the copied text/html of a flagged block carries (finding
// OFFD-2 of audit-off-diff; the fuzz passes it so that one known difference does not end every run)
export function diff(c, b, { ignore = [], tol = 1, intendedPrevent = false, knownClip = false } = {}) {
  const out = [];
  for (const f of FIELDS) {
    if (ignore.includes(f)) continue;
    if (f === 'rootUi') continue; // listed separately (rule 8): candidate-only UI elements
    let cv = c[f], bv = b[f];
    if (f === 'scroll' && cv && bv && tol > 4) {
      // loose (a jump to the end of a long document / to a raw offset): raw offsets within tol, same end flags
      // a pane passes when the same block / line is at its top within tol px, or its raw offset is within tol
      const rc = c.scrollRaw || {}, rb = b.scrollRaw || {};
      const anch = (x, y) => { if (x === y) return true; const a = /^(\d+)\+(-?\d+)$/.exec(String(x)), b2 = /^(\d+)\+(-?\d+)$/.exec(String(y)); return !!(a && b2 && a[1] === b2[1] && Math.abs(a[2] - b2[2]) <= tol); };
      const bad = ['pv', 'ed'].filter((k) => !anch(cv[k], bv[k]) && !(rc[k] !== null && rb[k] !== null && Math.abs(rc[k] - rb[k]) <= tol)).concat(['pvx', 'win'].filter((k) => cv[k] !== bv[k]));
      if (bad.length) out.push({ field: 'scroll', cand: { ...cv, raw: rc }, base: { ...bv, raw: rb }, detail: 'loose ' + bad.join(',') });
      continue;
    }
    if (f === 'pts' && tol > 4) continue;
    if (f === 'scroll' && cv && bv) {
      // same block / line at the top, scrolled past by the same amount within 4 px (scroll sync interpolates
      // through estimated heights of blocks that are not measured yet: a few px of timing)
      const same = (x, y) => { if (x === y) return true; const a = /^(\d+)\+(-?\d+)$/.exec(String(x)), b2 = /^(\d+)\+(-?\d+)$/.exec(String(y)); return !!(a && b2 && a[1] === b2[1] && Math.abs(a[2] - b2[2]) <= Math.max(4, tol)); };
      // (a top exactly on a line / block boundary reads "61170+26" on one side and "61171+1" on the other: the raw
      // offsets within 3 px count as the same place too)
      const raw = (k) => (k === 'pv' || k === 'ed') && c.scrollRaw && b.scrollRaw && c.scrollRaw[k] !== null && Math.abs(c.scrollRaw[k] - b.scrollRaw[k]) <= 3;
      const bad = Object.keys(cv).filter((k) => (typeof cv[k] === 'number' ? Math.abs(cv[k] - bv[k]) > tol : !same(cv[k], bv[k]) && !raw(k)));
      if (bad.length) out.push({ field: 'scroll', cand: { ...cv, raw: c.scrollRaw }, base: { ...bv, raw: b.scrollRaw }, detail: bad.join(',') });
      continue;
    }
    if (f === 'pts' && cv && bv) {
      const bad = cv.findIndex((p, i) => !bv[i] || Math.abs(p.x - bv[i].x) > 4 || Math.abs(p.y - bv[i].y) > 4);
      if (bad >= 0 || cv.length !== bv.length) out.push({ field: 'pts', cand: cv, base: bv, detail: `point ${bad}` });
      continue;
    }
    if (f === 'blocks' && cv && bv) {
      // visible blocks as "modelIndex:hash"; in loose mode only blocks visible on both sides are compared
      const mc = new Map(cv.map((x) => x.split(':'))), mb = new Map(bv.map((x) => x.split(':')));
      const keys = Array.from(new Set([...mc.keys(), ...mb.keys()])).sort((a, b2) => a - b2);
      const idx = keys.filter((k) => mc.get(k) !== mb.get(k) && !(tol > 4 && (!mc.has(k) || !mb.has(k)))).map(Number);
      if (idx.length) out.push({ field: 'blocks', cand: idx.slice(0, 5).map((i) => mc.get(String(i)) || 'not visible'), base: idx.slice(0, 5).map((i) => mb.get(String(i)) || 'not visible'), detail: `blocks ${idx.slice(0, 8).join(',')}${idx.length > 8 ? '…' : ''} (${idx.length})`, idx });
      continue;
    }
    if (f === 'clip' && c.sel && c.sel.pageWide && b.sel && b.sel.pageWide) continue; // a page-wide copy: see sel above
    if (f === 'clip' && cv && bv && !process.env.MDR_STRICT_CLIP) {
      // the baseline is a production build: its CSS is minified, which reorders and rewrites the declarations
      // Chromium copies into style="" attributes (background: transparent -> 0px 0px); so style attributes are left
      // out by default; with MDR_STRICT_CLIP=1 (production build against production build) the bytes compare
      // and the two builds have different origins (ports): links copied as absolute URLs differ only by that
      const sortStyles = (h) => (typeof h === 'string' ? h.replace(/ style="[^"]*"/g, '').replace(/http:\/\/localhost:\d+\//g, 'ORIGIN/').replace(/(&amp;|&)perf=1/g, '').replace(knownClip ? / data-mdr-x=""/g : /$^/, '') : h);
      const n = (o) => J(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'text/html' ? sortStyles(v) : v])));
      if (n(cv) !== n(bv)) {
        const a = sortStyles(cv['text/html'] || ''), b2 = sortStyles(bv['text/html'] || '');
        let i = 0; while (i < a.length && a[i] === b2[i]) i++;
        out.push({ field: 'clip', cand: cv, base: bv, detail: cv['text/plain'] !== bv['text/plain'] ? 'text/plain differs' : `text/html from ${i}: cand ${J(a.slice(Math.max(0, i - 40), i + 80))} base ${J(b2.slice(Math.max(0, i - 40), i + 80))}` });
      }
      continue;
    }
    if (f === 'ev' && intendedPrevent && Array.isArray(cv) && Array.isArray(bv)) {
      // CONTRACT §11 U2: ⌘Z / ⇧⌘Z outside the editor step CodeMirror's history (the key is prevented; 0.1.1 left it
      // to the browser's native undo); ⌘⇧E is the switch. Their keydown's "prevented" mark is the intended difference.
      const strip = (a) => a.map((x) => x.replace(/^(keydown@[^!~]*)!/, '$1')).filter((x, i, arr) => !(i > 0 && x === arr[i - 1] && /^key(down|up)@/.test(x)));
      if (J(strip(cv)) === J(strip(bv))) continue;
    }
    if (J(cv) !== J(bv)) {
      let detail = '';
      if (typeof cv === 'string' && typeof bv === 'string') {
        let i = 0; while (i < cv.length && cv[i] === bv[i]) i++;
        detail = `first differing char ${i}: cand ${J(cv.slice(Math.max(0, i - 20), i + 40))} base ${J(bv.slice(Math.max(0, i - 20), i + 40))}`;
      } else if (f === 'ev' && Array.isArray(cv) && Array.isArray(bv)) {
        let i = 0; while (i < cv.length && cv[i] === bv[i]) i++;
        detail = `event ${i}: cand ${J(cv.slice(i, i + 6))} base ${J(bv.slice(i, i + 6))}`;
      } else {
        const x = J(cv) || '', y = J(bv) || '';
        let i = 0; while (i < x.length && x[i] === y[i]) i++;
        if (i > 60) detail = `JSON from ${i}: cand ${x.slice(i - 40, i + 60)} base ${y.slice(i - 40, i + 60)}`;
      }
      out.push({ field: f, cand: cv, base: bv, detail });
    }
  }
  if (c.switchPressed !== 'false' && !process.env.MDR_ON && !process.env.MDR_CONTROL) out.unshift({ field: 'SWITCH', cand: c.switchPressed, base: null, detail: 'the candidate\'s 预览可编辑 button is not "aria-pressed=false"' });
  return out;
}

const short = (v, n = 260) => { const s = typeof v === 'string' ? J(v) : J(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };
export function fmtDiff(d) {
  if (!d.length) return 'same';
  const f = d[0];
  const more = d.length > 1 ? `  (+ ${d.slice(1).map((x) => x.field).join(', ')})` : '';
  if (f.field === 'src' || f.field === 'status' || f.field === 'title') return `${f.field}: ${f.detail}${more}`;
  return `${f.field}${f.detail ? ' [' + f.detail + ']' : ''}: cand=${short(f.cand)} base=${short(f.base)}${more}`;
}

/** HTML of block i on a side, normalized like OBS (for printing a block difference). */
export async function blockHtml(S, i) {
  return S.page.evaluate((i) => {
    const s = document.querySelector(`.mdr-preview section.md-block[data-id="${i}"]`);
    if (!s) return null;
    const c = s.cloneNode(true);
    for (const u of c.querySelectorAll('[data-mdr-ui]')) u.remove();
    c.removeAttribute('data-mdr-x'); c.removeAttribute('data-id');
    for (const e of [c, ...c.querySelectorAll('[class=""]')]) if (e.getAttribute('class') === '') e.removeAttribute('class');
    return c.outerHTML;
  }, i);
}

// ---------------------------------------------------------------- points
// P = {t: needle, k, side, nth}        character k of a (preferably visible) occurrence of needle in the preview
//   | {css, fx, fy, nth}               an element of the preview (preferably visible)
//   | {b, o}                           character o of the text of the block whose data-id is b (fuzz)
//   | {beside: css|null, nth}          the blank space right of a block (of the first visible block when css is null)
//   | {below: true}                    the blank space below the last block (scrolls to the end)
//   | {ed: needle, k}                  character k of needle in the editor (CodeMirror)
//   | {edLine: n}                      start of the n-th visible editor line
//   | {toc: n}                         the n-th outline entry
//   | {pane: 'pv'|'ed', fx, fy}        a relative point of a pane
//   | {x, y}
function RESOLVE(P) {
  const root = document.querySelector('.mdr-preview');
  const box = root.getBoundingClientRect();
  const inView = (r) => r.top >= box.top + 4 && r.bottom <= box.bottom - 4 && r.height > 0;
  const bring = (r, el) => {
    if (P.align) {
      // second pass after a scroll: centre the target exactly (heights measured by now), so both builds agree
      const d = Math.round(r.top + r.height / 2 - (box.top + box.height / 2));
      if (Math.abs(d) <= 1) return false;
      root.scrollTop += d;
      return true;
    }
    if (inView(r)) return false;
    root.scrollTop += r.top - (box.top + box.height / 2);
    return true;
  };
  const textPoint = (node, at, side) => {
    const rg = document.createRange();
    const end = Math.min(node.data.length, at + 1);
    rg.setStart(node, Math.min(at, node.data.length)); rg.setEnd(node, end);
    const rects = Array.from(rg.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    const r = rects[0] || rg.getBoundingClientRect();
    return { r, x: side === 'right' ? r.right - Math.min(1.5, r.width / 3) : r.left + Math.min(1.5, r.width / 3), y: r.top + r.height / 2 };
  };
  const ok = (n) => (n.parentElement && n.parentElement.closest('[data-mdr-ui], .katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
  if (P.t !== undefined) {
    const hits = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: ok });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      let i = n.data.indexOf(P.t);
      while (i >= 0) { hits.push([n, i]); i = n.data.indexOf(P.t, i + 1); if (hits.length > 400) break; }
      if (hits.length > 400) break;
    }
    if (!hits.length) return { err: 'not shown: ' + P.t };
    const vis = hits.filter(([n, i]) => inView(textPoint(n, i + (P.k || 0), P.side).r));
    const list = vis.length ? vis : hits;
    const [n, i] = list[Math.min(P.nth || 0, list.length - 1)];
    let q = textPoint(n, i + (P.k || 0), P.side);
    const moved = bring(q.r);
    if (moved) q = textPoint(n, i + (P.k || 0), P.side);
    return { x: q.x, y: q.y, moved };
  }
  if (P.b !== undefined) {
    const s = root.querySelector(`section.md-block[data-id="${P.b}"]`);
    if (!s) return { err: 'no block ' + P.b };
    const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT, { acceptNode: ok });
    let left = P.o || 0, last = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.trim()) { continue; }
      last = n;
      if (left < n.data.length) { let q = textPoint(n, left, P.side); const moved = bring(q.r); if (moved) q = textPoint(n, left, P.side); return { x: q.x, y: q.y, moved }; }
      left -= n.data.length;
    }
    if (last) { let q = textPoint(last, Math.max(0, last.data.length - 1), 'right'); const moved = bring(q.r); if (moved) q = textPoint(last, Math.max(0, last.data.length - 1), 'right'); return { x: q.x, y: q.y, moved }; }
    const r = s.getBoundingClientRect();
    if (r.height === 0) return { err: 'empty block ' + P.b };
    const moved = bring(r);
    const r2 = s.getBoundingClientRect();
    return { x: r2.left + 4, y: r2.top + Math.min(8, r2.height / 2), moved };
  }
  if (P.inCss !== undefined || P.vb !== undefined) {
    let els;
    if (P.vb !== undefined) els = Array.from(root.querySelectorAll('section.md-block')).filter((s) => s.textContent.trim() && s.getBoundingClientRect().height > 0);
    else els = Array.from(root.querySelectorAll(P.inCss)).filter((e) => !e.closest('[data-mdr-ui]') && e.textContent.trim() && e.getBoundingClientRect().height > 0);
    if (!els.length) return { err: 'no element ' + (P.inCss || 'vb') };
    const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.top >= box.top + 4 && r.top <= box.bottom - 30; });
    const list = vis.length ? vis : els;
    const e = list[Math.min(P.vb !== undefined ? P.vb : (P.nth || 0), list.length - 1)];
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: ok });
    let left = P.o || 0, last = null, hit = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.trim()) continue;
      last = n;
      if (left < n.data.length) { hit = [n, left]; break; }
      left -= n.data.length;
    }
    if (!hit && last) hit = [last, Math.max(0, last.data.length - 1)];
    if (!hit) return { err: 'no text in ' + (P.inCss || 'vb') };
    let q = textPoint(hit[0], hit[1], P.side);
    const moved = bring(q.r);
    if (moved) q = textPoint(hit[0], hit[1], P.side);
    return { x: q.x, y: q.y, moved };
  }
  if (P.css !== undefined) {
    const all = Array.from(root.querySelectorAll(P.css)).filter((e) => !e.closest('[data-mdr-ui]') && e.getBoundingClientRect().height > 0);
    if (!all.length) return { err: 'no element ' + P.css };
    const vis = all.filter((e) => inView(e.getBoundingClientRect()));
    const list = vis.length ? vis : all;
    const e = list[Math.min(P.nth || 0, list.length - 1)];
    const moved = bring(e.getBoundingClientRect());
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width * (P.fx ?? 0.5), y: r.top + r.height * (P.fy ?? 0.5), moved };
  }
  if (P.beside !== undefined) {
    const all = Array.from(root.querySelectorAll(P.beside || 'section.md-block')).filter((e) => e.getBoundingClientRect().height > 8);
    const vis = all.filter((e) => inView(e.getBoundingClientRect()));
    const list = vis.length ? vis : all;
    if (!list.length) return { err: 'no block for beside' };
    const e = list[Math.min(P.nth || 0, list.length - 1)];
    const moved = bring(e.getBoundingClientRect());
    const r = e.getBoundingClientRect();
    return { x: Math.min(box.right - 24, r.right + Math.max(8, (box.right - r.right) / 2)), y: r.top + Math.min(r.height / 2, 10), moved };
  }
  if (P.below) {
    const before = root.scrollTop;
    root.scrollTop = root.scrollHeight;
    const ss = root.querySelectorAll('section.md-block');
    const last = ss[ss.length - 1];
    const lb = last ? last.getBoundingClientRect().bottom : box.top;
    return { x: box.left + box.width / 2, y: Math.min(box.bottom - 12, Math.max(lb + 12, box.top + 20)), moved: root.scrollTop !== before };
  }
  if (P.ed !== undefined) {
    const c = document.querySelector('.cm-content');
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(P.ed);
      if (i < 0) continue;
      const q = textPoint(n, i + (P.k || 0), P.side);
      return { x: q.x, y: q.y, moved: false };
    }
    return { err: 'not in editor: ' + P.ed };
  }
  if (P.edLine !== undefined) {
    // by document position: the P.edLine-th logical line after the first one whose top is inside the scroller
    const view = window.__mdr.app.editor.view;
    const sc = document.querySelector('.cm-scroller');
    const eb = sc.getBoundingClientRect();
    if (eb.height === 0) return { err: 'no editor line' };
    const pad = view.documentPadding ? view.documentPadding.top : 0;
    let blk = view.lineBlockAtHeight(Math.max(0, sc.scrollTop - pad));
    if (blk.top < sc.scrollTop - pad - 1 && blk.to < view.state.doc.length) blk = view.lineBlockAt(blk.to + 1);
    const first = view.state.doc.lineAt(blk.from).number;
    const n = Math.min(view.state.doc.lines, first + P.edLine);
    const line = view.state.doc.line(n);
    const c = view.coordsAtPos(P.endOfLine ? line.to : Math.min(line.to, line.from), P.endOfLine ? -1 : 1);
    if (!c || c.bottom > eb.bottom - 2) return { err: 'no editor line' };
    return { x: P.endOfLine ? c.left - 1 : c.left + 1, y: (c.top + c.bottom) / 2, moved: false };
  }
  if (P.toc !== undefined) {
    const items = Array.from(document.querySelectorAll('.mdr-toc a, .mdr-toc [role="treeitem"], .mdr-toc li > *:first-child')).filter((e) => e.getBoundingClientRect().height > 0);
    const e = items[Math.min(P.toc, items.length - 1)];
    if (!e) return { err: 'no toc entry' };
    const r = e.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2, moved: false };
  }
  if (P.pane !== undefined) {
    const el = P.pane === 'ed' ? document.querySelector('.cm-scroller') : root;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * P.fx, y: r.top + r.height * P.fy, moved: false };
  }
  return { x: P.x, y: P.y, moved: false };
}

export async function point(S, P) {
  let q = await S.page.evaluate(RESOLVE, P);
  if (q.err) throw new Error(q.err);
  if (q.moved) {
    await settle(S, 700);
    q = await S.page.evaluate(RESOLVE, { ...P, align: true });
    if (q.err) throw new Error(q.err);
    if (q.moved) { await settle(S, 700); q = await S.page.evaluate(RESOLVE, P); if (q.err) throw new Error(q.err); }
  }
  const r = { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
  S.pts.push(r);
  return r;
}

// ---------------------------------------------------------------- gestures
async function withMods(page, mods, fn) {
  for (const m of mods || []) await page.keyboard.down(m);
  try { await fn(); } finally { for (const m of (mods || []).slice().reverse()) await page.keyboard.up(m); }
}

async function dispatchAt(S, P, kind, payload) {
  const q = P ? await point(S, P) : null;
  return S.page.evaluate(({ q, kind, payload }) => {
    const t = q ? document.elementFromPoint(q.x, q.y) : (document.activeElement || document.body);
    if (!t) return 'no target';
    if (kind === 'paste') {
      const dt = new DataTransfer(); dt.setData('text/plain', payload);
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
      t.dispatchEvent(e);
      return e.defaultPrevented ? 'prevented' : 'not prevented';
    }
    if (kind === 'drop') {
      const dt = new DataTransfer(); dt.setData('text/plain', payload);
      const o = { dataTransfer: dt, bubbles: true, cancelable: true, composed: true, clientX: q.x, clientY: q.y };
      const r = [];
      for (const ty of ['dragenter', 'dragover', 'drop']) { const e = new DragEvent(ty, o); t.dispatchEvent(e); r.push(ty + (e.defaultPrevented ? '!' : '')); }
      return r.join(' ');
    }
    if (kind === 'ime') {
      const o = { bubbles: true, cancelable: true, composed: true };
      const r = [];
      let e = new CompositionEvent('compositionstart', { ...o, data: '' }); t.dispatchEvent(e); r.push('cs' + (e.defaultPrevented ? '!' : ''));
      e = new InputEvent('beforeinput', { ...o, inputType: 'insertCompositionText', data: payload, isComposing: true }); t.dispatchEvent(e); r.push('bi' + (e.defaultPrevented ? '!' : ''));
      e = new CompositionEvent('compositionupdate', { ...o, data: payload }); t.dispatchEvent(e); r.push('cu' + (e.defaultPrevented ? '!' : ''));
      e = new CompositionEvent('compositionend', { ...o, data: payload }); t.dispatchEvent(e); r.push('ce' + (e.defaultPrevented ? '!' : ''));
      return t.tagName + '.' + (typeof t.className === 'string' ? t.className.split(' ')[0] : '') + ' ' + r.join(' ');
    }
    return 'unknown';
  }, { q, kind, payload });
}

/** Programmatic selection from point-descriptor A (a text needle / block offset) to B, by DOM ranges (no events). */
async function selectRange(S, A, B) {
  return S.page.evaluate(({ A, B }) => {
    const root = document.querySelector('.mdr-preview');
    const ok = (n) => (n.parentElement && n.parentElement.closest('[data-mdr-ui], .katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
    const find = (D) => {
      if (D === 'start') { const s = root.querySelector('section.md-block'); return [s, 0]; }
      if (D === 'end') { const ss = root.querySelectorAll('section.md-block'); const s = ss[ss.length - 1]; return [s, s.childNodes.length]; }
      if (D.css) { const e = root.querySelector(D.css); if (!e) return null; return D.after ? [e.parentNode, Array.prototype.indexOf.call(e.parentNode.childNodes, e) + 1] : [e.parentNode, Array.prototype.indexOf.call(e.parentNode.childNodes, e)]; }
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: ok });
      for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(D.t); if (i >= 0) return [n, i + (D.k || 0)]; }
      return null;
    };
    const a = find(A), b = find(B);
    if (!a || !b) return 'not found';
    const s = getSelection();
    s.removeAllRanges();
    s.setBaseAndExtent(a[0], a[1], b[0], b[1]);
    return s.toString().length;
  }, { A, B });
}

/**
 * Runs one step on one side. Steps:
 *  ['click', P, {count, mods, button, hold}]  ['drag', P1, P2, {via, steps, mods}]  ['hover', P]  ['wheel', P, dy]
 *  ['key', 'Meta+c', {after}]   ['type', text]   ['clip', text] (puts text/plain on the clipboard)
 *  ['ime', text]  ['pasteEvt', text, P?]  ['dropText', P, text]  ['select', A, B]  ['cmd', id]  ['mode', m]
 *  ['scrollPv', frac|{px}]  ['scrollEd', frac]  ['edit', {at: P, text, key}] (click into the editor, then type / press)
 *  ['wait', ms]  ['find', query]
 * Returns a short string of what the step itself reported (dispatch results), compared too.
 */
export async function step(S, st) {
  const [op, a, b, c] = st;
  const p = S.page;
  if (op === 'click') {
    const o = b || {};
    const q = await point(S, a);
    await p.mouse.move(q.x, q.y, { steps: 2 });
    await withMods(p, o.mods, async () => {
      for (let n = 1; n <= (o.count ?? 1); n++) {
        await p.mouse.down({ button: o.button || 'left', clickCount: n });
        if (o.hold) await sleep(o.hold);
        await p.mouse.up({ button: o.button || 'left', clickCount: n });
      }
    });
    await settle(S, o.after ?? 400);
  } else if (op === 'drag') {
    const o = c || {};
    const q1 = await point(S, a);
    const via = o.via ? await point(S, o.via) : null;
    const q2 = await point(S, b);
    const n = o.steps ?? 12;
    await p.mouse.move(q1.x, q1.y, { steps: 2 });
    await withMods(p, o.mods, async () => {
      for (let k = 1; k < (o.count ?? 1); k++) { await p.mouse.down({ clickCount: k }); await p.mouse.up({ clickCount: k }); }
      await p.mouse.down({ clickCount: o.count ?? 1 });
      const legs = via ? [[q1, via], [via, q2]] : [[q1, q2]];
      for (const [f, t] of legs) for (let i = 1; i <= n; i++) { await p.mouse.move(f.x + (t.x - f.x) * i / n, f.y + (t.y - f.y) * i / n); await sleep(o.gap ?? 25); }
      await sleep(80);
      await p.mouse.up({ clickCount: o.count ?? 1 });
    });
    await settle(S, o.after ?? 500);
  } else if (op === 'hover') {
    const q = await point(S, a); await p.mouse.move(q.x, q.y, { steps: 3 }); await settle(S, 200);
  } else if (op === 'wheel') {
    const q = await point(S, a); await p.mouse.move(q.x, q.y); await p.mouse.wheel(0, b); await settle(S, 500);
  } else if (op === 'key') {
    await p.keyboard.press(a); await settle(S, b?.after ?? 300);
  } else if (op === 'type') {
    await p.keyboard.type(a, { delay: 20 }); await settle(S, 300);
  } else if (op === 'clip') {
    await p.evaluate((t) => navigator.clipboard.writeText(t), a); await sleep(30);
  } else if (op === 'ime') {
    const r = await dispatchAt(S, null, 'ime', a); await settle(S, 300); return r;
  } else if (op === 'pasteEvt') {
    const r = await dispatchAt(S, b || null, 'paste', a); await settle(S, 300); return r;
  } else if (op === 'dropText') {
    const r = await dispatchAt(S, a, 'drop', b); await settle(S, 400); return r;
  } else if (op === 'select') {
    const r = await selectRange(S, a, b); await settle(S, 200); return String(r);
  } else if (op === 'cmd') {
    await p.evaluate((id) => window.__mdr.app.registry.run(id), a); await settle(S, 400);
  } else if (op === 'mode') {
    await p.evaluate((m) => window.__mdr.mode(m), a); S.mode = a; await settle(S, 500);
  } else if (op === 'scrollPv') {
    await p.evaluate((f) => { const r = document.querySelector('.mdr-preview'); r.scrollTop = typeof f === 'number' ? Math.round((r.scrollHeight - r.clientHeight) * f) : f.px; }, a); await settle(S, 700);
  } else if (op === 'scrollLine') {
    // content-based: the preview's own scrollToLine (a raw offset shows different blocks where heights are estimates)
    await p.evaluate((f) => { const n = window.__mdr.app.getText().split('\n').length; window.__mdr.app.preview.scrollToLine(Math.max(1, Math.round(n * f)), 0, 'instant'); }, a); await settle(S, 1000);
  } else if (op === 'scrollEd') {
    await p.evaluate((f) => { const s = document.querySelector('.cm-scroller'); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) * f); }, a); await settle(S, 700);
  } else if (op === 'edit') {
    const o = a || {};
    const q = await point(S, o.at || { edLine: 2, endOfLine: true });
    await p.mouse.click(q.x, q.y);
    await sleep(120);
    if (o.text) await p.keyboard.type(o.text, { delay: o.fast ? 0 : 20 });
    for (const k of o.keys || []) await p.keyboard.press(k);
    if (!o.fast) await settle(S, 400);   // fast: the next step follows at once (a click while the structure lags)
  } else if (op === 'find') {
    const q = await point(S, { edLine: 1 });
    await p.mouse.click(q.x, q.y);
    await p.keyboard.press('Meta+f'); await sleep(250);
    await p.keyboard.type(a, { delay: 15 }); await p.keyboard.press('Enter');
    await settle(S, 600);
  } else if (op === 'wait') {
    await sleep(a);
  } else throw new Error('unknown step ' + op);
  return '';
}

/** Applies `steps` to both sides in step; observes after each step. Returns {ok, at, diffs, obs}. */
export const transient = [];
export async function runBoth(P, steps, { ignore = [], clipSteps = null, stopAtFirst = true, ignoreAt = {}, tol = 1 } = {}) {
  const c0 = await obs(P.cand), b0 = await obs(P.base);
  let d = diff(c0, b0, { ignore });
  if (d.length) return { ok: false, at: -1, step: 'initial state', diffs: d, c: c0, b: b0 };
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const isClip = clipSteps ? clipSteps.includes(i) : (st[0] === 'key' && /Meta\+[cx]$/.test(st[1]));
    let rc, rb, ec, eb;
    [rc, rb] = await Promise.all([step(P.cand, st).catch((e) => { ec = e; return 'ERR ' + e.message; }), step(P.base, st).catch((e) => { eb = e; return 'ERR ' + e.message; })]);
    if (ec && eb && String(ec.message) === String(eb.message) && /^(not shown|no element|no block|empty block|no toc|not in editor|no editor|no text in)/.test(ec.message)) return { ok: true, skipped: ec.message, at: i };
    const [c, b] = await Promise.all([obs(P.cand, { clip: isClip }), obs(P.base, { clip: isClip })]);
    c.ret = rc; b.ret = rb;
    const ip = st[0] === 'key' && INTENDED_PREVENT.test(st[1]);
    d = diff(c, b, { ignore: ignore.concat(ignoreAt[i] || []), intendedPrevent: ip, tol });
    if (d.length && rc === rb) {
      // timer-driven fields (draft status, debounced scroll sync) can be read a few ms apart: look again once
      await sleep(900);
      const [c2, b2] = await Promise.all([obs(P.cand, { clip: isClip }), obs(P.base, { clip: isClip })]);
      const d2 = diff(c2, b2, { ignore: ignore.concat(ignoreAt[i] || []), intendedPrevent: ip, tol });
      if (!d2.length) { transient.push({ at: i, step: st, first: fmtDiff(d) }); d = []; } else d = d2;
    }
    if (rc !== rb) d.unshift({ field: 'stepResult', cand: rc, base: rb, detail: '' });
    if (d.length && stopAtFirst) return { ok: false, at: i, step: st, diffs: d, c, b };
  }
  return { ok: true };
}

export function logLine(file, line) { appendFileSync(file, line + '\n'); }
export function writeJson(file, v) { writeFileSync(file, JSON.stringify(v, null, 1)); }
