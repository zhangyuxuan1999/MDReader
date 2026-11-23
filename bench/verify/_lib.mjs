// bench/verify/_lib.mjs — shared Playwright harness for the robustness verification scripts.
// Every script: captures console errors / page errors / worker restarts, exposes helpers to load
// documents, wait for the worker to settle on the current editor version, probe input latency,
// and compare the incrementally-edited preview against a from-scratch render of the same text.
import { chromium } from '@playwright/test';

export const BASE = process.env.MDR_BASE || 'http://localhost:5204/';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Installed before any page script: captures Worker instances and mirrors worker→main messages so
// tests can wait for `structure`/`idle` of a specific version instead of racing __mdr.waitIdle().
const INIT_SCRIPT = `
(() => {
  const Orig = window.Worker;
  window.__workers = [];
  window.__wmsgs = { structure: -1, idle: -1, ready: 0, errors: 0, html: 0, draftSaved: [] };
  window.Worker = class extends Orig {
    constructor(...a) {
      super(...a);
      window.__workers.push(this);
      this.addEventListener('message', (e) => {
        const d = e.data; if (!d || typeof d !== 'object') return;
        const m = window.__wmsgs;
        if (d.type === 'structure' || d.type === 'structureDelta') m.structure = d.version;
        else if (d.type === 'idle') m.idle = d.version;
        else if (d.type === 'ready') m.ready++;
        else if (d.type === 'html') m.html++;
        else if (d.type === 'error') m.errors++;
        else if (d.type === 'draftSaved') m.draftSaved.push({ docId: d.docId, version: d.version, at: d.at });
      });
    }
  };
  // Input-latency probe: keydown → next animation frame.
  window.__lat = [];
  window.addEventListener('keydown', () => {
    const t0 = performance.now();
    requestAnimationFrame(() => { window.__lat.push(performance.now() - t0); });
  }, true);
  // Long tasks.
  window.__longTasks = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();
`;

export async function launch(opts = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1', args: ['--js-flags=--expose-gc', ...(opts.args || [])] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (opts.initScript) await context.addInitScript(opts.initScript);
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const log = { consoleErrors: [], pageErrors: [], warnings: [], restarts: 0 };
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') log.consoleErrors.push(text);
    else if (t === 'warning') {
      log.warnings.push(text);
      if (text.includes('[workerClient] restarting')) log.restarts++;
    }
  });
  page.on('pageerror', (e) => log.pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('crash', () => log.pageErrors.push('PAGE CRASHED'));
  return { browser, context, page, log };
}

export async function open(page, query = '') {
  await page.goto(BASE + query, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 60000 });
  // `?doc=` loads asynchronously after __mdr appears; settle() samples __mdr.version() once, so returning
  // before the document is in the editor makes it wait for version 0 forever.
  if (/[?&]doc=/.test(query)) await page.waitForFunction(() => window.__mdr.version() > 0, null, { timeout: 180000 });
}

/** Wait until the worker has posted `idle` for the editor's current version (or timeout). */
export async function settle(page, timeoutMs = 90000) {
  return page.evaluate(async (timeoutMs) => {
    const v = window.__mdr.version();
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (window.__wmsgs.idle === v && window.__wmsgs.structure === v) return { ok: true, version: v };
      await new Promise((r) => setTimeout(r, 25));
    }
    return { ok: false, version: v, idle: window.__wmsgs.idle, structure: window.__wmsgs.structure };
  }, timeoutMs);
}

export async function loadText(page, text, name = 'verify.md') {
  await page.evaluate(async ({ text, name }) => { await window.__mdr.loadText(text, name); }, { text, name });
}

/** Block table of the preview model: verifies the structure tiles the document. */
export async function structureCheck(page) {
  return page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const ed = window.__mdr.app.editor;
    const n = p.blockCount();
    const docLines = ed.lineCount();
    const text = ed.getText();
    const problems = [];
    let line = 1, i = 0, sumLines = 0;
    const kinds = {};
    while (i < n) {
      const b = p.blockAtLine(line);
      if (b.index !== i) { problems.push(`blockAtLine(${line}) → index ${b.index}, expected ${i}`); break; }
      if (b.startLine !== line) { problems.push(`block ${i} startLine ${b.startLine} ≠ ${line}`); break; }
      if (b.lineCount <= 0) { problems.push(`block ${i} lineCount ${b.lineCount}`); break; }
      kinds[b.kind] = (kinds[b.kind] || 0) + 1;
      sumLines += b.lineCount;
      line += b.lineCount;
      i++;
    }
    const expectLines = text === '' ? 0 : docLines;
    if (n > 0 && sumLines !== expectLines) problems.push(`blocks cover ${sumLines} lines, doc has ${expectLines}`);
    if (n === 0 && text !== '') problems.push(`0 blocks but doc has ${docLines} lines`);
    const domBlocks = document.querySelectorAll('.md-block').length;
    const pending = document.querySelectorAll('.md-block.is-pending').length;
    const stale = document.querySelectorAll('.md-block.is-stale').length;
    const errors = document.querySelectorAll('.md-error').length;
    return { blocks: n, docLines, sumLines, domBlocks, pending, stale, errors, kinds, problems };
  });
}

/** Snapshot of the mounted preview: per block, normalised innerHTML (after mountAll). */
export async function previewSnapshot(page) {
  await page.evaluate(async () => { await window.__mdr.app.preview.mountAll(); });
  await sleep(50);
  return page.evaluate(() => {
    const out = [];
    for (const w of document.querySelectorAll('.md-block')) {
      out.push(w.innerHTML.replace(/\s+/g, ' ').trim());
    }
    return out;
  });
}

/** Compare two snapshots; returns first N differences. */
export function diffSnapshots(a, b, max = 5) {
  const diffs = [];
  if (a.length !== b.length) diffs.push(`block count ${a.length} vs ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n && diffs.length < max; i++) {
    if (a[i] !== b[i]) diffs.push(`block ${i}: incremental="${a[i].slice(0, 160)}" vs fresh="${b[i].slice(0, 160)}"`);
  }
  return diffs;
}

export async function latencyStats(page, reset = true) {
  return page.evaluate(async (reset) => {
    // Let pending keydown→rAF probes land before reading.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const a = window.__lat.slice().sort((x, y) => x - y);
    if (reset) window.__lat.length = 0;
    if (!a.length) return { n: 0 };
    const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return { n: a.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1) };
  }, reset);
}

export async function longTasks(page, sinceMs = 0, reset = true) {
  return page.evaluate(({ sinceMs, reset }) => {
    const l = window.__longTasks.filter((t) => t.start >= sinceMs);
    if (reset) window.__longTasks.length = 0;
    const max = l.reduce((m, t) => Math.max(m, t.dur), 0);
    return { count: l.length, max: +max.toFixed(0), over100: l.filter((t) => t.dur > 100).length };
  }, { sinceMs, reset });
}

export async function toasts(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toast')).map((t) => t.textContent.trim()));
}

export async function typeProbe(page, text, delay = 0) {
  await page.evaluate(() => { window.__lat.length = 0; });
  const t0 = Date.now();
  await page.keyboard.type(text, { delay });
  return Date.now() - t0;
}

export function report(title, log, extra = {}) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify({ consoleErrors: log.consoleErrors.slice(0, 10), pageErrors: log.pageErrors.slice(0, 10), restarts: log.restarts, ...extra }, null, 1));
}

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  };
  const measure = (name, value, target, pass) => {
    results.push({ name, value: String(value), target, pass, measure: true });
    console.log(`${pass ? 'OK  ' : 'MISS'}  ${name} = ${value} (target ${target})`);
  };
  return { results, check, measure, failures: () => results.filter((r) => !r.ok && !r.pass).length };
}

export async function fetchTestDoc(name) {
  const res = await fetch(BASE + 'test-data/' + name);
  return res.text();
}
