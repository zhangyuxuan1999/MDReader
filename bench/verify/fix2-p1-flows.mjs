// bench/verify/fix2-p1-flows.mjs — fix-flows-1 (0.2.0 stage 2b): draft flows beyond v2-flow-web.mjs (R4).
//   MDR_URL=http://localhost:5304/ node bench/verify/fix2-p1-flows.mjs [R1 R2 ...]
// Needs a running renderer (MDR_URL; a dist served by `vite preview` needs ?perf=1 for the hooks).
// Writes nothing into the tree (OPFS + IndexedDB of a throw-away browser context). Global timeout 100 s.
//   R1  恢复 after typing → question → 恢复: the draft is shown; ⌘Z brings the typing back (one step)
//   R2  恢复 after typing → question → 取消: the typing stays and the offer is shown again
//   R3  恢复 with nothing typed: no question; ⌘Z brings back the empty document
//   R4  the offer's 丢弃 after typing deletes only the offered record, not this tab's newer draft
//   R5  (check item) text typed while a save is in flight keeps its draft after the save resolves
//   R6  a clean save, then hiding the tab: no draft is written for the saved text
import { chromium } from '@playwright/test';

const URL0 = process.env.MDR_URL;
if (!URL0) { console.error('pass MDR_URL'); process.exit(64); }
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const watchdog = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 100_000);

async function until(page, fn, arg, ms = 6000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await sleep(80);
  }
  return last;
}
/** Every stored draft: { docId: text }. */
const allDrafts = (page) => page.evaluate(async () => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return {};
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => {
      const db = r.result;
      const out = {};
      try {
        const c = db.transaction('keyval', 'readonly').objectStore('keyval').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) { res(out); db.close(); return; }
          if (String(cur.key).startsWith('mdr.draft:') && cur.value) out[String(cur.key).slice(10)] = String(cur.value.text);
          cur.continue();
        };
        c.onerror = () => { res(out); db.close(); };
      } catch { res(out); db.close(); }
    };
    r.onerror = () => res({});
  });
});
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
const questions = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
const editorText = (page) => page.evaluate(() => window.__mdr.app.getText());
async function boot(page) {
  await page.goto(URL0);
  await until(page, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await sleep(400);
}
async function typeInEditor(page, text) {
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type(text, { delay: 5 });
}
async function waitDraftText(page, id, text, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await allDrafts(page))[id] === text) return true;
    await sleep(150);
  }
  return false;
}
const clickToast = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.mdr-toast__btn')].find((x) => x.textContent === l);
  if (b) b.click();
  return !!b;
}, label);
const clickDialog = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent === l);
  if (b) b.click();
  return !!b;
}, label);
const undo = async (page, n = 1) => {
  await page.evaluate(() => window.__mdr.app.editor.focus());
  for (let i = 0; i < n; i++) { await page.keyboard.press('Meta+z'); await sleep(120); }
};

/** A context whose untitled draft is a crash leftover ('old crash text'); returns the second page with the offer up. */
async function crashed(ctx) {
  const p1 = await ctx.newPage();
  await boot(p1);
  await typeInEditor(p1, 'old crash text');
  await waitDraftText(p1, 'untitled', 'old crash text');
  await p1.close({ runBeforeUnload: false });
  const p = await ctx.newPage();
  await boot(p);
  await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')));
  return p;
}

const S = {};
S.R1 = async (browser) => {
  const ctx = await browser.newContext();
  try {
    const p = await crashed(ctx);
    await typeInEditor(p, 'brand new typing');
    await sleep(1500);
    await clickToast(p, '恢复');
    await sleep(400);
    check('R1 a question is asked', (await questions(p)).length === 1, JSON.stringify(await questions(p)));
    await clickDialog(p, '恢复');
    await sleep(400);
    check('R1 恢复 shows the draft', (await editorText(p)) === 'old crash text', JSON.stringify(await editorText(p)));
    await undo(p, 1);
    check('R1 ONE ⌘Z brings the typing back', (await editorText(p)) === 'brand new typing', JSON.stringify(await editorText(p)));
  } finally { await ctx.close(); }
};
S.R2 = async (browser) => {
  const ctx = await browser.newContext();
  try {
    const p = await crashed(ctx);
    await typeInEditor(p, 'brand new typing');
    await sleep(300);
    await clickToast(p, '恢复');
    await sleep(400);
    await clickDialog(p, '取消');
    await sleep(400);
    check('R2 取消 keeps the typing', (await editorText(p)) === 'brand new typing', JSON.stringify(await editorText(p)));
    const offers = (await toasts(p)).filter((t) => t.includes('发现未保存的草稿'));
    check('R2 the offer is shown again (one)', offers.length === 1, JSON.stringify(await toasts(p)));
    // and it still asks (the document changed since the offer first appeared)
    await clickToast(p, '恢复');
    await sleep(400);
    check('R2 the second 恢复 asks again', (await questions(p)).length === 1, JSON.stringify(await questions(p)));
    await clickDialog(p, '取消');
  } finally { await ctx.close(); }
};
S.R3 = async (browser) => {
  const ctx = await browser.newContext();
  try {
    const p = await crashed(ctx);
    await clickToast(p, '恢复');
    await sleep(400);
    check('R3 no question when nothing was typed', (await questions(p)).length === 0, JSON.stringify(await questions(p)));
    check('R3 restored', (await editorText(p)) === 'old crash text', JSON.stringify(await editorText(p)));
    await sleep(1500);
    const st = await p.evaluate(() => document.querySelector('[data-stat=file]')?.textContent ?? '');
    check('R3 status bar says 草稿已存', /草稿已存/.test(st), st);
    await undo(p, 1);
    check('R3 ⌘Z brings back the empty document', (await editorText(p)) === '', JSON.stringify(await editorText(p)));
  } finally { await ctx.close(); }
};
S.R4 = async (browser) => {
  const ctx = await browser.newContext();
  try {
    const p = await crashed(ctx);
    await typeInEditor(p, 'newer typing');
    const stored = await waitDraftText(p, 'untitled', 'newer typing');
    check('R4 precondition: the typing has its draft', stored);
    await clickToast(p, '丢弃');
    await sleep(800);
    const d = (await allDrafts(p)).untitled;
    check('R4 the offer’s 丢弃 leaves this tab’s newer draft', d === 'newer typing', JSON.stringify(d));
  } finally { await ctx.close(); }
};
async function openOpfs(p, name, text) {
  await p.evaluate(async ([n, t]) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n, { create: true });
    const w = await h.createWritable(); await w.write(t); await w.close();
    window.showOpenFilePicker = async () => [h];
  }, [name, text]);
  await p.evaluate(() => window.__mdr.app.registry.run('file.open'));
  return until(p, (t) => window.__mdr.app.getText() === t, text);
}
S.R5 = async (browser) => {
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await boot(p);
    check('R5 precondition: opened', !!(await openOpfs(p, 'r5.md', '# R5\n')));
    await p.evaluate(() => window.__mdr.app.editor.view.dispatch({ selection: { anchor: window.__mdr.app.getText().length } }));
    await typeInEditor(p, 'saved part');
    await sleep(300);
    // The save takes 2 s (slow disk): the user keeps typing meanwhile.
    await p.evaluate(() => {
      const P = FileSystemFileHandle.prototype;
      const orig = P.createWritable;
      P.createWritable = async function (...a) { await new Promise((r) => setTimeout(r, 2000)); return orig.apply(this, a); };
      window.__saveDone = false;
      window.__mdr.app.registry.run('file.save');
    });
    await sleep(200);
    await typeInEditor(p, ' typed during save');
    await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('已保存')), null, 6000);
    await sleep(1800);
    const ds = await allDrafts(p);
    const found = Object.values(ds).some((t) => t === '# R5\nsaved part typed during save');
    check('R5 the text typed during the save has a draft afterwards', found, JSON.stringify(ds));
  } finally { await ctx.close(); }
};
S.R6 = async (browser) => {
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await boot(p);
    check('R6 precondition: opened', !!(await openOpfs(p, 'r6.md', '# R6\n')));
    await typeInEditor(p, 'x');
    await sleep(1500);
    await p.evaluate(() => window.__mdr.app.registry.run('file.save'));
    await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('已保存')), null, 6000);
    await sleep(500);
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(800);
    const ds = await allDrafts(p);
    check('R6 no draft after a clean save + hide', Object.keys(ds).length === 0, JSON.stringify(ds));
  } finally { await ctx.close(); }
};

const browser = await chromium.launch({ headless: true });
try {
  for (const [n, fn] of Object.entries(S)) {
    if (ONLY.length && !ONLY.includes(n)) continue;
    console.log(`[${n}]`);
    try { await fn(browser); } catch (e) { check(`${n} ran`, false, String(e).split('\n')[0]); }
  }
} finally {
  await browser.close();
  clearTimeout(watchdog);
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
process.exit(fails.length ? 1 : 0);
