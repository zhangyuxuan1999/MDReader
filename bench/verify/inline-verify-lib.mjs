// bench/verify/inline-verify-lib.mjs — shared harness for the verifier's in-preview editing scripts
// (bench/verify/inline-verify-*.mjs). Starts its own `vite --port 5263 --strictPort` (never :5173) and
// kills it on exit. Console errors and page errors are collected for every page.
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = Number(process.env.MDR_PORT) || 5263;
export const BASE = `http://localhost:${PORT}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const readRoot = (p) => readFileSync(resolve(ROOT, p), 'utf8');

export const results = { pass: 0, fail: 0, lines: [], measurements: [] };
export function check(name, ok, detail = '') {
  if (ok) results.pass++; else results.fail++;
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`;
  results.lines.push(line);
  console.log(line);
}
export function note(name, detail) { const l = `NOTE  ${name}  — ${detail}`; results.lines.push(l); console.log(l); }
export function measure(name, value, target, pass) { results.measurements.push({ name, value: String(value), target, pass }); console.log(`MEAS  ${name} = ${value} (target ${target}) ${pass ? 'ok' : 'MISS'}`); }
export async function step(name, fn) {
  try {
    const d = await fn();
    check(name, true, typeof d === 'string' ? d : '');
  } catch (err) {
    check(name, false, err instanceof Error ? err.message.split('\n').slice(0, 3).join(' | ') : String(err));
  }
}
export const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
export const eq = (a, b, what) => assert(a === b, `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

function killPort(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    for (const pid of pids.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* */ } }
  } catch { /* */ }
}
let server = null;
export async function startServer() {
  killPort(PORT);
  // MDR_DIST=<dir>: serve a production build with `vite preview` instead of the dev server (pages need ?perf=1).
  const args = process.env.MDR_DIST ? ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', process.env.MDR_DIST] : ['vite', '--port', String(PORT), '--strictPort'];
  server = spawn('npx', args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: 'none' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/`)).ok) return; } catch { /* */ }
    await sleep(150);
  }
  throw new Error(`vite not up on :${PORT}\n${log}`);
}
export function stopServer() {
  if (server) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* */ }
    try { server.kill('SIGKILL'); } catch { /* */ }
  }
  killPort(PORT);
}
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

export async function openBrowser(opts = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1400, height: 900 }, colorScheme: opts.colorScheme ?? 'light', acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const h = makeHelpers(page);
  return { browser, context, page, consoleErrors, pageErrors, ...h };
}

export function makeHelpers(page) {
  async function boot(query = 'mode=split', clear = true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(`${BASE}/?${query}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
        if (clear && attempt === 0) { await page.evaluate(() => { try { localStorage.clear(); indexedDB.deleteDatabase && 0; } catch { /* */ } }); continue; }
        await sleep(400);
        return;
      } catch (err) { if (attempt === 2) throw err; }
    }
  }
  const settle = async (ms = 250) => { await sleep(ms); await page.evaluate(() => window.__mdr.waitIdle()); await sleep(60); };
  async function loadDoc(text, name = 'v.md') {
    await page.evaluate(() => window.__mdr.app.preview.endEditSession());
    await page.evaluate(({ t, n }) => window.__mdr.loadText(t, n), { t: text, n: name });
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(250);
  }
  const source = () => page.evaluate(() => window.__mdr.app.getText());
  const version = () => page.evaluate(() => window.__mdr.version());
  const editing = () => page.evaluate(() => {
    const e = document.querySelector('.mdr-preview .is-editing');
    return e ? { id: Number(e.dataset.id), text: e.textContent, ce: e.getAttribute('contenteditable') } : null;
  });
  /** All blocks (walk by line). */
  const blocks = () => page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const n = window.__mdr.app.editor.view.state.doc.lines;
    const out = [];
    let l = 1;
    while (l <= n) { const b = pv.blockAtLine(l); if (!b) break; out.push({ id: b.id, startLine: b.startLine, lineCount: b.lineCount, kind: b.kind }); l = b.startLine + Math.max(1, b.lineCount); }
    return out;
  });
  /** Scrolls block at `line` into view and waits until it is mounted fresh. Returns its id. */
  async function mountLine(line) {
    return page.evaluate(async (line) => {
      const pv = window.__mdr.app.preview;
      const b = pv.blockAtLine(line);
      if (!pv.isLineVisible(line) || !pv.elementOfBlock(b.id)) pv.scrollToLine(line, 0, 'instant');
      for (let i = 0; i < 240; i++) {
        const el = pv.elementOfBlock(pv.blockAtLine(line).id);
        if (el && !el.classList.contains('is-stale') && !el.classList.contains('is-pending') && el.getBoundingClientRect().height > 0) return pv.blockAtLine(line).id;
        await new Promise((r) => requestAnimationFrame(r));
      }
      throw new Error(`block at line ${line} not mounted`);
    }, line);
  }
  /** Returns a click point on the first ordinary text char in block at `line` (skips links, math, checkboxes, UI). */
  async function textPoint(line, which = 'first', needle = null) {
    await mountLine(line);
    return page.evaluate(({ line, which, needle }) => {
      const pv = window.__mdr.app.preview;
      const el = pv.elementOfBlock(pv.blockAtLine(line).id);
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p || p.closest('a[href], .md-math, .katex, [data-mdr-ui], .md-code__lang, button, .md-codewrap > :not(pre)')) return 2;
          if (!n.data.trim()) return 2;
          return 1;
        },
      });
      const nodes = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n);
      if (!nodes.length) return null;
      let n = which === 'last' ? nodes[nodes.length - 1] : nodes[0];
      let i = which === 'last' ? n.data.trimEnd().length - 1 : n.data.search(/\S/);
      if (needle) {
        const f = nodes.find((x) => x.data.includes(needle));
        if (!f) return null;
        n = f; i = f.data.indexOf(needle);
      }
      const r = document.createRange();
      // avoid landing inside a surrogate pair
      if (i > 0 && /[\udc00-\udfff]/.test(n.data[i])) i--;
      r.setStart(n, i); r.setEnd(n, Math.min(n.data.length, i + (/[\ud800-\udbff]/.test(n.data[i]) ? 2 : 1)));
      let rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      const sc = pv.el, box = sc.getBoundingClientRect();
      if (rect.top < box.top + 10 || rect.bottom > box.bottom - 10) {
        sc.scrollTop += rect.top - (box.top + box.height / 2);
        rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      }
      const pre = n.parentElement.closest('pre');
      if (pre && (rect.left < pre.getBoundingClientRect().left || rect.right > pre.getBoundingClientRect().right)) {
        pre.scrollLeft += rect.left - pre.getBoundingClientRect().left - 20;
        rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
      }
      return { x: rect.left + Math.min(2, rect.width / 2), y: rect.top + rect.height / 2 };
    }, { line, which, needle });
  }
  /** Collapsed caret at end of the last visible text of the editing block (or offset). */
  async function caretEnd() {
    return page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.katex-mathml, [data-mdr-ui]') ? 2 : (n.data.trim() ? 1 : 2)) });
      let last = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) last = n;
      if (!last) return false;
      const r = document.createRange();
      const t = last.data.replace(/\n+$/, '');
      r.setStart(last, t.length); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    });
  }
  async function caretAt(needle, where = 'after') {
    await page.evaluate(({ needle, where }) => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, where === 'after' ? i + needle.length : i); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        return;
      }
      throw new Error(`caret: "${needle}" not in editing block`);
    }, { needle, where });
  }
  async function selectText(needle) {
    await page.evaluate((needle) => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        return;
      }
      throw new Error(`select: "${needle}" not in editing block`);
    }, needle);
  }
  /** Caret/selection by a needle searched in the editing block's concatenated text (crosses element boundaries). */
  async function joined(needle, mode = 'after') {
    await page.evaluate(({ needle, mode }) => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes = []; let all = '';
      for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push([n, all.length]); all += n.data; }
      const i = all.indexOf(needle);
      if (i < 0) throw new Error(`joined: "${needle}" not in editing block`);
      const at = (off) => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= off) return [nodes[k][0], off - nodes[k][1]]; return [nodes[0][0], 0]; };
      const r = document.createRange();
      if (mode === 'select') { const a = at(i); const b = at(i + needle.length); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); }
      else { const a = at(mode === 'after' ? i + needle.length : i); r.setStart(a[0], a[1]); r.collapse(true); }
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }, { needle, mode });
  }
  const caretInEditing = () => page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const s = getSelection();
    return !!el && s.rangeCount > 0 && el.contains(s.anchorNode) && document.activeElement === el;
  });
  const caretOffset = () => page.evaluate(() => {
    const el = document.querySelector('.mdr-preview .is-editing');
    const s = getSelection();
    if (!el || !s.rangeCount || !el.contains(s.anchorNode)) return -1;
    const r = document.createRange(); r.setStart(el, 0); r.setEnd(s.anchorNode, s.anchorOffset);
    return r.toString().length;
  });
  const esc = async () => { await page.keyboard.press('Escape'); await settle(); };
  async function clickLine(line, which = 'first', needle = null) {
    const pt = await textPoint(line, which, needle);
    if (!pt) throw new Error(`no text point in block at line ${line}`);
    await page.mouse.click(pt.x, pt.y);
    await sleep(60);
  }
  /** Structure tiles the doc: consecutive, no gaps, last ends at doc end. */
  const tiles = () => page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const n = window.__mdr.app.editor.view.state.doc.lines;
    let l = 1, count = 0;
    while (l <= n) {
      const b = pv.blockAtLine(l);
      if (!b || b.startLine !== l || b.lineCount < 1) return { ok: false, at: l, b };
      l += b.lineCount; count++;
    }
    return { ok: l === n + 1 && count === pv.blockCount(), count, blockCount: pv.blockCount(), lines: n, end: l };
  });
  return { joined, boot, settle, loadDoc, source, version, editing, blocks, mountLine, textPoint, caretEnd, caretAt, selectText, caretInEditing, caretOffset, esc, clickLine, tiles };
}

/** Line diff between two texts: [{line, before, after}] limited. */
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let f = 0;
  while (f < x.length && f < y.length && x[f] === y[f]) f++;
  let ea = x.length - 1, eb = y.length - 1;
  while (ea >= f && eb >= f && x[ea] === y[eb]) { ea--; eb--; }
  return { first: f + 1, before: x.slice(f, ea + 1), after: y.slice(f, eb + 1) };
}

export function finish(extra = {}) {
  console.log(`\n${results.pass}/${results.pass + results.fail} checks passed`);
  console.log('JSON ' + JSON.stringify({ pass: results.pass, fail: results.fail, measurements: results.measurements, ...extra }));
}
