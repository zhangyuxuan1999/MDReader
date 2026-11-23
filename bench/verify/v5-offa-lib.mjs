// bench/verify/v5-offa-lib.mjs — verify-off-app (0.2.0 round-4 verification, switch OFF): shared helpers.
// Candidate: production build served on MDR_PORT (default 5486), opened with ?perf=1 and mdr.previewEdit = "0"
// stored before the app starts (the switch off, hooks on). Baseline: 0.1.1 dist on MDR_BASE_PORT (default 5496),
// opened with ?perf=1. Starts no server, kills nothing, writes nothing into the tree.
import { chromium } from '@playwright/test';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const CAND_PORT = process.env.MDR_PORT || '5486';
export const BASE_PORT = process.env.MDR_BASE_PORT || '5496';
export const builds = () => {
  const only = process.env.MDR_ONLY; // cand | base
  const all = [
    ['cand', `http://localhost:${CAND_PORT}/`],
    ['base', `http://localhost:${BASE_PORT}/`],
  ];
  return only ? all.filter(([l]) => l === only) : all;
};
export async function until(page, fn, arg, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(fn, arg)) return true; } catch {}
    await sleep(50);
  }
  return false;
}
/** A fresh context + page booted at url (?perf=1 added, plus query), switch stored "0". */
export async function boot(browser, url, { query = '', viewport = { width: 1280, height: 800 }, init } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch {} });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(url + '?perf=1' + (query ? '&' + query : ''));
  await until(page, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await page.evaluate(() => window.__mdr.waitIdle && window.__mdr.waitIdle()).catch(() => {});
  await sleep(300);
  const pressed = await page.evaluate(() => document.querySelector('[data-cmd="view.togglePreviewEdit"]')?.getAttribute('aria-pressed') ?? null);
  if (pressed === 'true') throw new Error('switch is ON');
  return { ctx, page, errors };
}
export const toastLog = (page) => page.evaluate(() => {
  window.__toasts = [];
  const seen = new WeakMap();
  const scan = () => {
    for (const e of document.querySelectorAll('.mdr-toast__text')) {
      if (seen.get(e) !== e.textContent) { seen.set(e, e.textContent); window.__toasts.push(e.textContent); }
    }
  };
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
  try { window.__mdr.app.bus.on('toast', (t) => window.__toasts.push('bus:' + (t && (t.text ?? JSON.stringify(t))))); } catch {}
}).catch(() => {});
export const snap = (page) => page.evaluate(() => ({
  text: window.__mdr.app.getText(),
  title: document.title,
  dialogs: [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent),
  toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent),
  status: document.querySelector('.mdr-statusbar__item[data-stat=file]')?.textContent ?? null,
}));
export async function clickBtn(page, label) {
  return page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent.trim() === l);
    if (b) b.click();
    return !!b;
  }, label);
}
export const opfsWrite = (page, name, text) => page.evaluate(async ([n, t]) => {
  const root = await navigator.storage.getDirectory();
  const h = await root.getFileHandle(n, { create: true });
  const w = await h.createWritable(); await w.write(t); await w.close();
}, [name, text]);
export const opfsRead = (page, name) => page.evaluate(async (n) => {
  try { return await (await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile()).text(); } catch { return null; }
}, name);
/** The 打开… picker returns this OPFS file next. */
export const pickerReturns = (page, name) => page.evaluate(async (n) => {
  const root = await navigator.storage.getDirectory();
  const h = await root.getFileHandle(n, { create: true });
  window.showOpenFilePicker = async () => [h];
}, name);
export const pickerSaveReturns = (page, name, delayMs = 0) => page.evaluate(async ([n, d]) => {
  const root = await navigator.storage.getDirectory();
  window.showSaveFilePicker = async () => { if (d) await new Promise((r) => setTimeout(r, d)); return root.getFileHandle(n, { create: true }); };
}, [name, delayMs]);
export async function openOpfs(page, name, text) {
  await opfsWrite(page, name, text);
  await pickerReturns(page, name);
  await page.evaluate(() => { void window.__mdr.app.registry.run('file.open'); });
  return until(page, (t) => window.__mdr.app.getText() === t, text, 5000);
}
/** Slow every FSA writable's close by ms while window.__slow is set; mode 'fail' makes close throw. */
export const slowWrites = (page, ms, mode = 'ok') => page.evaluate(([d, m]) => {
  const P = FileSystemFileHandle.prototype;
  if (!window.__origCW) window.__origCW = P.createWritable;
  const orig = window.__origCW;
  window.__slow = true;
  P.createWritable = async function (...a) {
    const w = await orig.apply(this, a);
    const close = w.close.bind(w);
    w.close = async () => {
      if (window.__slow) await new Promise((r) => setTimeout(r, d));
      if (window.__slow && m === 'fail') { await w.abort().catch(() => {}); throw new DOMException('disk full (test)', 'InvalidStateError'); }
      return close();
    };
    return w;
  };
}, [ms, mode]);
export const allDrafts = (page) => page.evaluate(() => new Promise((res) => {
  const o = indexedDB.open('keyval-store');
  o.onupgradeneeded = () => { o.result.createObjectStore('keyval'); };
  o.onsuccess = () => {
    const db = o.result;
    const out = [];
    try {
      const c = db.transaction('keyval').objectStore('keyval').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { const k = String(cur.key); if (k.startsWith('mdr.draft')) out.push({ k, text: cur.value && cur.value.text }); else if (k.startsWith('mdr.recent')) out.push({ k, names: Array.isArray(cur.value) ? cur.value.map((e) => e.name) : typeof cur.value }); cur.continue(); } else { db.close(); res(out); } };
      c.onerror = () => { db.close(); res(out); };
    } catch { db.close(); res(out); }
  };
  o.onerror = () => res([]);
}));
export async function typeEnd(page, s) {
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.press('Meta+End');
  await page.keyboard.type(s);
}
/** Runs cases {name: async (page, ctx) => result} on both builds; prints both and a SAME / DIFF verdict
 *  (or the case's own judge(c, b) → string|null). Global timeout. */
export async function runCases(C, { timeoutMs = 110_000, judge = {} } = {}) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const names = Object.keys(C).filter((n) => !only.length || only.some((o) => n === o || (o.endsWith('*') && n.startsWith(o.slice(0, -1)))));
  if (process.argv.includes('--list')) { console.log(names.join('\n')); return 0; }
  const wd = setTimeout(() => { console.log('FAIL global timeout'); process.exit(3); }, timeoutMs);
  const browser = await chromium.launch({ headless: true });
  let bad = 0;
  try {
    for (const n of names) {
      const r = {};
      for (const [label, url] of builds()) {
        let b;
        try {
          b = await boot(browser, url);
          await toastLog(b.page);
          r[label] = await C[n](b.page, b.ctx, label);
          if (b.errors.length) r[label].pageErrors = b.errors;
        } catch (e) {
          r[label] = { error: String(e && e.message).split('\n')[0].slice(0, 200) };
        } finally {
          if (b) await b.ctx.close().catch(() => {});
        }
      }
      const v = judge[n] ? judge[n](r.cand, r.base) : (JSON.stringify(r.cand) === JSON.stringify(r.base) ? null : 'DIFF');
      if (v) bad++;
      console.log(`${v ? 'DIFF' : 'SAME'} ${n}${v && v !== 'DIFF' ? ' — ' + v : ''}\n   cand ${JSON.stringify(r.cand)}\n   base ${JSON.stringify(r.base)}`);
    }
  } finally {
    clearTimeout(wd);
    await browser.close().catch(() => {});
  }
  console.log(`\n${names.length - bad} same/ok, ${bad} differ`);
  return bad;
}
