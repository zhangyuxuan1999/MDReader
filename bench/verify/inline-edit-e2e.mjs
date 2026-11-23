// bench/verify/inline-edit-e2e.mjs — integrator end-to-end check of in-preview editing (CONTRACT §11).
//
// Run:  node bench/verify/inline-edit-e2e.mjs
// Starts its own `vite --port 5262 --strictPort` (never touches :5173) and kills it at the end.
// Exit code 0 = every check passed. Console errors and page errors fail the run. HEADED=1 shows the browser.
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.MDR_PORT) || 5262;
const BASE = `http://localhost:${PORT}`;
const SMALL = readFileSync(resolve(ROOT, 'test-data/small.md'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passes = 0;
function check(name, ok, detail = '') {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function step(name, fn) {
  try {
    const detail = await fn();
    check(name, true, typeof detail === 'string' ? detail : '');
  } catch (err) {
    check(name, false, err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const eq = (a, b, what) => assert(a === b, `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// ---------------------------------------------------------------- server
function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  } catch { /* nothing listening */ }
}
async function startServer() {
  killPort(PORT);
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: 'none' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/`)).ok) return server; } catch { /* not yet */ }
    await sleep(150);
  }
  throw new Error(`vite not up on :${PORT}\n${log}`);
}
function stopServer(server) {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  killPort(PORT);
}

const server = await startServer();
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
page.on('dialog', (d) => d.dismiss().catch(() => {}));

async function boot(clearStorage) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(`${BASE}/?mode=split`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
      if (clearStorage && attempt === 0) {
        await page.evaluate(() => { try { localStorage.clear(); } catch { /* */ } });
        continue;                                  // reload with a clean slate (default toggle)
      }
      await sleep(400);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

// ---------------------------------------------------------------- helpers
const settle = async (ms = 300) => { await sleep(ms); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(60); };
async function loadDoc(text, name = 'small.md') {
  await page.evaluate(() => window.__mdr.app.preview.endEditSession());
  await page.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: text, n: name });
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(300);
}
const source = () => page.evaluate(() => window.__mdr.app.getText());
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const srcLines = async (start, count) => (await source()).split('\n').slice(start - 1, start - 1 + count);
const editing = () => page.evaluate(() => {
  const e = document.querySelector('.mdr-preview .is-editing');
  return e ? { id: Number(e.dataset.id), text: e.textContent, ce: e.getAttribute('contenteditable') } : null;
});
const version = () => page.evaluate(() => window.__mdr.version());

/** Scrolls the preview to `line`, then clicks the first/last character of `needle` inside that block. */
async function clickText(line, needle, where = 'end') {
  const pt = await page.evaluate(async ({ line, needle, where }) => {
    const pv = window.__mdr.app.preview;
    const b = pv.blockAtLine(line);
    let el = pv.elementOfBlock(b.id);
    if (!el || !pv.isLineVisible(line)) {
      pv.scrollToLine(line, 0, 'instant');
    }
    for (let i = 0; i < 180; i++) {
      el = pv.elementOfBlock(b.id);
      if (el && !el.classList.contains('is-stale') && !el.classList.contains('is-pending') && el.textContent.includes(needle) && el.getBoundingClientRect().height > 0) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (!el) throw new Error(`block at line ${line} not mounted`);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      const at = where === 'end' ? i + needle.length - 1 : i;
      r.setStart(n, at); r.setEnd(n, at + 1);
      const rect = r.getBoundingClientRect();
      return { x: where === 'end' ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`"${needle}" not in block at line ${line}`);
  }, { line, needle, where });
  await page.mouse.click(pt.x, pt.y);
  await sleep(60);
}
/** Collapsed caret inside the editing block: right after (or before) `needle`. */
async function caretAt(needle, where = 'after') {
  await page.evaluate(({ needle, where }) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, where === 'after' ? i + needle.length : i);
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return;
    }
    throw new Error(`caret: "${needle}" not in the editing block`);
  }, { needle, where });
}
/** Caret after the first `offset` characters of the editing block's text (across element boundaries). */
async function caretAtOffset(offset) {
  await page.evaluate((offset) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (left <= n.data.length) {
        const r = document.createRange(); r.setStart(n, left); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        return;
      }
      left -= n.data.length;
    }
    throw new Error('offset beyond text');
  }, offset);
}
async function selectWord(word) {
  await page.evaluate((word) => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.data.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return;
    }
    throw new Error(`select: "${word}" not in the editing block`);
  }, word);
}
const caretInEditing = () => page.evaluate(() => {
  const el = document.querySelector('.mdr-preview .is-editing');
  const s = getSelection();
  return !!el && s.rangeCount > 0 && el.contains(s.anchorNode) && document.activeElement === el;
});
const caretOffsetInEditing = () => page.evaluate(() => {
  const el = document.querySelector('.mdr-preview .is-editing');
  const s = getSelection();
  if (!el || !s.rangeCount || !el.contains(s.anchorNode)) return -1;
  const r = document.createRange(); r.setStart(el, 0); r.setEnd(s.anchorNode, s.anchorOffset);
  return r.toString().length;
});
const focusState = () => page.evaluate(() => {
  const ed = document.querySelector('.mdr-preview .is-editing');
  const f = document.querySelectorAll('.mdr-preview .is-focus');
  const peer = document.querySelector('.cm-peerLine');
  const view = window.__mdr.app.editor.view;
  const peerLine = peer ? view.state.doc.lineAt(view.posAtDOM(peer)).number : null;
  return { count: f.length, inEditing: !!ed && f.length === 1 && ed.contains(f[0]), peerLine };
});
const normHtml = (h) => h
  .replace(/\s*\bis-focus\b/g, '')
  .replace(/\sclass=""/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const esc = async () => { await page.keyboard.press('Escape'); await settle(); };

// ================================================================= run
try {
  await boot(true);

  // ---------------------------------------------------------- toggle default
  await step('toggle is ON by default and its toolbar button is pressed', async () => {
    eq(await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable()), true, 'isPreviewEditable');
    const btn = await page.evaluate(() => {
      const b = document.querySelector('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]');
      return b ? { pressed: b.getAttribute('aria-pressed'), title: b.title } : null;
    });
    assert(btn, 'no toolbar button');
    eq(btn.pressed, 'true', 'aria-pressed');
    return btn.title;
  });

  // ---------------------------------------------------------- session + typing
  await loadDoc(SMALL);
  const P1 = lineOf(SMALL, '本文件由');          // line 3
  await step('click into the first paragraph → .is-editing + contenteditable, no source change', async () => {
    const v0 = await version();
    await clickText(P1, '生成。', 'end');
    await caretAt('生成。');
    const e = await editing();
    assert(e && e.ce === 'true', 'no contenteditable session');
    await sleep(100);
    eq(await source(), SMALL, 'source after click');
    eq(await version(), v0, 'editor version after click');
    await page.evaluate(() => { window.__e2eEl = document.querySelector('.mdr-preview .is-editing'); window.__e2eP = window.__e2eEl.querySelector('p'); });
    return `block ${e.id}`;
  });

  await step('focus-line tint follows the edited block (preview .is-focus + editor peer line)', async () => {
    const f = await focusState();
    assert(f.inEditing, `preview focus not in the editing block (${f.count} tinted)`);
    eq(f.peerLine, P1, 'editor peer line');
  });

  await step('typing at the caret updates the editor within 2 frames', async () => {
    const frames = await page.evaluate(async () => {
      const before = window.__mdr.app.getText();
      document.execCommand('insertText', false, 'Q');
      for (let f = 1; f <= 4; f++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (window.__mdr.app.getText() !== before) return f;
      }
      return -1;
    });
    assert(frames >= 1 && frames <= 2, `frames=${frames}`);
    eq((await srcLines(P1, 1))[0], '本文件由 scripts/gen-sample.mjs 生成。Q', 'line');
    return `${frames} frame(s)`;
  });

  await step('20 keystrokes at 30 ms: block not re-rendered, caret stays inside, status/hint visible', async () => {
    const t0 = Date.now();
    await page.keyboard.type('abcdefghijklmnopqrst', { delay: 30 });
    await sleep(80);
    const st = await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const hint = document.querySelector('.mdr-preview__edit-hint');
      const mode = document.querySelector('.mdr-statusbar__item[data-stat="mode"]');
      return {
        same: el === window.__e2eEl && window.__e2eEl.isConnected,
        sameP: window.__e2eEl.querySelector('p') === window.__e2eP && window.__e2eP.isConnected,
        hint: !!hint && !hint.hidden && hint.getBoundingClientRect().width > 0,
        status: mode ? mode.textContent : '', statusFlag: mode?.dataset.previewEdit,
      };
    });
    assert(st.same, 'the editing section was replaced');
    assert(st.sameP, 'the paragraph element was replaced');
    assert(await caretInEditing(), 'caret left the block');
    assert(st.hint, 'edit hint hidden');
    assert(st.statusFlag === '1' && st.status.includes('预览编辑'), `status "${st.status}"`);
    eq((await srcLines(P1, 1))[0], '本文件由 scripts/gen-sample.mjs 生成。Qabcdefghijklmnopqrst', 'line');
    return `${Date.now() - t0} ms, status "${st.status}"`;
  });

  await step('Shift+Enter → source gains "  \\n" at that spot', async () => {
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('BR');
    await settle();
    const l = await srcLines(P1, 2);
    eq(l.join('\n'), '本文件由 scripts/gen-sample.mjs 生成。Qabcdefghijklmnopqrst  \nBR', 'lines');
    assert(await editing(), 'session ended');
  });

  await step('⌘S while editing: saved text is flushed, session and caret survive, typing continues', async () => {
    await page.evaluate(() => {
      window.__e2eSaved = null;
      window.showSaveFilePicker = async () => ({
        name: 'small.md', kind: 'file',
        createWritable: async () => ({ write: async (t) => { window.__e2eSaved = typeof t === 'string' ? t : await new Blob([t]).text(); }, close: async () => {} }),
        getFile: async () => new File([window.__e2eSaved ?? ''], 'small.md'),
        queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      });
    });
    const id0 = (await editing()).id;
    await page.keyboard.type('S1');
    await page.keyboard.press('ControlOrMeta+s');
    await page.keyboard.type('S2');
    await settle(400);
    const e = await editing();
    assert(e && e.id === id0, 'session ended by ⌘S');
    const l = (await srcLines(P1 + 1, 1))[0];
    eq(l, 'BRS1S2', 'typing after ⌘S');
    const saved = await page.evaluate(() => window.__e2eSaved);
    if (saved !== null) assert(saved.includes('BRS1'), 'saved text missing the flushed keys');
    return saved === null ? 'saved via download fallback (no picker)' : 'saved text included the flushed keys';
  });
  await esc();

  // ---------------------------------------------------------- Enter splits
  await loadDoc(SMALL);
  await step('Enter mid-paragraph → two paragraphs; session moves to the second block, caret at its start', async () => {
    await clickText(P1, '本文件', 'start');
    await caretAt('本文件');
    const id0 = (await editing()).id;
    await page.keyboard.press('Enter');
    await settle(400);
    const l = await srcLines(P1, 3);
    eq(l.join('\n'), '本文件\n\n由 scripts/gen-sample.mjs 生成。', 'split lines');
    const e = await editing();
    assert(e && e.id !== id0, 'no session on the new block');
    assert(e.text.startsWith('由'), `editing "${e.text.slice(0, 20)}"`);
    eq(await caretOffsetInEditing(), 0, 'caret offset in new block');
    await page.keyboard.type('NEW');
    await settle();
    eq((await srcLines(P1 + 2, 1))[0], 'NEW由 scripts/gen-sample.mjs 生成。', 'typing continues');
    const f = await focusState();
    assert(f.inEditing, 'focus tint did not follow to the new block');
    eq(f.peerLine, P1 + 2, 'peer line after split');
  });

  await step('click outside the block (editor) ends the session', async () => {
    assert(await editing(), 'precondition: session');
    const box = await page.locator('.cm-content').boundingBox();
    await page.mouse.click(box.x + 40, box.y + 10);
    await settle(150);
    eq(await editing(), null, 'session after outside click');
  });

  // ---------------------------------------------------------- formatting keys
  await loadDoc(SMALL);
  const P2 = lineOf(SMALL, 'The quick brown fox');
  const P2src = SMALL.split('\n')[P2 - 1];
  let beforeEsc = '';
  await step('⌘E / ⌘B / ⌘I on selected words and ⌘K with the inline URL input', async () => {
    await clickText(P2, 'quick', 'end');
    assert(await editing(), 'no session');
    await selectWord('quick');
    await page.keyboard.press('ControlOrMeta+e');
    await settle(120);
    assert((await srcLines(P2, 1))[0].includes('The `quick` brown'), `⌘E: ${(await srcLines(P2, 1))[0].slice(0, 120)}`);
    await selectWord('brown');
    await page.keyboard.press('ControlOrMeta+b');
    await settle(120);
    assert((await srcLines(P2, 1))[0].includes('**brown**'), '⌘B');
    await selectWord('fox');
    await page.keyboard.press('ControlOrMeta+i');
    await settle(120);
    assert((await srcLines(P2, 1))[0].includes('*fox*'), '⌘I');
    await selectWord('lazy');
    await page.keyboard.press('ControlOrMeta+k');
    await sleep(100);
    assert(await page.evaluate(() => document.activeElement?.closest('.mdr-preview__link-input') !== null), 'link input not focused');
    await page.keyboard.type('https://k.example/');
    await page.keyboard.press('Enter');
    await settle();
    const want = P2src.replace('The quick brown fox jumps over the lazy dog.', 'The `quick` **brown** *fox* jumps over the [lazy](https://k.example/) dog.');
    eq((await srcLines(P2, 1))[0], want, 'line after formatting');
    assert(await editing(), 'session survives');
    beforeEsc = await page.evaluate(() => { window.__mdr.app.preview.flushEditSession(); return window.__mdr.app.getText(); });
    return 'whole line exact (bold/italic/code/link/del of the original preserved)';
  });

  await step('Esc → session ends, block re-rendered from the worker equals a fresh render, source unchanged', async () => {
    const id = (await editing()).id;
    await esc();
    eq(await editing(), null, 'session after Esc');
    const after = await source();
    eq(after, beforeEsc, 'source changed by the re-render');
    const html = await page.evaluate((line) => {
      const pv = window.__mdr.app.preview;
      const el = pv.elementOfBlock(pv.blockAtLine(line).id);
      return { html: el.innerHTML, ce: el.getAttribute('contenteditable'), cls: el.className };
    }, P2);
    assert(html.ce === null || html.ce === 'false', `contenteditable=${html.ce}`);
    assert(!html.cls.includes('is-editing'), 'still .is-editing');
    await loadDoc(after, 'fresh.md');
    const fresh = await page.evaluate((line) => {
      const pv = window.__mdr.app.preview;
      pv.scrollToLine(line, 0, 'instant');
      return new Promise((res) => {
        const tick = (n) => {
          const el = pv.elementOfBlock(pv.blockAtLine(line).id);
          if (el && !el.classList.contains('is-stale')) res(el.innerHTML); else if (n > 60) res(null); else requestAnimationFrame(() => tick(n + 1));
        };
        tick(0);
      });
    }, P2);
    eq(normHtml(html.html), normHtml(fresh ?? ''), 'innerHTML vs fresh render');
    return `block ${id}`;
  });

  // ---------------------------------------------------------- lists / headings / code / table / math
  await loadDoc(SMALL);
  const L1 = lineOf(SMALL, '- 列表项 A');
  await step('list: Enter creates a new item; source shows "- " lines', async () => {
    await clickText(L1, '列表项 A', 'end');
    await caretAt('列表项 A');
    await page.keyboard.press('Enter');
    await page.keyboard.type('新项');
    await settle(400);
    const l = await srcLines(L1, 6);
    eq(l.join('\n'), '- 列表项 A\n- 新项\n- 列表项 B 带 **粗体**\n  - 嵌套项\n- [ ] 待办事项\n- [x] 已完成事项', 'list lines');
    const e = await editing();
    assert(e && e.text.includes('新项'), 'session left the list');
  });
  await esc();

  await loadDoc(SMALL);
  const H1 = lineOf(SMALL, '## 第 1 节 Section 1');
  await step('heading: typing keeps "## "', async () => {
    await clickText(H1, 'Section 1', 'end');
    await caretAt('Section 1');
    await page.keyboard.type('H');
    await settle();
    eq((await srcLines(H1, 1))[0], '## 第 1 节 Section 1H', 'heading line');
  });
  await esc();

  await loadDoc(SMALL);
  const C1 = lineOf(SMALL, '```ts');
  await step('code block: Enter = newline, source stays fenced with the language', async () => {
    await clickText(C1 + 3, 'return', 'start');
    assert(await editing(), 'no session in the code block');
    const code = await page.evaluate(() => document.querySelector('.mdr-preview .is-editing pre').textContent);
    await caretAtOffset(code.indexOf('return x * 2 + 1;') + 'return x * 2 + 1;'.length);
    await page.keyboard.press('Enter');
    await page.keyboard.type('// more');
    await settle();
    const l = await srcLines(C1, 7);
    eq(l.join('\n'), '```ts\nexport function f1(x: number): number {\n  // section 1\n  return x * 2 + 1;\n// more\n}\n```', 'fence');
    assert(await editing(), 'Enter ended the code session');
  });
  await esc();

  await loadDoc(SMALL);
  const T1 = lineOf(SMALL, '| 列1 | 列2 | 列3 |');
  await step('table: Tab moves to the next cell; source stays a valid GFM table', async () => {
    await clickText(T1 + 2, '1', 'end');
    await page.evaluate(() => {
      const td = [...document.querySelectorAll('.mdr-preview .is-editing td')].find((c) => c.textContent.trim() === '1');
      const r = document.createRange(); r.selectNodeContents(td); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.type('0');
    await page.keyboard.press('Tab');
    const cell = await page.evaluate(() => {
      const s = getSelection();
      const n = s.anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement);
      return el?.closest('td, th')?.textContent ?? null;
    });
    eq(cell, '2', 'cell after Tab');
    await page.keyboard.type('9');
    await settle();
    const l = await srcLines(T1, 4);
    const cols = l.map((x) => x.split('|').length);
    assert(l.every((x) => x.trim().startsWith('|') && x.trim().endsWith('|')), `pipes: ${l.join(' / ')}`);
    assert(/^\|(\s*:?-{3,}:?\s*\|)+$/.test(l[1].trim()), `delimiter row ${l[1]}`);
    assert(cols.every((c) => c === cols[0]), 'column count');
    assert(/^\|\s*10\s*\|\s*(29|92|9)\s*\|\s*3\s*\|$/.test(l[2].trim()), `row ${l[2]}`);
    eq((await srcLines(T1 + 4, 1))[0], '', 'blank line after table kept');
    return l.join(' / ');
  });
  await esc();

  await loadDoc(SMALL);
  const M1 = lineOf(SMALL, '行内公式');
  const M1src = SMALL.split('\n')[M1 - 1];
  await step('KaTeX: editing text before an inline formula keeps it intact', async () => {
    await clickText(M1, '行内公式', 'start');
    await caretAt('行内公式', 'before');
    await page.keyboard.type('前');
    await settle();
    eq((await srcLines(M1, 1))[0], `前${M1src}`, 'math line');
    assert(M1src.includes('$E = mc^2$'), 'fixture formula');
  });
  await esc();

  // ---------------------------------------------------------- IME
  await loadDoc(SMALL);
  await step('IME (CDP): no source write during composition, one write after', async () => {
    await clickText(P1, '生成。', 'end');
    await caretAt('生成。');
    const cdp = await context.newCDPSession(page);
    const v0 = await version();
    for (const t of ['n', 'ni', 'nih', 'niha', 'nihao']) {
      await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(40);
    }
    await sleep(150);
    eq(await version(), v0, 'version during composition');
    eq(await source(), SMALL, 'source during composition');
    await cdp.send('Input.insertText', { text: '你好' });
    await settle();
    eq((await srcLines(P1, 1))[0], '本文件由 scripts/gen-sample.mjs 生成。你好', 'committed line');
    const writes = (await version()) - v0;
    eq(writes, 1, 'writes after compositionend');
    await cdp.detach();
    return `${writes} write`;
  });
  await esc();

  // ---------------------------------------------------------- undo
  await loadDoc(SMALL);
  await step('undo: ⌘Z in the editor after ending the session undoes the preview edit in few groups', async () => {
    await clickText(P1, '生成。', 'end');
    await caretAt('生成。');
    await page.keyboard.type('UNDOTEST', { delay: 30 });
    await esc();
    assert((await source()).includes('UNDOTEST'), 'typed');
    await page.evaluate(() => window.__mdr.app.editor.focus());
    let n = 0;
    while (n < 12 && (await source()) !== SMALL) {
      await page.keyboard.press('ControlOrMeta+z');
      await sleep(60);
      n++;
    }
    eq(await source(), SMALL, 'after undo');
    assert(n <= 3, `${n} undo groups`);
    return `${n} ⌘Z`;
  });

  // ---------------------------------------------------------- large.md
  await step('large.md: editing a paragraph near line 50000 writes only that block; no long task > 50 ms', async () => {
    await page.evaluate(() => window.__mdr.app.preview.endEditSession());
    await page.evaluate(() => window.__mdr.loadUrl('/test-data/large.md'));
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(1500);
    const b = await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      let l = 50000;
      for (let i = 0; i < 200; i++) {
        const x = pv.blockAtLine(l);
        if (x.kind === 0 && pv.elementOfBlock && window.__mdr.app.editor.view.state.doc.line(x.startLine).text.startsWith('这是一个用于性能测试的段落')) return x;
        l = x.startLine + x.lineCount;
      }
      return null;
    });
    assert(b, 'no paragraph near 50000');
    const needle = '性能测试的段落';
    await clickText(b.startLine, needle, 'end');
    assert(await editing(), 'no session on the large.md block');
    await caretAt(needle);
    await page.evaluate(() => {
      window.__e2eBefore = window.__mdr.app.getText();
      window.__e2eLT = [];
      window.__e2eObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__e2eLT.push(e.duration); });
      window.__e2eObs.observe({ type: 'longtask' });
    });
    await page.keyboard.type('LLL', { delay: 30 });
    await settle(500);
    const r = await page.evaluate(() => {
      window.__e2eObs.disconnect();
      const a = window.__e2eBefore.split('\n');
      const c = window.__mdr.app.getText().split('\n');
      let f = 0;
      while (f < a.length && f < c.length && a[f] === c[f]) f++;
      let ea = a.length - 1, ec = c.length - 1;
      while (ea >= f && ec >= f && a[ea] === c[ec]) { ea--; ec--; }
      window.__e2eBefore = null;
      return { first: f + 1, lastBefore: ea + 1, lastAfter: ec + 1, lt: window.__e2eLT, changed: c.slice(f, ec + 1) };
    });
    assert(r.first >= b.startLine && r.lastBefore <= b.startLine + b.lineCount - 1, `changed lines ${r.first}..${r.lastBefore} outside block ${b.startLine}+${b.lineCount}`);
    assert(r.changed.join('\n').includes('LLL'), 'typed text missing');
    const worst = Math.max(0, ...r.lt);
    assert(worst <= 50, `long task ${worst.toFixed(0)} ms`);
    await esc();
    return `block ${b.startLine}+${b.lineCount}, changed ${r.first}..${r.lastBefore}, long tasks ${r.lt.length} (max ${worst.toFixed(0)} ms)`;
  });

  // ---------------------------------------------------------- toggle off + persistence
  await loadDoc(SMALL);
  await step('toggle OFF → clicks no longer edit; reload keeps it OFF', async () => {
    await page.locator('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]').click();
    await sleep(100);
    eq(await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable()), false, 'isPreviewEditable');
    await clickText(P1, '生成。', 'end');
    eq(await editing(), null, 'session with toggle off');
    await boot(false);
    eq(await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable()), false, 'after reload');
    eq(await page.evaluate(() => document.querySelector('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]').getAttribute('aria-pressed')), 'false', 'aria-pressed after reload');
    await page.locator('.mdr-toolbar__btn[data-cmd="view.togglePreviewEdit"]').click();
    await sleep(100);
    eq(await page.evaluate(() => window.__mdr.app.preview.isPreviewEditable()), true, 'back on');
  });

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err instanceof Error ? err.stack : String(err));
} finally {
  await browser.close().catch(() => {});
  stopServer(server);
}
console.log(`\n[inline-edit-e2e] ${passes}/${passes + failures} checks passed`);
process.exit(failures ? 1 : 0);
