// bench/verify/v3-flow-lib.mjs — verify-flows (0.2.0 stage 2c): shared helpers for the v3-flow web scripts.
// The renderer must already be running (it starts nothing and kills nothing):
//   candidate: npx vite --port 5384 --strictPort           → MDR_URL=http://localhost:5384/
//   baseline : npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5394 --strictPort
//                                                          → MDR_URL='http://localhost:5394/?perf=1'
// Writes nothing into the tree.
import { chromium } from '@playwright/test';

export const URL0 = process.env.MDR_URL || 'http://localhost:5384/';
export const IS_BASE = /5394/.test(URL0);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const T = {
  draftFound: '发现未保存的草稿，是否恢复？',
  discardQ: '当前文档尚未保存，是否放弃更改？',
  restoreOver: '草稿提示出现后文档又有改动',
};

let pass = 0;
const fails = [];
export const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
};
export const summary = () => {
  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
  return fails.length;
};

export async function until(page, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(60);
  }
  return last;
}
/** The full stored draft record for docId (null when none), read without creating the database. */
export const storedRecord = (page, id) => page.evaluate(async (docId) => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return null;
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => {
      const db = r.result;
      try {
        const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.draft:' + docId);
        g.onsuccess = () => { res(g.result ?? null); db.close(); };
        g.onerror = () => { res(null); db.close(); };
      } catch { res(null); db.close(); }
    };
    r.onerror = () => res(null);
  });
}, id);
export const storedDraft = async (page, id) => { const r = await storedRecord(page, id); return r ? String(r.text) : null; };
/** Writes a draft record straight into IndexedDB (as a crashed tab would have left it). */
export const seedDraft = (page, rec) => page.evaluate((r) => new Promise((res, rej) => {
  const o = indexedDB.open('keyval-store');
  o.onupgradeneeded = () => { o.result.createObjectStore('keyval'); };
  o.onsuccess = () => {
    const db = o.result;
    const tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').put(r, 'mdr.draft:' + r.docId);
    tx.oncomplete = () => { db.close(); res(true); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  };
  o.onerror = () => rej(o.error);
}), rec);
export const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
export const offers = async (page) => (await toasts(page)).filter((t) => t.includes('发现未保存的草稿')).length;
export const dialogs = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
export const editorText = (page) => page.evaluate(() => window.__mdr.app.getText());
export const run = (page, id) => page.evaluate((c) => { void window.__mdr.app.registry.run(c); }, id);
export async function boot(page, url = URL0) {
  await page.goto(url);
  await until(page, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await sleep(400);
}
export async function typeInEditor(page, text) {
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type(text, { delay: 5 });
}
export async function waitDraft(page, id, text, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await storedDraft(page, id)) === text) return true;
    await sleep(120);
  }
  return false;
}
/** Clicks the dialog button with this label (waits for one dialog). */
export async function answer(page, label, ms = 3000) {
  await until(page, () => document.querySelectorAll('.mdr-dialog').length >= 1, null, ms);
  return page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (b) b.click();
    return !!b;
  }, label);
}
export const toastButton = (page, textPart, label) => page.evaluate(([tp, l]) => {
  for (const t of document.querySelectorAll('.mdr-toast')) {
    if (!(t.textContent || '').includes(tp)) continue;
    const b = [...t.querySelectorAll('button')].find((x) => x.textContent.trim() === l);
    if (b) { b.click(); return true; }
  }
  return false;
}, [textPart, label]);
export const hide = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
export const unhide = (page) => page.evaluate(() => {
  delete document.visibilityState;
  document.dispatchEvent(new Event('visibilitychange'));
});
/** Records the largest number of dialogs ever on screen at once. */
export const watchDialogs = (page) => page.evaluate(() => {
  window.__maxDialogs = document.querySelectorAll('.mdr-dialog').length;
  new MutationObserver(() => {
    window.__maxDialogs = Math.max(window.__maxDialogs, document.querySelectorAll('.mdr-dialog').length);
  }).observe(document.body, { childList: true, subtree: true });
});
export const maxDialogs = (page) => page.evaluate(() => window.__maxDialogs);

/** Runs the selected scenarios with one browser; global timeout. */
export async function main(scenarios, { timeoutMs = 110_000 } = {}) {
  const ONLY = process.argv.slice(2);
  const watchdog = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, timeoutMs);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [n, fn] of Object.entries(scenarios)) {
      if (ONLY.length && !ONLY.includes(n)) continue;
      const ctx = await browser.newContext();
      try { await fn(ctx); } catch (e) { check(`${n} ran`, false, String(e).split('\n')[0]); } finally { await ctx.close().catch(() => {}); }
    }
  } finally {
    await browser.close().catch(() => {});
    clearTimeout(watchdog);
  }
  process.exit(summary() ? 1 : 0);
}
