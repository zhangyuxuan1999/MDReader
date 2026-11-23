// bench/verify/r3-p-drop.mjs — fix-flows (round 3, U17 / H2): files dropped anywhere in the window, and
// the three text drags that must keep working as in 0.1.1. Real (trusted) drags through CDP
// Input.dispatchDragEvent and Playwright's mouse drag, so default actions run as for a user.
//   MDR_URL=http://localhost:5402/ [MDR_BASELINE_URL='http://localhost:5432/?perf=1'] MDR_TMP=<scratch> \
//     node bench/verify/r3-p-drop.mjs [case-prefix …]
// With MDR_BASELINE_URL every case also runs on the baseline renderer; the text drags must give exactly the
// baseline's text, the file drops must open the same file. Writes nothing into the tree. Global timeout 110 s.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL0 = process.env.MDR_URL || 'http://localhost:5402/';
const BASE = process.env.MDR_BASELINE_URL || '';
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timer = setTimeout(() => { console.log('FAIL global timeout'); process.exit(2); }, 110000);
const dir = fs.mkdtempSync(path.join(process.env.MDR_TMP || os.tmpdir(), 'r3-p-drop-'));
const F = {
  a: path.join(dir, 'drop-a.md'),
  b: path.join(dir, 'drop-b.md'),
  png: path.join(dir, 'pic.png'),
  txtdir: path.join(dir, 'folder'),
};
fs.writeFileSync(F.a, '# DROPPED A\n', 'utf8');
fs.writeFileSync(F.b, '# DROPPED B\n', 'utf8');
fs.writeFileSync(F.png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]));
fs.mkdirSync(F.txtdir);
fs.writeFileSync(path.join(F.txtdir, 'inner.md'), '# INNER\n', 'utf8');
const BASE_TEXT = 'alpha line\n\nsecond line\n';

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function boot(page, url) {
  await page.goto(url);
  const end = Date.now() + 20000;
  while (Date.now() < end && !(await page.evaluate(() => !!(window.__mdr && window.__mdr.app)).catch(() => false))) await sleep(80);
  await page.evaluate(() => window.__mdr.app.layout.setMode && window.__mdr.app.layout.setMode('split'));
  await sleep(400);
}
const snap = (page) => page.evaluate(() => ({
  text: window.__mdr.app.getText(),
  title: document.title,
  dialogs: [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent),
  toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent),
}));
async function load(page, text, name) {
  await page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
  await page.evaluate(([t, n]) => window.__mdr.app.loadText(t, n), [text, name]);
  await sleep(700);
}
/** A point inside the element `sel` (fx, fy: fractions of its box; a negative fy counts from the bottom in px). */
const pointOf = (page, sel, fx = 0.5, fy = 0.5) => page.evaluate(([s, x, y]) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left + r.width * x, y: y < 0 ? r.bottom + y : r.top + r.height * y };
}, [sel, fx, fy]);
async function cdpDrag(page, pt, data, modifiers = 0) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data, modifiers });
  } finally {
    await cdp.detach().catch(() => {});
  }
}
const fileData = (files) => ({ items: [], files, dragOperationsMask: 1 | 2 | 16 });

const TARGETS = {
  line: { sel: '.cm-line', fx: 0.1 },
  gutter: { sel: '.cm-gutters', fy: 0.05 },
  below: { sel: '.mdr-pane--editor', fy: -30 },
  preview: { sel: '.mdr-preview section.md-block p' },
  toolbar: { sel: '.mdr-toolbar', fx: 0.6 },
  status: { sel: '.mdr-statusbar' },
  toc: { sel: '.mdr-pane--toc', fy: 0.6 },
};

// Each case returns a result object; `expect(r, base)` says whether the candidate's result is right.
const C = {};
for (const [name, t] of Object.entries(TARGETS)) {
  C[`file-${name}`] = {
    async run(page) {
      await load(page, '# 标题\n\n' + BASE_TEXT, 'base.md');
      const pt = await pointOf(page, t.sel, t.fx ?? 0.5, t.fy ?? 0.5);
      if (!pt) return { error: `no target ${t.sel}` };
      await cdpDrag(page, pt, fileData([F.a]));
      await sleep(1300);
      return snap(page);
    },
    expect: (r) => !r.error && r.text === '# DROPPED A\n' && r.dialogs.length === 0 && !r.title.startsWith('●'),
  };
}
C['file-session'] = {
  async run(page) {
    await load(page, '# 标题\n\n' + BASE_TEXT, 'base.md');
    const pt = await pointOf(page, '.mdr-preview section.md-block p', 0.95);
    await page.mouse.click(pt.x, pt.y);
    await sleep(600);
    const live = await page.evaluate(() => !!document.querySelector('.mdr-preview [contenteditable="true"]'));
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    return { ...(await snap(page)), live };
  },
  expect: (r) => r.text === '# DROPPED A\n' && r.dialogs.length === 0 && !r.title.startsWith('●'),
};
C['file-dirty-cancel'] = {
  async run(page) {
    await load(page, BASE_TEXT, 'base.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'X' } }); });
    await sleep(300);
    const pt = await pointOf(page, '.cm-line', 0.1);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    const asked = await snap(page);
    for (const b of await page.$$('.mdr-dialog__btn')) if ((await b.textContent()).trim() === '取消') { await b.click(); break; }
    await sleep(600);
    const after = await snap(page);
    return { asked: asked.dialogs, textWhileAsked: asked.text, text: after.text };
  },
  expect: (r) => r.asked.length === 1 && r.textWhileAsked === 'X' + BASE_TEXT && r.text === 'X' + BASE_TEXT,
};
C['file-dirty-discard'] = {
  async run(page) {
    await load(page, BASE_TEXT, 'base.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'X' } }); });
    await sleep(300);
    const pt = await pointOf(page, '.cm-line', 0.1);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    for (const b of await page.$$('.mdr-dialog__btn')) if ((await b.textContent()).trim() === '丢弃') { await b.click(); break; }
    await sleep(900);
    return snap(page);
  },
  expect: (r) => r.text === '# DROPPED A\n' && r.dialogs.length === 0,
};
C['file-dialog-open'] = {
  async run(page) {
    await load(page, BASE_TEXT, 'base.md');
    await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.dispatch({ changes: { from: 0, insert: 'X' } }); });
    await sleep(300);
    const pt = await pointOf(page, '.cm-line', 0.1);
    await page.evaluate(() => { void window.__mdr.app.registry.run('file.new'); });
    await sleep(500);
    await cdpDrag(page, pt, fileData([F.a]));
    await sleep(1300);
    const during = await snap(page);
    for (const b of await page.$$('.mdr-dialog__btn')) if ((await b.textContent()).trim() === '取消') { await b.click(); break; }
    await sleep(900);
    const afterCancel = await snap(page);
    return { during: during.dialogs.length, textDuring: during.text, text: afterCancel.text, dialogs: afterCancel.dialogs };
  },
  // 新建's question first; 取消 keeps the text; the drop then asks its own question (R1: nothing dropped).
  expect: (r) => r.during === 1 && r.textDuring === 'X' + BASE_TEXT && r.text === 'X' + BASE_TEXT && r.dialogs.length === 1,
};
C['file-several'] = {
  async run(page) {
    await load(page, BASE_TEXT, 'base.md');
    const pt = await pointOf(page, '.cm-line', 0.1);
    await cdpDrag(page, pt, fileData([F.a, F.b]));
    await sleep(1300);
    return snap(page);
  },
  expect: (r, b) => (b ? r.text === b.text : r.text === '# DROPPED A\n') && r.dialogs.length === 0,
};
C['file-png'] = {
  async run(page) {
    await load(page, BASE_TEXT, 'base.md');
    const pt = await pointOf(page, '.cm-line', 0.1);
    await cdpDrag(page, pt, fileData([F.png]));
    await sleep(1300);
    return snap(page);
  },
  expect: (r) => r.text === BASE_TEXT && r.dialogs.length === 0 && !r.title.startsWith('●') && r.toasts.length >= 1,
};
C['file-folder'] = {
  async run(page) {
    await load(page, BASE_TEXT, 'base.md');
    const pt = await pointOf(page, '.cm-line', 0.1);
    await cdpDrag(page, pt, fileData([F.txtdir]));
    await sleep(1300);
    return snap(page);
  },
  expect: (r) => r.text === BASE_TEXT && r.dialogs.length === 0 && !r.title.startsWith('●'),
};

// Text drags: the baseline's result is the expectation (CodeMirror's own behaviour).
const DRAG_DOC = 'alpha beta gamma\n\nsecond line here\n';
async function selectionDrag(page, alt) {
  await load(page, DRAG_DOC, 'drag.md');
  const pts = await page.evaluate((end) => {
    const v = window.__mdr.app.editor.view;
    v.focus();
    v.dispatch({ selection: { anchor: 6, head: 10 } });
    const mid = v.coordsAtPos(8);
    const to = v.coordsAtPos(end);
    return { from: { x: mid.left, y: (mid.top + mid.bottom) / 2 }, to: { x: to.left + 1, y: (to.top + to.bottom) / 2 } };
  }, DRAG_DOC.indexOf('here'));
  await sleep(200);
  // Headless Chromium starts no native drag from a mouse gesture on a text selection, so the drag is built
  // from its two halves: CodeMirror's own dragstart handler (it records the dragged range and the text), then
  // a trusted CDP drop of that text (Alt = modifier 1 asks for a copy on macOS).
  const text = await page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    const dt = new DataTransfer();
    v.contentDOM.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return dt.getData('text/plain');
  });
  await cdpDrag(page, pts.to, { items: [{ mimeType: 'text/plain', data: text }], dragOperationsMask: 1 | 2 | 16 }, alt ? 1 : 0);
  await page.evaluate(() => window.__mdr.app.editor.view.contentDOM.dispatchEvent(new DragEvent('dragend', { bubbles: true })));
  await sleep(500);
  return { ...(await snap(page)), dragged: text };
}
C['text-move'] = {
  run: (page) => selectionDrag(page, false),
  expect: (r, b) => r.text !== DRAG_DOC && (!b || r.text === b.text),
};
C['text-altcopy'] = {
  run: (page) => selectionDrag(page, true),
  expect: (r, b) => r.text !== DRAG_DOC && (!b || r.text === b.text),
};
C['text-external'] = {
  async run(page) {
    await load(page, DRAG_DOC, 'drag.md');
    const pt = await page.evaluate((at) => {
      const c = window.__mdr.app.editor.view.coordsAtPos(at);
      return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
    }, DRAG_DOC.indexOf('line'));
    await cdpDrag(page, pt, { items: [{ mimeType: 'text/plain', data: 'EXT ' }], dragOperationsMask: 1 | 2 | 16 });
    await sleep(500);
    return snap(page);
  },
  expect: (r, b) => r.text.includes('EXT ') && (!b || r.text === b.text),
};

const browser = await chromium.launch({ headless: true });
let code = 1;
try {
  const names = Object.keys(C).filter((n) => !ONLY.length || ONLY.some((o) => n.startsWith(o)));
  const results = {};
  for (const [label, url] of [['cand', URL0], ...(BASE ? [['base', BASE]] : [])]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    for (const n of names) {
      const page = await ctx.newPage();
      try {
        await boot(page, url);
        (results[n] ??= {})[label] = await C[n].run(page);
      } catch (e) {
        (results[n] ??= {})[label] = { error: String(e && e.message).slice(0, 200) };
      } finally {
        await page.close().catch(() => {});
      }
    }
    await ctx.close();
  }
  for (const n of names) {
    const r = results[n];
    console.log(`     ${n}: cand ${JSON.stringify(r.cand)}${BASE ? `\n       base ${JSON.stringify(r.base)}` : ''}`);
    check(n, !r.cand.error && C[n].expect(r.cand, BASE ? r.base : null), r.cand.error || '');
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
  code = fails.length ? 1 : 0;
} finally {
  clearTimeout(timer);
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
