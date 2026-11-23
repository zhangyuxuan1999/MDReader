// bench/verify/ux/lib.mjs — shared harness for the features/UX verification scripts.
// Requires `npx vite --port 5203 --strictPort` running (started separately).
import { chromium } from '@playwright/test';

export const BASE = process.env.MDR_UX_BASE ?? 'http://localhost:5203';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const results = [];
let failures = 0;
export const getFailures = () => failures;
export function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
export async function step(name, fn) {
  try {
    const d = await fn();
    check(name, true, typeof d === 'string' ? d : '');
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}
export function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
export function measure(name, value, target, pass) {
  console.log(`MEASURE ${name} = ${value} (target ${target}) ${pass ? 'PASS' : 'FAIL'}`);
  results.push({ name: `measure:${name}`, ok: pass, detail: `${value} vs ${target}` });
  if (!pass) failures++;
}

export async function launch(opts = {}) {
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1400, height: 900 },
    colorScheme: opts.colorScheme ?? 'light',
    locale: 'zh-CN',
    acceptDownloads: true,
    permissions: opts.permissions ?? [],
  });
  const errors = [];
  const attach = (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  };
  context.on('page', attach);
  const page = await context.newPage();
  return { browser, context, page, errors };
}

export async function open(page, query = '') {
  await page.goto(`${BASE}/${query}`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 30000 });
  await page.evaluate(() => window.__mdr.waitIdle());
}

export async function loadText(page, text, name) {
  await page.evaluate(([t, n]) => window.__mdr.loadText(t, n), [text, name]);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(80);
}

export const getText = (page) => page.evaluate(() => window.__mdr.app.getText());
export const lineText = (page, n) =>
  page.evaluate((n) => window.__mdr.app.editor.view.state.doc.line(n).text, n);
export const cursor = (page) =>
  page.evaluate(() => {
    const v = window.__mdr.app.editor.view;
    const h = v.state.selection.main.head;
    const l = v.state.doc.lineAt(h);
    return { line: l.number, col: h - l.from, anchor: v.state.selection.main.anchor, head: h };
  });
export const selectRange = (page, from, to) =>
  page.evaluate(([f, t]) => {
    const v = window.__mdr.app.editor.view;
    v.dispatch({ selection: { anchor: f, head: t } });
    v.focus();
  }, [from, to]);
/** Places the cursor at (line, col) via the editor and focuses it (setup only). */
export const placeCursor = (page, line, col = 0) =>
  page.evaluate(([l, c]) => {
    const v = window.__mdr.app.editor.view;
    const ln = v.state.doc.line(l);
    v.dispatch({ selection: { anchor: ln.from + Math.min(c, ln.length) } });
    v.focus();
  }, [line, col]);
export const focusEditor = async (page) => {
  await page.click('.cm-content', { position: { x: 5, y: 5 } });
};
export const statusText = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.mdr-statusbar__item')].map((e) => [e.dataset.stat, e.hidden ? null : e.textContent]),
    ),
  );

export function finish(label, errors) {
  console.log(`\n[${label}] ${results.length - failures} passed, ${failures} failed`);
  if (errors.length) console.log(`[${label}] page/console errors (${errors.length}):\n  ` + [...new Set(errors)].slice(0, 30).join('\n  '));
  else console.log(`[${label}] no console/page errors`);
}
