// bench/verify/v4-flow-lib.mjs — verify-flows (0.2.0 stage 2d, round-3 re-verification): helpers shared by the
// v4-flow web scripts. Re-exports bench/verify/v3-flow-lib.mjs and adds trusted CDP drags, OPFS file
// handles and a two-renderer runner (candidate + baseline with the same case code).
//   candidate: npx vite --port 5434 --strictPort                                           (MDR_URL)
//   baseline : npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5444 --strictPort
//              → MDR_BASE_URL='http://localhost:5444/?perf=1'
// Starts nothing and kills nothing; writes nothing into the tree (temp files go to MDR_TMP).
import { chromium } from '@playwright/test';
export * from './v3-flow-lib.mjs';
import { sleep, until } from './v3-flow-lib.mjs';

export const CAND = process.env.MDR_URL || 'http://localhost:5434/';
export const BASE = process.env.MDR_BASE_URL ?? 'http://localhost:5444/?perf=1';

export async function bootAt(page, url) {
  await page.goto(url);
  await until(page, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await sleep(400);
}
export const snap = (page) => page.evaluate(() => ({
  text: window.__mdr.app.getText(),
  title: document.title,
  dialogs: [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent),
  toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent),
  dragover: !!document.querySelector('.is-dragover'),
}));
export async function loadDoc(page, text, name) {
  await page.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
  await page.evaluate(([t, n]) => window.__mdr.app.loadText(t, n), [text, name]);
  await sleep(700);
}
export const pointOf = (page, sel, fx = 0.5, fy = 0.5) => page.evaluate(([s, x, y]) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left + r.width * x, y: y < 0 ? r.bottom + y : r.top + r.height * y };
}, [sel, fx, fy]);
/** A trusted drag (dragEnter, dragOver, drop) at pt through CDP; `types` limits the steps. */
export async function cdpDrag(page, pt, data, { modifiers = 0, steps = ['dragEnter', 'dragOver', 'drop'] } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const type of steps) await cdp.send('Input.dispatchDragEvent', { type, x: pt.x, y: pt.y, data, modifiers });
  } finally {
    await cdp.detach().catch(() => {});
  }
}
export const fileData = (files, items = []) => ({ items, files, dragOperationsMask: 1 | 2 | 16 });
export async function clickBtn(page, label) {
  return page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (b) b.click();
    return !!b;
  }, label);
}
/** An OPFS file the 打开… picker returns (FSA backend). */
export async function opfsOpen(page, name, text) {
  await page.evaluate(async ([n, t]) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n, { create: true });
    const w = await h.createWritable(); await w.write(t); await w.close();
    window.showOpenFilePicker = async () => [h];
  }, [name, text]);
  await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); });
  return until(page, (t) => window.__mdr.app.getText() === t, text, 5000);
}
export const opfsRead = (page, name) => page.evaluate(async (n) => {
  try { return await (await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile()).text(); } catch { return null; }
}, name);
export const allDrafts = (page) => page.evaluate(() => new Promise((res) => {
  const o = indexedDB.open('keyval-store');
  o.onupgradeneeded = () => { o.result.createObjectStore('keyval'); };
  o.onsuccess = () => {
    const db = o.result;
    const out = [];
    try {
      const c = db.transaction('keyval').objectStore('keyval').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { if (String(cur.key).startsWith('mdr.draft:')) out.push({ k: cur.key, text: cur.value.text }); cur.continue(); } else { db.close(); res(out); } };
      c.onerror = () => { db.close(); res(out); };
    } catch { db.close(); res(out); }
  };
  o.onerror = () => res([]);
}));

/** Runs every selected case on the candidate and (unless MDR_BASE_URL='') the baseline; prints both results
 *  and checks `expect(cand, base)`. Cases: { name: { run(page, ctx, url), expect(r, b) } }. */
export async function runBoth(C, { timeoutMs = 110_000 } = {}) {
  const ONLY = process.argv.slice(2);
  const watchdog = setTimeout(() => { console.log('FAIL global timeout'); process.exit(2); }, timeoutMs);
  const browser = await chromium.launch({ headless: true });
  let pass = 0;
  const fails = [];
  try {
    const names = Object.keys(C).filter((n) => !ONLY.length || ONLY.some((o) => n.startsWith(o)));
    const results = {};
    for (const [label, url] of [['cand', CAND], ...(BASE ? [['base', BASE]] : [])]) {
      for (const n of names) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        try {
          await bootAt(page, url);
          (results[n] ??= {})[label] = await C[n].run(page, ctx, url);
        } catch (e) {
          (results[n] ??= {})[label] = { error: String(e && e.message).split('\n')[0].slice(0, 200) };
        } finally {
          await ctx.close().catch(() => {});
        }
      }
    }
    for (const n of names) {
      const r = results[n];
      console.log(`     ${n}:\n       cand ${JSON.stringify(r.cand)}${BASE ? `\n       base ${JSON.stringify(r.base)}` : ''}`);
      const ok = !r.cand.error && C[n].expect(r.cand, BASE ? r.base : null);
      if (ok) pass++; else fails.push(n);
      const bok = BASE && !r.base.error ? C[n].expect(r.base, r.base) : null;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${BASE ? ` (baseline would ${bok ? 'pass' : 'fail'})` : ''}${r.cand.error ? ' — ' + r.cand.error : ''}`);
    }
  } finally {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
  return fails.length;
}
