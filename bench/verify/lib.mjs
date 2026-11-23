// bench/verify/lib.mjs — shared helpers for the rendering-correctness verification scripts.
// Requires a dev server on http://localhost:5202/ (started separately).
import { chromium } from '@playwright/test';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { JSDOM } from 'jsdom';

export const BASE = process.env.MDR_BASE ?? 'http://localhost:5202';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reference renderer (same options as SPEC 4.4)
export function referenceMd() {
  return new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false })
    .enable(['table', 'strikethrough'])
    .use(taskLists, { enabled: true, label: false });
}
const refMd = referenceMd();
let refMdMath = null;
/** Whole-document reference WITH the app's own `$` rules (src/worker/math.ts transpiled with typescript) and the
 *  real KaTeX — used only to check that per-block rendering equals whole-document rendering; the semantics of
 *  the `$` rules themselves are asserted separately (math-check.mjs, render.mjs). */
export async function enableMathReference() {
  if (refMdMath) return;
  // Node 26 strips TypeScript types natively; math.ts has only type imports from markdown-it.
  const mod = await import(new URL('../../src/worker/math.ts', import.meta.url).href);
  if (!(await mod.loadMath())) throw new Error('katex import failed in node');
  refMdMath = referenceMd().use(mod.mathPlugin);
}
export const renderReference = (text) => (refMdMath ?? refMd).render(text);
export const renderReferenceNoMath = (text) => refMd.render(text);

// ---------------------------------------------------------------- browser
export async function openApp(opts = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error') consoleErrors.push(m.text());
    else if (t === 'warning') consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const mode = opts.mode ?? 'split';
  const url = `${BASE}/?mode=${mode}`;
  // warm-up (vite dependency pre-bundling may reload once)
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await sleep(1200);
  await page.goto(url);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  consoleErrors.length = 0; consoleWarnings.length = 0; pageErrors.length = 0;
  return { browser, context, page, consoleErrors, consoleWarnings, pageErrors };
}

/** Loads `text`, waits for worker idle, materializes every block, waits until nothing is pending/stale. */
export async function loadAndSettle(page, text, name = 'fixture.md', { timeout = 60_000, mountAll = true } = {}) {
  const t0 = Date.now();
  await page.evaluate(async ({ t, n }) => {
    await window.__mdr.loadText(t, n);
    await window.__mdr.waitIdle();
  }, { t: text, n: name });
  const idleMs = Date.now() - t0;
  if (mountAll) {
    await page.evaluate(() => window.__mdr.app.registry.run('view.mountAll'));
    await page.evaluate(() => window.__mdr.waitIdle());
    await page.waitForFunction(
      () => document.querySelectorAll('.md-block.is-pending, .md-block.is-stale, .md-block.is-slow').length === 0,
      null,
      { timeout },
    );
    // KaTeX-deferred blocks re-render asynchronously; give one more idle + settle
    await page.evaluate(() => window.__mdr.waitIdle());
    await page.waitForFunction(
      () => document.querySelectorAll('.md-block.is-pending, .md-block.is-stale, .md-block.is-slow').length === 0,
      null,
      { timeout },
    );
  }
  return { idleMs, totalMs: Date.now() - t0 };
}

/** innerHTML of every .md-block in document order, concatenated. */
export const previewHtml = (page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('.mdr-preview__body .md-block')).map((b) => b.innerHTML).join('\n'));

export const previewState = (page) =>
  page.evaluate(() => ({
    blocks: window.__mdr.app.preview.blockCount(),
    wrappers: document.querySelectorAll('.md-block').length,
    pending: document.querySelectorAll('.md-block.is-pending').length,
    stale: document.querySelectorAll('.md-block.is-stale').length,
    toc: Array.from(document.querySelectorAll('.mdr-toc__item')).map((a) => ({
      level: Number((a.className.match(/mdr-toc__item--h(\d)/) || [])[1]),
      text: a.textContent,
      line: Number(a.dataset.line),
      slug: a.dataset.slug ?? a.getAttribute('href') ?? null,
    })),
    stats: {
      words: document.querySelector('.mdr-statusbar__item[data-stat="words"]')?.textContent ?? null,
      chars: document.querySelector('.mdr-statusbar__item[data-stat="chars"]')?.textContent ?? null,
      reading: document.querySelector('.mdr-statusbar__item[data-stat="reading"]')?.textContent ?? null,
      readingHidden: document.querySelector('.mdr-statusbar__item[data-stat="reading"]')?.hidden ?? null,
    },
  }));

// ---------------------------------------------------------------- canonical DOM comparison
const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'start', 'type', 'checked', 'disabled', 'align', 'width', 'height', 'open', 'style', 'colspan', 'rowspan', 'id', 'name', 'value']);
const SKIP_TAGS_UNWRAP = (el) => el.tagName === 'SPAN' && /(^|\s)hljs-/.test(el.className || '');

function canonNode(node, out, depth) {
  if (node.nodeType === 3) {
    const t = node.nodeValue.replace(/\s+/g, ' ');
    if (t.trim()) out.push({ d: depth, s: `#${t.trim()}` });
    return;
  }
  if (node.nodeType !== 1) return; // comments ignored
  if (SKIP_TAGS_UNWRAP(node)) {
    for (const c of node.childNodes) canonNode(c, out, depth);
    return;
  }
  const tag = node.tagName.toLowerCase();
  if (tag === 'span' && /(^|\s)katex(\s|$)/.test(node.className || '')) {
    // KaTeX output: compare only the visible (.katex-html) text; DOMPurify strips <semantics>/<annotation>
    // from the MathML half in the app (checked separately in math-check.mjs).
    const vis = node.querySelector('.katex-html');
    out.push({ d: depth, s: '<katex>' });
    const t = (vis ? vis.textContent : node.textContent).replace(/\s+/g, ' ').trim();
    if (t) out.push({ d: depth + 1, s: `#${t}` });
    out.push({ d: depth, s: '</katex>' });
    return;
  }
  if (tag === 'code') {
    // highlight.js splits code text into spans; compare the code element by its full text content
    out.push({ d: depth, s: '<code>' });
    const t = node.textContent.replace(/\s+/g, ' ').trim();
    if (t) out.push({ d: depth + 1, s: `#${t}` });
    out.push({ d: depth, s: '</code>' });
    return;
  }
  const attrs = [];
  for (const a of node.attributes) {
    if (!KEEP_ATTRS.has(a.name)) continue;
    let v = a.value;
    if (a.name === 'style') v = v.replace(/\s+/g, '').replace(/;$/, '');
    attrs.push(`${a.name}=${JSON.stringify(v)}`);
  }
  attrs.sort();
  out.push({ d: depth, s: `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>` });
  for (const c of node.childNodes) canonNode(c, out, depth + 1);
  out.push({ d: depth, s: `</${tag}>` });
}

/** Merges adjacent text lines (the app splits text across block wrappers / hljs spans). */
function mergeText(lines) {
  const res = [];
  for (const l of lines) {
    const prev = res[res.length - 1];
    if (prev && prev.d === l.d && prev.s.startsWith('#') && l.s.startsWith('#')) prev.s = prev.s + ' ' + l.s.slice(1);
    else res.push({ ...l });
  }
  return res;
}

export function canonical(html) {
  const dom = new JSDOM(`<body>${html}</body>`);
  const out = [];
  for (const c of dom.window.document.body.childNodes) canonNode(c, out, 0);
  return mergeText(out).map((l) => '  '.repeat(l.d) + l.s);
}

/** Returns null when equal, else a description of the first difference with context. */
export function diffCanonical(expected, actual, context = 4) {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) {
      const lo = Math.max(0, i - context);
      const exp = expected.slice(lo, i + context + 1).join('\n');
      const act = actual.slice(lo, i + context + 1).join('\n');
      return { index: i, expectedLines: expected.length, actualLines: actual.length, expected: exp, actual: act };
    }
  }
  return null;
}

// ---------------------------------------------------------------- independent stats (SPEC 4.3.8)
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_RE = /[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}]+)*/gu;
export function independentStats(text) {
  const cjk = (text.match(CJK_RE) || []).length;
  const latinWords = (text.replace(CJK_RE, ' ').match(WORD_RE) || []).length;
  const chars = text.length;
  const readingMinutes = chars === 0 ? 0 : Math.max(1, Math.ceil(cjk / 400 + latinWords / 200));
  return { chars, cjk, latinWords, words: cjk + latinWords, readingMinutes };
}

// ---------------------------------------------------------------- result collection
export function harness(label) {
  const findings = [];
  const measurements = [];
  const passes = [];
  return {
    findings, measurements, passes,
    fail(title, detail) { findings.push({ title, ...detail }); console.log(`FAIL  [${label}] ${title}\n      ${JSON.stringify(detail).slice(0, 900)}`); },
    pass(title, detail = '') { passes.push(title); console.log(`PASS  [${label}] ${title}${detail ? '  — ' + detail : ''}`); },
    measure(name, value, target, pass) { measurements.push({ name, value: String(value), target, pass }); console.log(`${pass ? 'MEAS ' : 'MISS '} [${label}] ${name}: ${value} (target ${target})`); },
    summary() { console.log(`\n[${label}] ${passes.length} pass, ${findings.length} fail, ${measurements.length} measurements`); },
  };
}
