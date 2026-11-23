// bench/verify/lib2.mjs — rendering-lens helpers on top of lib.mjs: a Worker mirror (wait for the
// worker's structure/idle of the editor's current version instead of racing __mdr.waitIdle), settle
// after edits, structure tiling check, block → startLine map, and a "preview == markdown-it" assertion.
import { chromium } from '@playwright/test';
import { BASE, sleep, renderReference, canonical, diffCanonical, enableMathReference } from './lib.mjs';

export * from './lib.mjs';
await enableMathReference();

const INIT = `
(() => {
  const Orig = window.Worker;
  window.__wm = { structure: -1, idle: -1, ready: 0, errors: [], html: 0, restarts: 0 };
  window.Worker = class extends Orig {
    constructor(...a) {
      super(...a);
      window.__wm.restarts++;
      this.addEventListener('message', (e) => {
        const d = e.data; if (!d || typeof d !== 'object') return;
        const m = window.__wm;
        if (d.type === 'structure' || d.type === 'structureDelta') m.structure = d.version;
        else if (d.type === 'idle') m.idle = d.version;
        else if (d.type === 'ready') m.ready++;
        else if (d.type === 'html') m.html++;
        else if (d.type === 'error') m.errors.push(d.message);
      });
    }
  };
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime | 0, dur: e.duration | 0 }); }).observe({ type: 'longtask', buffered: true }); } catch {}
})();
`;

export async function openApp2({ mode = 'split', viewport = { width: 1400, height: 900 } } = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const consoleErrors = [], consoleWarnings = [], pageErrors = [];
  page.on('console', (m) => { const t = m.type(); if (t === 'error') consoleErrors.push(m.text()); else if (t === 'warning') consoleWarnings.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('crash', () => pageErrors.push('PAGE CRASHED'));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const url = `${BASE}/?mode=${mode}`;
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await sleep(1200);
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr && !!window.__mdr.app, null, { timeout: 90_000 });
  consoleErrors.length = 0; consoleWarnings.length = 0; pageErrors.length = 0;
  return { browser, context, page, consoleErrors, consoleWarnings, pageErrors };
}

/** Waits until the worker posted structure+idle for the editor's current version. */
export async function settle(page, timeoutMs = 60_000) {
  return page.evaluate(async (timeoutMs) => {
    const v = window.__mdr.version();
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (window.__wm.idle === v && window.__wm.structure === v) return { ok: true, version: v };
      await new Promise((r) => setTimeout(r, 20));
    }
    return { ok: false, version: v, idle: window.__wm.idle, structure: window.__wm.structure };
  }, timeoutMs);
}

/** mountAll + wait until no block is pending / stale / slow (twice, for KaTeX re-queues). */
export async function mountAllSettled(page, timeout = 60_000) {
  for (let i = 0; i < 2; i++) {
    await page.evaluate(async () => { await window.__mdr.app.preview.mountAll(); });
    await page.waitForFunction(() => document.querySelectorAll('.md-block.is-pending, .md-block.is-stale, .md-block.is-slow').length === 0, null, { timeout });
    await settle(page, timeout);
  }
}

export async function loadSettled(page, text, name = 'fixture.md', { mountAll = true, timeout = 60_000 } = {}) {
  await page.evaluate(async ({ t, n }) => { await window.__mdr.loadText(t, n); }, { t: text, n: name });
  const s = await settle(page, timeout);
  if (!s.ok) throw new Error('worker did not settle: ' + JSON.stringify(s));
  if (mountAll) await mountAllSettled(page, timeout);
}

export const blocksHtml = (page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview__body .md-block')).map((b) => b.innerHTML).join('\n'));

/** Structure tiling: blocks cover the doc; returns id → {startLine, lineCount, kind, index}. */
export async function structure(page) {
  return page.evaluate(() => {
    const p = window.__mdr.app.preview;
    const ed = window.__mdr.app.editor;
    const n = p.blockCount();
    const docLines = ed.lineCount();
    const text = ed.getText();
    const problems = [];
    const byId = {};
    let line = 1;
    for (let i = 0; i < n; i++) {
      const b = p.blockAtLine(line);
      if (b.index !== i || b.startLine !== line || b.lineCount <= 0) { problems.push(`block ${i}: blockAtLine(${line}) → ${JSON.stringify(b)}`); break; }
      byId[b.id] = { index: i, startLine: b.startLine, lineCount: b.lineCount, kind: b.kind };
      line += b.lineCount;
    }
    if (n > 0 && line - 1 !== docLines) problems.push(`blocks cover ${line - 1} lines, doc has ${docLines}`);
    if (n === 0 && text !== '') problems.push(`0 blocks but doc has ${docLines} lines`);
    const dom = Array.from(document.querySelectorAll('.md-block')).map((w) => Number(w.dataset.id));
    if (dom.length !== n) problems.push(`DOM wrappers ${dom.length} ≠ blocks ${n}`);
    return { n, docLines, byId, problems, domIds: dom };
  });
}

/** Compares the mounted preview against markdown-it rendering of the editor text. */
export async function assertEqualsReference(page, H, label, { ignore } = {}) {
  const text = await page.evaluate(() => window.__mdr.app.getText());
  const html = await blocksHtml(page);
  let expected = canonical(renderReference(text));
  let actual = canonical(html);
  if (ignore) { expected = expected.filter((l) => !ignore.test(l)); actual = actual.filter((l) => !ignore.test(l)); }
  const d = diffCanonical(expected, actual);
  const st = await structure(page);
  if (st.problems.length) H.fail(`${label}: structure tiling`, { problems: st.problems });
  if (d) H.fail(`${label}: preview ≠ markdown-it`, { text: text.length > 1500 ? text.slice(0, 1500) + '…' : text, diffAt: d.index, expected: d.expected, actual: d.actual, expectedLines: d.expectedLines, actualLines: d.actualLines });
  else H.pass(`${label}: preview == markdown-it`, `${actual.length} canonical lines, ${st.n} blocks`);
  return !d && !st.problems.length;
}

export async function tocItems(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.mdr-toc__item')).map((a) => ({
    level: Number((a.className.match(/mdr-toc__item--h(\d)/) || [])[1]), text: a.textContent, line: Number(a.dataset.line),
  })));
}

export async function statusStats(page) {
  return page.evaluate(() => {
    const g = (k) => document.querySelector(`.mdr-statusbar__item[data-stat="${k}"]`);
    const num = (el) => (el && !el.hidden ? Number((el.textContent.match(/\d+/) || [0])[0]) : 0);
    return { words: num(g('words')), chars: num(g('chars')), reading: num(g('reading')) };
  });
}

export function finish(H, app) {
  if (app.pageErrors.length) H.fail('page errors', { errors: app.pageErrors.slice(0, 5) }); else H.pass('no page errors');
  const real = app.consoleErrors.filter((e) => !/Failed to load resource|net::ERR_/.test(e));
  if (real.length) H.fail('console errors', { errors: real.slice(0, 5) }); else H.pass('no console errors');
  if (app.consoleWarnings.length) console.log('console warnings:', app.consoleWarnings.slice(0, 5));
}
