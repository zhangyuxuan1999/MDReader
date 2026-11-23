// bench/verify/v5-offc-probes.mjs — audit-off-code (0.2.0 stage 2e): probes of what the in-preview editing code
// does with the switch 预览可编辑 OFF, aimed at the listeners, guards and leftovers found by reading
// src/preview/inlineEdit.ts, createPreview.ts, interactions.ts, src/app/previewEdit.ts, App.ts and shortcuts.ts.
// Each case performs the same gesture on the candidate with the switch off (MDR_PORT, localStorage
// mdr.previewEdit = "0" before the app starts; asserted: toolbar button not pressed, preview not editable) and on
// the 0.1.1 baseline (MDR_BASE_PORT, ?perf=1), and prints both observations and the keys that differ.
//   MDR_PORT=5511 MDR_BASE_PORT=5512 node bench/verify/v5-offc-probes.mjs <case|prefix ...|all|list>
//   MDR_VERBOSE=1 prints both full observations.
// Cases named after:* first turn the switch ON on the candidate, use a session, then turn it OFF by the command
// (⌘⇧E) or the toolbar button, and compare what is left with the baseline showing the same source.
// Exit code: 0 all SAME (or differences the case names as intended), 1 a difference, 2 an error.
// Writes nothing into the tree; needs both servers listening.
import { readFileSync } from 'node:fs';
import {
  PORT, BASE_PORT, sleep, hash, DOC_ALL, open, loadDoc, pointOf, pointOfSel, must, clickAt, dragFromTo, obs, clip,
  clipSentinel, restBlocks, diffKeys, getPath, switchState, normHtml,
} from './v5-offc-lib.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const TIMEOUT = Number(process.env.MDR_TIMEOUT || 110_000);
const VERBOSE = !!process.env.MDR_VERBOSE;
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, TIMEOUT);

/** The fields of obs() a key / click probe compares. */
const VIEW = ['src', 'sel', 'aOff', 'fOff', 'selIn', 'active', 'pTop', 'eTop', 'mode', 'toast', 'opened', 'popups', 'checks', 'ce', 'editing', 'cap', 'hint', 'zw'];
const pick = (o, keys = VIEW) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const srcDelta = (a, b) => {
  if (a === b) return 'unchanged';
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return `@${i}: ${JSON.stringify(a.slice(i, a.length - j))} -> ${JSON.stringify(b.slice(i, b.length - j))}`;
};

async function typeInEditor(B, needle, text) {
  const p = await must(await pointOf(B.page, needle, 0, 'left', '.cm-content'), needle + ' in editor');
  await clickAt(B.page, p);
  await sleep(120);
  await B.page.keyboard.press('End');
  await B.page.keyboard.type(text);
  await B.idle(200);
}

/** Load DOC_ALL, type " QQ" in the editor (something for ⌘Z), click (n clicks) on "Clickhere" in the preview, then
 *  press `key` and report what changed. */
async function keyProbe(B, key, { clicks = 1, needle = 'Clickhere', k = 3, edit = true } = {}) {
  await loadDoc(B, DOC_ALL);
  if (edit) await typeInEditor(B, 'Clickhere', ' QQ');
  const p = await must(await pointOf(B.page, needle, k), needle);
  await clickAt(B.page, p, clicks);
  await sleep(700);                      // past the navigation anchor and any click timers
  const before = await obs(B);
  await clipSentinel(B);
  await B.page.keyboard.press(key);
  await sleep(700);
  await B.idle(100);
  const after = await obs(B);
  const cb = await clip(B);
  return {
    srcChange: srcDelta(before.src, after.src),
    selBefore: before.sel, ...pick(after, ['sel', 'aOff', 'fOff', 'selIn', 'active', 'mode', 'toast', 'opened', 'popups', 'ce', 'editing', 'cap', 'hint', 'zw']),
    pScroll: after.pTop - before.pTop, eScroll: after.eTop - before.eTop,
    clipPlain: cb['text/plain'] ?? null, clipHtml: cb['text/html'] ? `${cb['text/html'].length}:${hash(cb['text/html'])}` : null,
  };
}

const KEYS = ['a', 'Enter', 'Backspace', 'Delete', 'Tab', 'Shift+Tab', 'Space', 'Shift+Space', 'Home', 'End', 'PageDown', 'PageUp',
  'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowRight', 'Escape', 'Meta+a', 'Meta+c', 'Meta+x', 'Meta+v', 'Meta+z', 'Meta+Shift+z',
  'Meta+b', 'Meta+i', 'Meta+e', 'Meta+k', 'Meta+ArrowDown', 'Meta+ArrowUp', 'Alt+ArrowDown', 'Control+e', 'Control+a', 'Meta+Backspace'];
const SEL_KEYS = ['a', 'Backspace', 'Delete', 'Enter', 'Space', 'Escape', 'Meta+c', 'Meta+x', 'Meta+v', 'Meta+z', 'Meta+b', 'Meta+e', 'Meta+k', 'Home', 'End'];

const CASES = {};
for (const key of KEYS) CASES[`key:${key}`] = (B) => keyProbe(B, key);
for (const key of SEL_KEYS) CASES[`dblkey:${key}`] = (B) => keyProbe(B, key, { clicks: 2 });
// Meta+z without an editor change (nothing to undo) and Meta+z with the focus nowhere after Esc
CASES['key:Meta+z-noedit'] = (B) => keyProbe(B, 'Meta+z', { edit: false });
CASES['key:Meta+z-preview-mode'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  await typeInEditor(B, 'Clickhere', ' QQ');
  await B.page.evaluate(() => window.__mdr.mode('preview'));
  await sleep(500);
  const p = await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere');
  await clickAt(B.page, p);
  await sleep(600);
  const before = await obs(B);
  await B.page.keyboard.press('Meta+z');
  await sleep(600); await B.idle();
  const after = await obs(B);
  await B.page.evaluate(() => window.__mdr.mode('split'));
  return { srcChange: srcDelta(before.src, after.src), ...pick(after, ['mode', 'active', 'toast']), pScroll: after.pTop - before.pTop };
};

// ---- copy / cut / drag with a selection in the preview, in the editor, outside both
async function selectPreviewDrag(B) {
  const a = await must(await pointOf(B.page, 'First paragraph', 0), 'First');
  const b = await must(await pointOf(B.page, 'only for collapsed', 5, 'right'), 'only for collapsed');
  await dragFromTo(B.page, a, b);
  await sleep(400);
}
async function selectionThen(B, how, key) {
  await loadDoc(B, DOC_ALL);
  if (how === 'preview-drag') await selectPreviewDrag(B);
  else if (how === 'preview-triple-li') { await clickAt(B.page, await must(await pointOf(B.page, 'nested three', 2), 'nested'), 3); await sleep(400); }
  else if (how === 'preview-dbl-word') { await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 2), 'Clickhere'), 2); await sleep(400); }
  else if (how === 'preview-all') { await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 2), 'Clickhere')); await sleep(300); await B.page.keyboard.press('Meta+a'); await sleep(300); }
  else if (how === 'preview-math') {
    const a = await must(await pointOf(B.page, 'inline math', 0), 'im');
    const b = await must(await pointOf(B.page, 'and a footnote', 3), 'fn');
    await dragFromTo(B.page, a, b); await sleep(400);
  } else if (how === 'preview-table-code') {
    const a = await must(await pointOf(B.page, 'fenced', 0), 'code');
    const b = await must(await pointOf(B.page, 'cell 2', 5, 'right'), 'cell');
    await dragFromTo(B.page, a, b); await sleep(400);
  } else if (how === 'editor-line') { await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 2, 'left', '.cm-content'), 'cm'), 3); await sleep(400); }
  else if (how === 'outside') {
    await B.page.evaluate(() => {
      const st = document.querySelector('[class*="statusbar"]');
      const r = document.createRange(); r.selectNodeContents(st);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await sleep(200);
  } else throw new Error('how ' + how);
  const before = await obs(B);
  await clipSentinel(B);
  await B.page.keyboard.press(key);
  await sleep(500); await B.idle();
  const after = await obs(B);
  const cb = await clip(B);
  const html = cb['text/html'] ?? null;
  if (process.env.MDR_DUMP && html !== null) { const { writeFileSync } = await import('node:fs'); writeFileSync(`${process.env.MDR_DUMP}/${B.name}-${how}-${key}.html`, html); }
  // Chrome inlines each copied element's computed style in the order the matched rules declare it: the dev server's
  // unminified stylesheets and the production bundle declare the same properties in another order. normHtml sorts the
  // declarations inside every style attribute, so it compares content, not declaration order.
  // The page's own URL (port, ?perf=1) and what the minifier rewrote in the baseline's stylesheets (rgba(0, 0, 0, 0) for
  // transparent, 0.12s for 120ms, background: 0px 0px for background: transparent) are normalized too.
  const normHtml = html === null ? null : html.replace(/ data-id="\d+"/g, '').replace(/http:\/\/localhost:\d+\/(\?mode=split(&amp;perf=1)?)?/g, 'ORIGIN/')
    .replace(/rgba\(0, 0, 0, 0\)/g, 'transparent').replace(/\b120ms\b/g, '0.12s').replace(/\b160ms\b/g, '0.16s').replace(/background: 0px 0px/g, 'background: transparent')
    .replace(/style="([^"]*)"/g, (m, v) => `style="${v.split(/;\s*/).filter(Boolean).sort().join('; ')}"`);
  return {
    selBefore: `${before.selLen}:${hash(before.sel)}`, srcChange: srcDelta(before.src, after.src), selAfter: `${after.selLen}:${hash(after.sel)}`,
    active: after.active, plain: cb['text/plain'] ?? null,
    htmlNorm: normHtml === null ? null : `${normHtml.length}:${hash(normHtml)}`,
    pScroll: after.pTop - before.pTop,
  };
}
for (const how of ['preview-drag', 'preview-triple-li', 'preview-dbl-word', 'preview-all', 'preview-math', 'preview-table-code', 'editor-line', 'outside']) {
  CASES[`copy:${how}`] = (B) => selectionThen(B, how, 'Meta+c');
  CASES[`cut:${how}`] = (B) => selectionThen(B, how, 'Meta+x');
}

/** Drag-and-drop: the selected text dragged from one pane to the other; an image dragged into the editor. */
async function dragProbe(B, what) {
  await loadDoc(B, DOC_ALL);
  let from;
  if (what === 'preview-word-to-editor') {
    from = await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere');
    await clickAt(B.page, from, 2); await sleep(400);
  } else if (what === 'editor-word-to-preview') {
    from = await must(await pointOf(B.page, 'Clickhere', 3, 'left', '.cm-content'), 'cm');
    await clickAt(B.page, from, 2); await sleep(400);
  } else if (what === 'image-to-editor' || what === 'image-to-preview') {
    from = await must(await pointOfSel(B.page, 'img'), 'img');
  } else throw new Error(what);
  const before = await obs(B);
  const to = what.endsWith('to-editor')
    ? await must(await pointOf(B.page, 'Heading Alpha', 5, 'left', '.cm-content'), 'heading in editor')
    : await must(await pointOf(B.page, 'Second last paragraph', 4), 'second last');
  await B.page.evaluate(() => { window.__offcEv.length = 0; });
  await sleep(700);                                  // past the double-click interval: the next press is a new click
  await B.page.mouse.move(from.x, from.y);
  await B.page.mouse.down();
  for (let i = 1; i <= 6; i++) { await B.page.mouse.move(from.x + i, from.y + i); await sleep(30); }   // past the drag threshold
  await dragFromTo(B.page, { x: from.x + 6, y: from.y + 6 }, to, { steps: 16, gap: 25, pressed: true });
  await sleep(600); await B.idle();
  const after = await obs(B);
  const events = await B.page.evaluate(() => window.__offcEv.map((e) => `${e.type}@${e.where}[${e.types}]${e.prevented ? ' prevented' : ''}`).join(' '));
  return { srcChange: srcDelta(before.src, after.src), events, ...pick(after, ['sel', 'selIn', 'active', 'ce', 'editing']), pScroll: after.pTop - before.pTop };
}
for (const w of ['preview-word-to-editor', 'editor-word-to-preview', 'image-to-editor', 'image-to-preview']) CASES[`drag:${w}`] = (B) => dragProbe(B, w);
/** Headless Chromium starts no drag of selected TEXT from mouse input (an image drag it does start): a dragstart is
 *  dispatched on the selection instead, with the data the browser would put in, and what the page's listeners left
 *  in it (and whether one cancelled it) is reported. */
for (const where of ['preview', 'editor', 'outside']) {
  CASES[`dragstart:${where}`] = async (B) => {
    await loadDoc(B, DOC_ALL);
    if (where === 'preview') { await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere'), 2); }
    else if (where === 'editor') { await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3, 'left', '.cm-content'), 'cm'), 2); }
    await sleep(400);
    return B.page.evaluate((where) => {
      const sel = getSelection();
      let target;
      if (where === 'outside') {
        const st = document.querySelector('[class*="statusbar"]');
        const r = document.createRange(); r.selectNodeContents(st); sel.removeAllRanges(); sel.addRange(r);
        target = st;
      } else target = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      const text = sel.toString();
      const dt = new DataTransfer();
      dt.setData('text/plain', text); dt.setData('text/html', `<span>${text}</span>`);
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt });
      target.dispatchEvent(ev);
      return { text, prevented: ev.defaultPrevented, plain: dt.getData('text/plain'), html: dt.getData('text/html'), selAfter: getSelection().toString() };
    }, where);
  };
}

// ---- presses and clicks on text, a link, a formula, an image
async function clickProbe(B, target, n, mods = []) {
  await loadDoc(B, DOC_ALL);
  let p;
  if (target === 'text') p = await pointOf(B.page, 'ordinary words', 3);
  else if (target === 'link') p = await pointOf(B.page, 'plain link', 3);
  else if (target === 'autolink') p = await pointOf(B.page, 'example.org', 2);
  else if (target === 'anchor') p = await pointOf(B.page, 'anchor link', 2);
  else if (target === 'relative') p = await pointOf(B.page, 'relative link', 2);
  else if (target === 'formula') p = await pointOfSel(B.page, '.katex', { n: 0 });
  else if (target === 'display-formula') p = await pointOfSel(B.page, '.katex-display');
  else if (target === 'image') p = await pointOfSel(B.page, 'img', { fx: 0.3 });
  else if (target === 'code') p = await pointOf(B.page, 'fenced', 3);
  else if (target === 'heading') p = await pointOf(B.page, 'Lists Beta', 2);
  else if (target === 'blank') p = await pointOfSel(B.page, '.mdr-preview__body', { fx: 0.98, fy: 0.002 });
  else throw new Error(target);
  await must(p, target);
  const before = await obs(B);
  await clickAt(B.page, p, n, { modifiers: mods });
  await sleep(700); await B.idle();
  const after = await obs(B);
  return { srcChange: srcDelta(before.src, after.src), ...pick(after, ['sel', 'aOff', 'fOff', 'selIn', 'active', 'mode', 'toast', 'opened', 'popups', 'ce', 'editing', 'zw', 'mathSrc']), pScroll: after.pTop - before.pTop, eScroll: after.eTop - before.eTop };
}
for (const t of ['text', 'link', 'autolink', 'anchor', 'relative', 'formula', 'display-formula', 'image', 'code', 'heading', 'blank']) {
  for (const n of [1, 2, 3]) CASES[`click${n}:${t}`] = (B) => clickProbe(B, t, n);
}
/** Where a click on the inline formula lands: the point, the element under it, the caret position the browser
 *  computes there, the formula's box, and the selection a double click makes (compared per build). */
CASES['diag:formula'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  const p = await must(await pointOfSel(B.page, '.katex', { n: 0 }), 'katex');
  const at = await B.page.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    const chain = []; for (let n = e; n && !n.classList?.contains('md-block'); n = n.parentElement) chain.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').join('.') : ''));
    const r = document.caretRangeFromPoint(x, y);
    const k = document.querySelector('.mdr-preview .katex');
    const kr = k.getBoundingClientRect();
    const mathml = k.querySelector('.katex-mathml');
    const ms = mathml ? getComputedStyle(mathml) : null;
    return {
      chain: chain.join(' < '), caret: r ? `${r.startContainer.nodeName}:${JSON.stringify((r.startContainer.data || '').slice(0, 20))}@${r.startOffset}` : null,
      box: [kr.left, kr.top, kr.width, kr.height].map((v) => Math.round(v * 100) / 100).join(','),
      mathml: ms ? `${ms.position}/${ms.clip}/${ms.width}/${ms.height}/${ms.overflow}/${ms.userSelect}` : null,
      parentP: k.closest('p') ? getComputedStyle(k.closest('p')).userSelect : null,
      katexUS: getComputedStyle(k).userSelect, katexWS: getComputedStyle(k).whiteSpace,
      fonts: Array.from(document.fonts).filter((f) => /KaTeX_(Main|Math)/.test(f.family)).map((f) => `${f.family.replace(/"/g, '')}/${f.style}/${f.weight}:${f.status}`).sort().join(' '),
      ffMath: getComputedStyle(k.querySelector('.mathnormal') ?? k).fontFamily,
    };
  }, p);
  await clickAt(B.page, p, 2);
  await sleep(500);
  const sel = await B.page.evaluate(() => { const s = getSelection(); return { text: s.toString(), a: s.anchorNode ? `${s.anchorNode.nodeName}:${JSON.stringify((s.anchorNode.data || '').slice(0, 12))}@${s.anchorOffset} in ${s.anchorNode.parentElement?.className}` : null, f: s.focusNode ? `${s.focusNode.nodeName}:${JSON.stringify((s.focusNode.data || '').slice(0, 12))}@${s.focusOffset} in ${s.focusNode.parentElement?.className}` : null }; });
  return { point: `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`, ...at, sel };
};
CASES['altclick:text'] =(B) => clickProbe(B, 'text', 1, ['Alt']);
CASES['metaclick:link'] = (B) => clickProbe(B, 'link', 1, ['Meta']);
CASES['shiftclick:text'] = (B) => clickProbe(B, 'text', 1, ['Shift']);

// ---- task checkboxes: at rest, at the box's very edge, and right after a change typed in the editor
async function taskProbe(B, { delay = null, edit = 'enter-above', which = 1, edge = null } = {}) {
  await loadDoc(B, DOC_ALL);
  const p = await must(await pointOfSel(B.page, 'input[type="checkbox"]', { n: which }), 'checkbox');
  if (edge) { p.x = p.rect.l + edge; p.y = p.rect.t + edge; }
  const src0 = await B.source();
  if (delay !== null) {
    // a change in the editor that moves the task lines (Enter at the end of the line above the list) or that
    // changes the task's own line
    const needle = edit === 'enter-above' ? 'ordered two' : 'task alpha';
    const q = await must(await pointOf(B.page, needle, 0, 'left', '.cm-content'), needle);
    await clickAt(B.page, q); await sleep(150);
    await B.page.keyboard.press('End');
    if (edit === 'enter-above') await B.page.keyboard.press('Enter');
    else await B.page.keyboard.type('Z');
    if (delay > 0) await sleep(delay);
    // the box may have moved by a line when the structure caught up: take its point again only for "at rest"
  }
  await B.page.mouse.click(p.x, p.y);
  await sleep(900); await B.idle(200);
  const after = await obs(B);
  return { srcChange: srcDelta(src0, after.src), checks: after.checks, active: after.active, toast: after.toast };
}
CASES['task:rest'] = (B) => taskProbe(B);
CASES['task:rest-first'] = (B) => taskProbe(B, { which: 0 });
CASES['task:edge-0.3'] = (B) => taskProbe(B, { edge: 0.3 });
CASES['task:edge-0.8'] = (B) => taskProbe(B, { edge: 0.8 });
for (const d of [0, 20, 60, 150, 400]) {
  CASES[`task:after-enter-${d}`] = (B) => taskProbe(B, { delay: d, edit: 'enter-above' });
  CASES[`task:after-type-${d}`] = (B) => taskProbe(B, { delay: d, edit: 'type-own' });
}
/** Three task checkboxes clicked one after the other `gap` ms apart (each click's toggle is a change of the source,
 *  so the next click arrives while the preview's structure may still be behind it). */
for (const gap of [0, 10, 30, 80, 200, 600]) {
  CASES[`task:rapid3-${gap}`] = async (B) => {
    await loadDoc(B, DOC_ALL);
    const src0 = await B.source();
    const pts = [];
    for (let n = 0; n < 3; n++) pts.push(await must(await pointOfSel(B.page, 'input[type="checkbox"]', { n }), 'box ' + n));
    for (const p of pts) { await B.page.mouse.click(p.x, p.y); if (gap) await sleep(gap); }
    await sleep(600);
    const early = (await obs(B)).toast;
    await sleep(900); await B.idle(300);
    await sleep(3000);                         // past any bounded wait (a give-up shows a toast)
    const after = await obs(B);
    const tasks = after.src.split('\n').filter((l) => /^- \[[ xX]\]/.test(l)).join(' | ');
    return { tasks, checks: after.checks, toastEarly: early, toast: after.toast, changed: srcDelta(src0, after.src) !== 'unchanged' };
  };
}
/** What the click on a checkbox's edge carries: the coordinates the press and the click report and the box's rect. */
CASES['diag:task-edge'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  const p = await must(await pointOfSel(B.page, 'input[type="checkbox"]', { n: 1 }), 'checkbox');
  await B.page.evaluate(() => {
    window.__offcClicks = [];
    for (const ty of ['pointerdown', 'mousedown', 'click']) document.addEventListener(ty, (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const r = e.target.getBoundingClientRect();
      window.__offcClicks.push(`${ty} x=${e.clientX} y=${e.clientY} rect=${r.left.toFixed(3)},${r.top.toFixed(3)},${r.right.toFixed(3)},${r.bottom.toFixed(3)}`);
    }, true);
  });
  const out = {};
  for (const [name, dx, dy] of [['left+0_3', 0.3, 8], ['top+0_3', 8, 0.3], ['right-0_3', -0.3, 8], ['bottom-0_3', 8, -0.3], ['centre', 8, 8]]) {
    await B.page.evaluate(() => { window.__offcClicks.length = 0; });
    const s0 = await B.source();
    const x = dx === 8 ? p.rect.l + p.rect.w / 2 : dx > 0 ? p.rect.l + dx : p.rect.l + p.rect.w + dx;
    const y = dy === 8 ? p.rect.t + p.rect.h / 2 : dy > 0 ? p.rect.t + dy : p.rect.t + p.rect.h + dy;
    await B.page.mouse.click(x, y);
    await sleep(600); await B.idle();
    const s1 = await B.source();
    out[name] = { toggled: s1 !== s0, events: (await B.page.evaluate(() => window.__offcClicks.slice())).join(' ; ') };
    if (s1 !== s0) { await B.page.mouse.click(p.rect.l + p.rect.w / 2, p.rect.t + p.rect.h / 2); await sleep(600); await B.idle(); }
  }
  return out;
};
/** Uniform clicks over a task checkbox (a grid of points inside its box, 1 px apart, from 0.25 px inside its edges):
 *  how many of them tick it. */
CASES['task:grid'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  const p = await must(await pointOfSel(B.page, 'input[type="checkbox"]', { n: 2 }), 'checkbox');
  const xs = [], ys = [];
  for (let d = 0.25; d < p.rect.w; d += 1) xs.push(p.rect.l + d);
  for (let d = 0.25; d < p.rect.h; d += 1) ys.push(p.rect.t + d);
  const state = () => B.page.evaluate(() => document.querySelectorAll('.mdr-preview input[type="checkbox"]')[2].checked);
  let ticked = 0, missed = 0;
  const missedAt = [];
  for (const y of ys) for (const x of [xs[0], xs[1], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]]) {
    const a = await state();
    await B.page.mouse.click(x, y);
    await sleep(120);
    const b = await state();
    if (a !== b) ticked++; else { missed++; if (missedAt.length < 6) missedAt.push(`${(x - p.rect.l).toFixed(2)},${(y - p.rect.t).toFixed(2)}`); }
  }
  for (const x of xs) {
    const a = await state();
    await B.page.mouse.click(x, ys[0]);
    await sleep(120);
    if (a !== await state()) ticked++; else { missed++; if (missedAt.length < 12) missedAt.push(`${(x - p.rect.l).toFixed(2)},${(ys[0] - p.rect.t).toFixed(2)}`); }
  }
  await sleep(800); await B.idle();
  return { clicks: ticked + missed, ticked, missed, rectFrac: `${(p.rect.l % 1).toFixed(3)},${(p.rect.t % 1).toFixed(3)}`, missedAt: missedAt.join(' ') };
};
CASES['task:keyboard-space'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  const src0 = await B.source();
  await B.page.evaluate(() => document.querySelectorAll('.mdr-preview input[type="checkbox"]')[1].focus());
  await B.page.keyboard.press('Space');
  await sleep(800); await B.idle();
  const after = await obs(B);
  return { srcChange: srcDelta(src0, after.src), checks: after.checks, active: after.active, pScroll: after.pTop };
};

// ---- IME composition, paste and drop with the focus in the preview
CASES['ime:preview'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere'));
  await sleep(600);
  const before = await obs(B);
  const cdp = await B.context.newCDPSession(B.page);
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await sleep(150);
  await cdp.send('Input.insertText', { text: '你' });
  await sleep(500); await B.idle();
  const after = await obs(B);
  await cdp.detach().catch(() => {});
  return { srcChange: srcDelta(before.src, after.src), ...pick(after, ['sel', 'active', 'ce', 'zw']) };
};
CASES['paste:preview'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere'));
  await sleep(600);
  const before = await obs(B);
  await B.page.evaluate(() => navigator.clipboard.writeText('PASTED TEXT'));
  await B.page.keyboard.press('Meta+v');
  await sleep(500); await B.idle();
  const after = await obs(B);
  return { srcChange: srcDelta(before.src, after.src), ...pick(after, ['sel', 'active', 'ce']) };
};
CASES['drop:text-event'] = async (B) => {
  // a synthetic drop of text/plain on a paragraph: is it cancelled by anyone, does the source change?
  await loadDoc(B, DOC_ALL);
  const r = await B.page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.mdr-preview p')).find((e) => e.textContent.includes('Clickhere'));
    const dt = new DataTransfer(); dt.setData('text/plain', 'DROPPED');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    p.dispatchEvent(over);
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    p.dispatchEvent(ev);
    return { overPrevented: over.defaultPrevented, dropPrevented: ev.defaultPrevented };
  });
  await sleep(300);
  return { ...r, src: hash(await B.source()) };
};

// ---- leftovers: the switch was ON, a session was used, the switch was turned OFF
/** A candidate page with the switch on (stored "1"), the baseline as usual. */
const ON_CASES = new Set();
const onCase = (name, fn) => { CASES[name] = fn; ON_CASES.add(name); };
async function toggleOff(B, how) {
  if (how === 'key') await B.page.keyboard.press('Meta+Shift+e');
  else if (how === 'button') {
    const p = await B.page.evaluate(() => { const b = document.querySelector('[data-cmd="view.togglePreviewEdit"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await B.page.mouse.click(p.x, p.y);
  } else if (how === 'palette-run') await B.page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit'));
  await sleep(50);
}
/** After a session on the candidate: what is left, then a battery of everyday gestures on both builds showing the
 *  same source (the baseline loads the candidate's source). */
async function ensureOn(C) {
  const st = await switchState(C);
  if (st.editable !== true) { await C.page.evaluate(() => window.__mdr.app.registry.run('view.togglePreviewEdit')); await sleep(200); }
  const now = await switchState(C);
  if (now.editable !== true || now.pressed !== 'true') throw new Error('could not turn the switch on: ' + JSON.stringify(now));
}
async function leftoverBattery(C, Bb, setup, { how = 'key', shortDoc = null, doc = DOC_ALL } = {}) {
  const cand = {}, base = {};
  await ensureOn(C);
  await loadDoc(C, doc);
  await setup(C);
  const srcBeforeOff = await C.source();
  await toggleOff(C, how);
  await sleep(600); await C.idle(200);
  cand.switch = await switchState(C);
  cand.left = pick(await obs(C), ['ce', 'editing', 'cap', 'hint', 'zw', 'status', 'spell', 'mdrO', 'mathSrc', 'ghost', 'stale', 'active']);
  cand.srcChangeAtOff = srcDelta(srcBeforeOff, await C.source());
  if (C.capSeen !== undefined) { cand.capTopDuringResume = C.capSeen; delete C.capSeen; }
  const text = shortDoc ?? await C.source();
  if (shortDoc) await loadDoc(C, shortDoc);
  else await C.page.evaluate(() => { const r = document.querySelector('.mdr-preview'); r.scrollTop = 0; getSelection().removeAllRanges(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  await sleep(300); await C.idle();
  await loadDoc(Bb, text);
  for (const [B, out] of [[C, cand], [Bb, base]]) {
    await B.page.evaluate(() => window.__mdr.app.preview.mountAll?.());
    await sleep(400); await B.idle(200);
    const blocks = await restBlocks(B);
    out.rest = { n: blocks.length, html: hash(JSON.stringify(blocks.map((b) => b.html))), attrs: blocks.map((b) => b.attrs).filter(Boolean).join('|'), cls: [...new Set(blocks.map((b) => b.cls))].join('|') };
    out.restBlocks = blocks;
    const o = await obs(B);
    out.pMax = o.pMax;
    // End key with the focus in the preview: how far it scrolls
    const anyText = shortDoc ? await pointOfSel(B.page, 'p') : await pointOf(B.page, 'ordinary words', 3);
    if (anyText) {
      await clickAt(B.page, anyText); await sleep(500);
      const b0 = await obs(B);
      await B.page.keyboard.press('Space'); await sleep(600);
      const b1 = await obs(B);
      await B.page.keyboard.press('End'); await sleep(700);
      const b2 = await obs(B);
      out.keys = { space: b1.pTop - b0.pTop, endTop: b2.pTop, srcSame: b2.src === b0.src, ce: b2.ce, active: b2.active };
    }
    // copy of a drag selection across the top blocks
    if (!shortDoc) {
      await B.page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
      await sleep(300);
      await clipSentinel(B);
      await selectPreviewDrag(B);
      await B.page.keyboard.press('Meta+c'); await sleep(300);
      const cb = await clip(B);
      const nh = normHtml(cb['text/html'] ?? null);
      out.copy = { plain: cb['text/plain'] ?? null, htmlNorm: nh === null ? null : `${nh.length}:${hash(nh)}`, htmlAttrs: cb['text/html'] ? [...new Set((cb['text/html'].match(/\s(spellcheck|contenteditable|data-mdr-[a-z]+)=/g) || []).map((s) => s.trim()))].join(',') : null };
      // a task checkbox click
      await B.page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; getSelection().removeAllRanges(); });
      await sleep(200);
      const s0 = await B.source();
      const box = await pointOfSel(B.page, 'input[type="checkbox"]', { n: 1 });
      if (box) { await B.page.mouse.click(box.x, box.y); await sleep(800); await B.idle(); }
      out.task = srcDelta(s0, await B.source());
    }
  }
  // per-block html differences
  const diffs = [];
  for (let i = 0; i < Math.max(cand.restBlocks.length, base.restBlocks.length); i++) {
    const a = cand.restBlocks[i], b = base.restBlocks[i];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ i, cand: a ? { attrs: a.attrs, cls: a.cls, html: a.html.slice(0, 200) } : null, base: b ? { attrs: b.attrs, cls: b.cls, html: b.html.slice(0, 200) } : null });
  }
  delete cand.restBlocks; delete base.restBlocks;
  cand.blockDiffs = diffs.slice(0, 4); base.blockDiffs = diffs.length ? `${diffs.length} block(s) differ` : [];
  return { cand, base };
}
onCase('after:typed', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
  await B.page.keyboard.type('XYZ'); await sleep(400);
  await clickAt(B.page, await must(await pointOf(B.page, 'Second last', 3), 'second last')); await sleep(500);
  await B.page.keyboard.type('W'); await sleep(400);
}));
onCase('after:typed-button', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
  await B.page.keyboard.type('XYZ');
}, { how: 'button' }));
onCase('after:mid-typing-nowait', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
  await B.page.keyboard.type('MIDTYPE');                 // no wait: the frame-coalesced write is still pending
}));
onCase('after:emptied-block', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOf(B.page, 'Second last', 3), 'second last')); await sleep(500);
  await B.page.keyboard.press('Meta+a'); await sleep(150);
  await B.page.keyboard.press('Backspace'); await sleep(500);
}));
onCase('after:formula-open', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOfSel(B.page, '.katex', { n: 0 }), 'katex')); await sleep(600);
}));
onCase('after:formula-start-spacer', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  // a paragraph that starts with a formula gets a zero-width spacer in a session (U21)
  await clickAt(B.page, await must(await pointOf(B.page, 'starts this paragraph', 3), 'starts')); await sleep(400);
  await B.page.keyboard.type('S'); await sleep(300);
}, { doc: '$x+y$ starts this paragraph with a formula.\n\n' + DOC_ALL }));
onCase('after:waiting-click', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
  await B.page.keyboard.type('Q');
  await clickAt(B.page, await must(await pointOf(B.page, 'Second last', 3), 'second last'));   // waits for the write
}));
onCase('after:split-resume-shortdoc', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  // Enter in a paragraph far down: the write splits the block and a resume holds the focus in the capture element
  await B.page.evaluate(() => window.__mdr.app.preview.mountAll?.()); await sleep(800); await B.idle(200);
  await clickAt(B.page, await must(await pointOf(B.page, 'Filler paragraph number 50 ', 30), 'filler 50')); await sleep(800);
  await B.page.keyboard.press('Enter'); await sleep(900);
  B.capSeen = await B.page.evaluate(() => { const c = document.querySelector('.mdr-preview .mdr-preview__edit-capture'); return c ? c.style.top : null; });
  await B.page.keyboard.press('Escape'); await sleep(300);
}, { shortDoc: readFileSync(`${ROOT}test-data/small.md`, 'utf8').slice(0, 600) }));
onCase('after:ime-open', (C, Bb) => leftoverBattery(C, Bb, async (B) => {
  await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
  const cdp = await B.context.newCDPSession(B.page);
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  await sleep(200);
  await cdp.detach().catch(() => {});
}, { how: 'button' }));
/** The switch turned off by the command in the middle of a session: the text typed is in the source. */
onCase('off-mid:typed-key', async (C, Bb) => {
  await ensureOn(C);
  await loadDoc(C, DOC_ALL);
  await clickAt(C.page, await must(await pointOf(C.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
  const sess = await obs(C);
  await C.page.keyboard.type('TYPED');
  await C.page.keyboard.press('Meta+Shift+e');
  await sleep(500); await C.idle();
  const o = await obs(C);
  return { cand: { sessionStarted: sess.editing, inSource: o.src.includes('ClickhereTYPED') || o.src.includes('ClicTYPED') || /TYPED/.test(o.src), ce: o.ce, editing: o.editing, hint: o.hint, status: o.status, active: o.active, switch: await switchState(C) }, base: { inSource: true, note: 'baseline has no switch' } };
});

/** The switch turned off by ⌘⇧E right after typing in a session, then at once: Space (does the preview scroll as after a
 *  click in 0.1.1?), and a task checkbox click `d` ms after turning off (the write of the session's end is still on its
 *  way: does the click tick?). The baseline: a click at the same place, Space; a checkbox click at rest. */
onCase('off-mid:space-after', async (C, Bb) => {
  const run = async (B, cand) => {
    if (cand) await ensureOn(B);
    await loadDoc(B, DOC_ALL);
    await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
    if (cand) { await B.page.keyboard.type('X'); await B.page.keyboard.press('Meta+Shift+e'); await sleep(400); }
    const o0 = await obs(B);
    await B.page.keyboard.press('Space'); await sleep(700);
    const o1 = await obs(B);
    await B.page.keyboard.press('ArrowDown'); await sleep(500);
    const o2 = await obs(B);
    return { space: o1.pTop - o0.pTop, down: o2.pTop - o1.pTop, active: o2.active, srcSameAfterKeys: o2.src === o0.src, ce: o2.ce };
  };
  return { cand: await run(C, true), base: await run(Bb, false) };
});
for (const d of [0, 40, 120, 400]) {
  onCase(`off-mid:task-${d}`, async (C, Bb) => {
    const run = async (B, cand) => {
      if (cand) await ensureOn(B);
      await loadDoc(B, DOC_ALL);
      if (cand) {
        await clickAt(B.page, await must(await pointOf(B.page, 'Clickhere', 3), 'Clickhere')); await sleep(500);
        await B.page.keyboard.type('X');
      }
      const box = await must(await pointOfSel(B.page, 'input[type="checkbox"]', { n: 0 }), 'box');
      const s0 = await B.source();
      if (cand) await B.page.keyboard.press('Meta+Shift+e');
      if (d) await sleep(d);
      await B.page.mouse.click(box.x, box.y);
      await sleep(1200); await B.idle(200);
      const s1 = await B.source();
      const t0 = s0.split('\n').find((l) => l.includes('task alpha')), t1 = s1.split('\n').find((l) => l.includes('task alpha'));
      return { task: `${t0} -> ${t1}`, checks: (await obs(B)).checks, toast: (await obs(B)).toast };
    };
    return { cand: await run(C, true), base: await run(Bb, false) };
  });
}

/** A document's own raw HTML with contenteditable / draggable / tabindex: what survives the sanitizer, and what ⌘B and
 *  typing do with the focus inside it (shortcuts.ts now treats a contenteditable as an element that handles its own
 *  keys). */
CASES['raw:contenteditable'] = async (B) => {
  await loadDoc(B, 'Intro paragraph.\n\n<div contenteditable="true" class="ce-raw">editable raw text</div>\n\n<p draggable="true" tabindex="0">drag raw</p>\n\nTail.\n');
  const attrs = await B.page.evaluate(() => {
    const r = document.querySelector('.mdr-preview');
    return { ce: r.querySelectorAll('[contenteditable]').length, drag: r.querySelectorAll('[draggable]').length, tab: r.querySelectorAll('[tabindex]').length };
  });
  const p = await pointOf(B.page, 'editable raw', 3);
  let keys = null;
  if (p) {
    await clickAt(B.page, p); await sleep(500);
    const o0 = await obs(B);
    await B.page.keyboard.type('T'); await sleep(200);
    await B.page.keyboard.press('Meta+b'); await sleep(500); await B.idle();
    const o1 = await obs(B);
    keys = { srcChange: srcDelta(o0.src, o1.src), active: o1.active, mode: o1.mode, shown: await B.page.evaluate(() => document.querySelector('.mdr-preview').textContent.includes('editTable') || document.querySelector('.mdr-preview').textContent.includes('ediTtable')) };
  }
  return { attrs, keys };
};

// ---- the hint bar, capture element, toolbar at rest; the stylesheet rules and the rest DOM are in v5-offc-rest.mjs
CASES['ui:rest'] = async (B) => {
  await loadDoc(B, DOC_ALL);
  return B.page.evaluate(() => {
    const root = document.querySelector('.mdr-preview');
    const pane = root.parentElement;
    const tb = document.querySelector('[class*="toolbar"]');
    return {
      paneChildren: Array.from(pane.children).map((e) => e.className.split(' ')[0] + (e.hidden ? '[hidden]' : '')).join(','),
      rootChildren: Array.from(root.children).map((e) => e.tagName.toLowerCase() + '.' + e.className.split(' ')[0]).join(','),
      toolbarButtons: tb ? tb.querySelectorAll('button').length : null,
      toolbarScroll: tb ? `${tb.scrollWidth}/${tb.clientWidth}` : null,
    };
  });
};

/** The toolbar at a window width: which buttons are fully visible (the new switch button is the intended
 *  difference; every other button must stay reachable as in 0.1.1). */
for (const w of [1400, 1000, 800, 640, 500, 375]) {
  CASES[`ui:toolbar-${w}`] = async (B) => {
    await B.page.setViewportSize({ width: w, height: 800 });
    await sleep(400);
    const r = await B.page.evaluate(() => {
      const tb = document.querySelector('.mdr-toolbar') ?? document.querySelector('[class*="toolbar"]');
      const box = tb.getBoundingClientRect();
      const all = Array.from(tb.querySelectorAll('button'));
      const vis = (b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= box.left - 0.5 && r.right <= Math.min(box.right, innerWidth) + 0.5; };
      return {
        hidden: all.filter((b) => b.dataset.cmd !== 'view.togglePreviewEdit' && !vis(b)).map((b) => b.dataset.cmd ?? b.className.split(' ')[0]).join(','),
        visibleCount: all.filter((b) => b.dataset.cmd !== 'view.togglePreviewEdit' && vis(b)).length,
        pageScrollX: document.documentElement.scrollWidth > innerWidth,
        height: Math.round(box.height),
        previewTop: Math.round(document.querySelector('.mdr-preview').getBoundingClientRect().top),
      };
    });
    await B.page.setViewportSize({ width: 1400, height: 900 });
    await sleep(300);
    return r;
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'list' || args.length === 0) { console.log(Object.keys(CASES).join('\n')); return 0; }
  const names = Object.keys(CASES).filter((n) => args.includes('all') || args.some((a) => n === a || (a.endsWith(':') && n.startsWith(a)) || (a.endsWith('*') && n.startsWith(a.slice(0, -1)))));
  if (names.length === 0) { console.log('no case matches'); return 2; }
  const needOn = names.some((n) => ON_CASES.has(n));
  const needOff = names.some((n) => !ON_CASES.has(n));
  const C = needOff ? await open(PORT) : null;
  const Con = needOn ? await open(PORT, { pref: '1' }) : null;
  const Bb = await open(BASE_PORT, { base: true });
  let bad = 0;
  try {
    for (const n of names) {
      let r;
      try {
        if (ON_CASES.has(n)) r = await CASES[n](Con, Bb);
        else { await sleep(50); r = { cand: await CASES[n](C), base: await CASES[n](Bb) }; }
      } catch (e) {
        console.log(`CASE ${n}  ERROR  ${String(e && e.message ? e.message : e).split('\n')[0]}`);
        bad = Math.max(bad, 1);
        continue;
      }
      const keys = diffKeys(r.cand, r.base);
      console.log(`CASE ${n}  ${keys.length ? 'DIFF ' + keys.join(',') : 'SAME'}`);
      if (keys.length) bad = 1;
      if (VERBOSE || keys.length) {
        for (const k of (VERBOSE ? Object.keys(r.cand) : keys)) {
          console.log(`   cand.${k} = ${JSON.stringify(getPath(r.cand, k))}`.slice(0, 1600));
          console.log(`   base.${k} = ${JSON.stringify(getPath(r.base, k))}`.slice(0, 1600));
        }
      }
    }
    for (const B of [C, Con, Bb]) if (B && B.pageErrors.length) console.log(`PAGEERRORS ${B.name}${B === Con ? '(on)' : ''}: ${B.pageErrors.slice(0, 5).join(' || ')}`);
  } finally {
    for (const B of [C, Con, Bb]) if (B) await B.close();
  }
  return bad;
}

main().then((code) => { clearTimeout(KILL); process.exit(code); }, (e) => { console.log('ERROR', e && e.stack ? e.stack : e); clearTimeout(KILL); process.exit(2); });
