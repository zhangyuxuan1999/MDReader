// bench/verify/v5-offa-upgrade.mjs — verify-off-app JOB 1: the upgrade in place on the web page.
// Builds browser profiles WITH 0.1.1 (persistent Chromium contexts, user-data dirs under MDR_TMP), then opens the
// same origin and the same stored data with the CANDIDATE (copy A; 0.1.1 opens copy B as the control), then serves
// 0.1.1 again and opens copy A (going back). No ?perf=1: what a user gets; DOM and keyboard only.
// The script serves both builds itself, one after the other, on MDR_UPG_PORT (default 5586).
//   MDR_TMP=<scratch> node bench/verify/v5-offa-upgrade.mjs [profile ...]
// Prints, per profile: SAME / DIFF of the candidate's first view against 0.1.1's, the restore results, and
// the going-back view. Global timeout 300 s (run it in the background).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// fix-save (round 7, harness): MDR_CAND_DIST names another candidate dist (a build of the tree, the 0.2.1 candidate).
const CAND_DIST = process.env.MDR_CAND_DIST ? path.resolve(process.env.MDR_CAND_DIST) : path.join(ROOT, 'release/staging-0.2.0.noindex/dist');
const BASE_DIST = path.join(ROOT, 'release/baseline-0.1.1.noindex/dist');
const PORT = process.env.MDR_UPG_PORT || '5586';
const URL0 = `http://localhost:${PORT}/`;
const TMP = fs.mkdtempSync(path.join(process.env.MDR_TMP || '/tmp', 'v5-offa-upg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wd = setTimeout(() => { console.log('FAIL global timeout'); cleanup(); process.exit(3); }, 300_000);
let server = null;
function cleanup() {
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} server = null; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function serve(dist) {
  if (server) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} server = null; await sleep(800); }
  server = spawn('npx', ['vite', 'preview', '--outDir', dist, '--port', PORT, '--strictPort'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(URL0); const t = await r.text(); if (t.includes('index-')) { const m = t.match(/index-[\w-]+\.js/); return m && m[0]; } } catch {}
    await sleep(150);
  }
  throw new Error('server did not start');
}

const OBSERVE = async () => {
  const idb = await new Promise((res) => {
    const o = indexedDB.open('keyval-store');
    o.onupgradeneeded = () => { o.result.createObjectStore('keyval'); };
    o.onsuccess = () => {
      const db = o.result; const out = {};
      try {
        const c = db.transaction('keyval').objectStore('keyval').openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { const v = cur.value; out[String(cur.key)] = String(cur.key).startsWith('mdr.recent') && Array.isArray(v) ? v.map((e) => e.name + (e.handle ? '+h' : '')) : v && typeof v === 'object' ? { text: v.text, keys: Object.keys(v).sort().join(',') } : v; cur.continue(); } else { db.close(); res(out); } };
        c.onerror = () => { db.close(); res(out); };
      } catch (e) { db.close(); res({ err: String(e) }); }
    };
    o.onerror = () => res({ err: 'open' });
  });
  const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).sort() : null;
  const ls = {};
  for (const k of Object.keys(localStorage).sort()) { const v = localStorage.getItem(k); ls[k] = v.length > 80 ? `<${v.length} chars>` : v; }
  const root = document.querySelector('#app')?.firstElementChild;
  const toc = document.querySelector('.mdr-toc');
  return {
    ls, idb, dbs,
    theme: document.documentElement.dataset.theme,
    rootCls: root ? root.className : null,
    split: root ? root.style.getPropertyValue('--split') : null,
    toc: toc ? getComputedStyle(toc).display + '/' + Math.round(toc.getBoundingClientRect().width) : null,
    pressed: [...document.querySelectorAll('[aria-pressed]')].map((b) => (b.dataset.cmd || b.title) + ':' + b.getAttribute('aria-pressed')).sort(),
    title: document.title,
    toasts: [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent),
    text: [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'),
    status: [...document.querySelectorAll('.mdr-statusbar__item')].map((e) => e.textContent).join(' | '),
  };
};

async function withProfile(dir, fn, { viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  try {
    await page.goto(URL0);
    await page.waitForSelector('.cm-content', { timeout: 15000, state: 'attached' });
    await sleep(1500);
    const r = await fn(page);
    if (errors.length) r.errors = errors;
    return r;
  } finally {
    await sleep(300);
    await ctx.close().catch(() => {});
  }
}
const typeEditor = async (page, s) => { await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type(s, { delay: 5 }); };
const opfs = (page, name, text) => page.evaluate(async ([n, t]) => {
  const root = await navigator.storage.getDirectory();
  const h = await root.getFileHandle(n, { create: true });
  if (t != null) { const w = await h.createWritable(); await w.write(t); await w.close(); }
  window.showOpenFilePicker = async () => [h];
  window.showSaveFilePicker = async () => h;
}, [name, text]);
const openVia = async (page, name, text) => { await opfs(page, name, text); await page.keyboard.press('Meta+o'); await sleep(900); };
const restore = async (page) => {
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-toast button, .mdr-toast__action')].find((x) => x.textContent.trim() === '恢复'); if (b) b.click(); return !!b; });
  await sleep(500);
  const dlg = [...(await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent)))];
  if (dlg.length) { await page.evaluate(() => { const b = document.querySelector('.mdr-dialog__btn--danger, .mdr-dialog__btn.is-danger') || [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => /恢复/.test(x.textContent)); if (b) b.click(); }); await sleep(500); }
  return { clicked, dlg };
};
const openRecentByName = async (page, name) => {
  await page.click('.mdr-toolbar__file'); await sleep(200);
  const ok = await page.evaluate((n) => { const li = [...document.querySelectorAll('.mdr-recent li')].find((e) => e.textContent.includes(n)); if (li) li.click(); return !!li; }, name);
  await sleep(1000);
  const dlg = await page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
  return { ok, dlg };
};

const UNT = '草稿 untitled ✓ 😀 第二行\n\n- [ ] task one\n- [x] task two\n\n$x^2$ 和 **粗体**';
// profile: { build(page) on 0.1.1, after?(page) extra step in the check phase }
const P = {
  fresh: { build: async () => {} },
  heavy: {
    build: async (page) => {
      await page.keyboard.press('Meta+Shift+l'); await sleep(300); // theme
      await page.keyboard.press('Meta+Shift+o'); await sleep(300); // toc
      const g = await page.evaluate(() => { const e = document.querySelector('.mdr-gutter'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (g) { await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x - 180, g.y, { steps: 8 }); await page.mouse.up(); await sleep(300); }
      await openVia(page, 'o.md', '# O\n\nbody\n');
      await typeEditor(page, 'X'); await page.keyboard.press('Meta+s'); await sleep(700);
      await openVia(page, 'p.md', '# P\n');
      await page.keyboard.press('Meta+/'); await sleep(300); // mode
      await page.keyboard.press('Meta+/'); await sleep(300);
    },
    after: async (page) => ({ recent: await openRecentByName(page, 'o.md'), text: await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')), title: await page.title() }),
  },
  'dirty-untitled': {
    build: async (page) => { await typeEditor(page, UNT); await sleep(2500); },
    after: async (page) => ({ restore: await restore(page), text: await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')), title: await page.title() }),
  },
  'draft-waiting': {
    build: async (page) => { await typeEditor(page, UNT); await sleep(2500); await page.reload(); await page.waitForSelector('.cm-content', { state: 'attached' }); await sleep(2000); },
    after: async (page) => ({ restore: await restore(page), text: await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')), title: await page.title() }),
  },
  'dirty-named': {
    build: async (page) => { await openVia(page, 'o.md', '# O\n\nbody\n'); await typeEditor(page, '\nunsaved 文字'); await sleep(2500); },
    after: async (page) => {
      const rec = await openRecentByName(page, 'o.md');
      await sleep(600);
      const offers = await page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
      const r = await restore(page);
      return { rec, offers, restore: r, text: await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n')), title: await page.title() };
    },
  },
  corrupted: {
    build: async (page) => {
      await page.evaluate(() => { localStorage.setItem('mdr.theme', 'purple'); localStorage.setItem('mdr.mode', 'zzz'); localStorage.setItem('mdr.toc', 'maybe'); localStorage.setItem('mdr.split', 'NaN%'); localStorage.setItem('mdr.previewEdit', ''); });
      await page.reload(); await page.waitForSelector('.cm-content', { state: 'attached' }); await sleep(1200);
    },
  },
  'corrupted-idb': {
    build: async (page) => {
      await page.evaluate(() => new Promise((res) => {
        const o = indexedDB.open('keyval-store');
        o.onupgradeneeded = () => { o.result.createObjectStore('keyval'); };
        o.onsuccess = () => { const db = o.result; const tx = db.transaction('keyval', 'readwrite'); const s = tx.objectStore('keyval'); s.put('garbage', 'mdr.recent'); s.put({ text: 42 }, 'mdr.draft:untitled'); s.put(null, 'mdr.draft:zzz'); tx.oncomplete = () => { db.close(); res(); }; };
      }));
      await page.reload(); await page.waitForSelector('.cm-content', { state: 'attached' }); await sleep(1200);
    },
  },
  quota: {
    build: async (page) => {
      await page.evaluate(() => { const big = 'x'.repeat(1024 * 1024); let i = 0; try { for (; i < 20; i++) localStorage.setItem('junk' + i, big); } catch {} try { for (let j = 0; j < 2000; j++) localStorage.setItem('junks' + j, 'y'.repeat(1024)); } catch {} });
      await page.keyboard.press('Meta+Shift+l'); await sleep(300);
      await page.keyboard.press('Meta+/'); await sleep(300);
    },
    after: async (page) => { await page.keyboard.press('Meta+Shift+l'); await sleep(300); await page.keyboard.press('Meta+Shift+o'); await sleep(300); return { theme: await page.evaluate(() => document.documentElement.dataset.theme), errs: null }; },
  },
  'dark-preview-narrow': {
    viewport: { width: 520, height: 700 },
    build: async (page) => { await page.keyboard.press('Meta+Shift+l'); await sleep(200); await page.keyboard.press('Meta+Shift+l'); await sleep(200); await page.keyboard.press('Meta+/'); await sleep(200); },
  },
};

const only = process.argv.slice(2);
const names = Object.keys(P).filter((n) => !only.length || only.includes(n));
const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); if (c.pressed) c.pressed = c.pressed.filter((x) => !/togglePreviewEdit/.test(x)); return c; };
try {
  // 1. build with 0.1.1
  console.log('serve 0.1.1:', await serve(BASE_DIST));
  const built = {};
  for (const n of names) {
    const dir = path.join(TMP, n);
    built[n] = await withProfile(dir, async (page) => { await P[n].build(page); await sleep(500); return page.evaluate(OBSERVE); }, P[n]);
    for (const c of ['A', 'B', 'CA', 'CB']) fs.cpSync(dir, path.join(TMP, n + '-' + c), { recursive: true });
  }
  // 2. control: 0.1.1 opens copies B (passive) and CB (with the after step)
  const base = {}, baseAfter = {};
  for (const n of names) {
    base[n] = await withProfile(path.join(TMP, n + '-B'), (p) => p.evaluate(OBSERVE), P[n]);
    if (P[n].after) baseAfter[n] = await withProfile(path.join(TMP, n + '-CB'), async (p) => ({ ...(await P[n].after(p)), view: await p.evaluate(OBSERVE) }), P[n]);
  }
  // 3. the candidate opens copies A and CA
  console.log('serve cand:', await serve(CAND_DIST));
  const cand = {}, candAfter = {};
  for (const n of names) {
    cand[n] = await withProfile(path.join(TMP, n + '-A'), (p) => p.evaluate(OBSERVE), P[n]);
    if (P[n].after) candAfter[n] = await withProfile(path.join(TMP, n + '-CA'), async (p) => ({ ...(await P[n].after(p)), view: await p.evaluate(OBSERVE) }), P[n]);
  }
  // 4. back to 0.1.1: copies A and CA once more; control: B and CB once more
  console.log('serve 0.1.1 again:', await serve(BASE_DIST));
  const backA = {}, backB = {}, backCA = {}, backCB = {};
  for (const n of names) {
    backA[n] = await withProfile(path.join(TMP, n + '-A'), (p) => p.evaluate(OBSERVE), P[n]);
    backB[n] = await withProfile(path.join(TMP, n + '-B'), (p) => p.evaluate(OBSERVE), P[n]);
    if (P[n].after) {
      backCA[n] = await withProfile(path.join(TMP, n + '-CA'), (p) => p.evaluate(OBSERVE), P[n]);
      backCB[n] = await withProfile(path.join(TMP, n + '-CB'), (p) => p.evaluate(OBSERVE), P[n]);
    }
  }
  let bad = 0;
  for (const n of names) {
    const v1 = JSON.stringify(strip(cand[n])) === JSON.stringify(strip(base[n]));
    const v2 = !P[n].after || JSON.stringify(strip(candAfter[n])) === JSON.stringify(strip(baseAfter[n]));
    const v3 = JSON.stringify(backA[n]) === JSON.stringify(backB[n]);
    const v4 = !P[n].after || JSON.stringify(backCA[n]) === JSON.stringify(backCB[n]);
    const pe = cand[n].ls['mdr.previewEdit'];
    const sw = (cand[n].pressed || []).filter((x) => /togglePreviewEdit/.test(x));
    if (!(v1 && v2 && v3 && v4)) bad++;
    console.log(`${v1 && v2 && v3 && v4 ? 'SAME' : 'DIFF'} ${n}: first-view ${v1 ? 'same' : 'DIFF'}, after-step ${v2 ? 'same' : 'DIFF'}, back ${v3 ? 'same' : 'DIFF'}, back-after ${v4 ? 'same' : 'DIFF'}; cand mdr.previewEdit=${JSON.stringify(pe)} switch=${JSON.stringify(sw)}`);
    console.log('   built ' + JSON.stringify(built[n]));
    if (!v1) console.log('   cand  ' + JSON.stringify(cand[n]) + '\n   base  ' + JSON.stringify(base[n]));
    if (!v2) console.log('   candAfter ' + JSON.stringify(candAfter[n]) + '\n   baseAfter ' + JSON.stringify(baseAfter[n]));
    else if (P[n].after) console.log('   after ' + JSON.stringify({ ...candAfter[n], view: undefined }));
    if (!v3) console.log('   backA ' + JSON.stringify(backA[n]) + '\n   backB ' + JSON.stringify(backB[n]));
    if (!v4) console.log('   backCA ' + JSON.stringify(backCA[n]) + '\n   backCB ' + JSON.stringify(backCB[n]));
  }
  console.log(`\n${names.length - bad} same, ${bad} differ`);
} catch (e) {
  console.log('FAIL ' + (e && e.stack));
} finally {
  clearTimeout(wd);
  cleanup();
}
process.exit(0);
