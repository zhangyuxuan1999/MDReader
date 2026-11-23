// bench/verify/v2-flow-web.mjs — verify-flows (0.2.0 stage 2a): file flows of the WEB build in headless Chromium.
// Without MDR_URL it starts its own server on MDR_PORT (default 5284) and stops it at the end:
//   node bench/verify/v2-flow-web.mjs W1 W7                                   # candidate: vite dev server
//   MDR_DIST=release/baseline-0.1.1.noindex/dist node bench/verify/v2-flow-web.mjs W1 W7   # baseline: vite preview of that dist
//   MDR_URL=http://localhost:5284/ node bench/verify/v2-flow-web.mjs ...      # an already running renderer (?perf=1 for a dist)
// Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';

const PORT = Number(process.env.MDR_PORT || 5284);
let server = null;
if (!process.env.MDR_URL) {
  try { execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { stdio: 'pipe' }); console.error(`port ${PORT} is busy: pass MDR_URL or MDR_PORT`); process.exit(64); } catch { /* free */ }
  const args = process.env.MDR_DIST ? ['vite', 'preview', '--outDir', process.env.MDR_DIST, '--port', String(PORT), '--strictPort'] : ['vite', '--port', String(PORT), '--strictPort'];
  server = spawn('npx', args, { stdio: 'ignore', detached: true });
  const end = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > end) { console.error('server did not come up'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 200));
  }
}
const stopServer = () => { if (server) { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } server = null; } };
process.on('exit', stopServer);
const URL0 = process.env.MDR_URL || `http://localhost:${PORT}/${process.env.MDR_DIST ? '?perf=1' : ''}`;
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fails.push(name);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};
const watchdog = setTimeout(() => { console.log('GLOBAL TIMEOUT'); stopServer(); process.exit(2); }, 100_000);

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
const storedDraft = (page, id) => page.evaluate(async (docId) => {
  const dbs = indexedDB.databases ? await indexedDB.databases() : [];
  if (!dbs.some((d) => d.name === 'keyval-store')) return null;
  return new Promise((res) => {
    const r = indexedDB.open('keyval-store');
    r.onsuccess = () => {
      const db = r.result;
      try {
        const g = db.transaction('keyval', 'readonly').objectStore('keyval').get('mdr.draft:' + docId);
        g.onsuccess = () => { res(g.result ? String(g.result.text) : null); db.close(); };
        g.onerror = () => { res(null); db.close(); };
      } catch { res(null); db.close(); }
    };
    r.onerror = () => res(null);
  });
}, id);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((e) => e.textContent));
async function boot(page) {
  await page.goto(URL0);
  await until(page, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
  await sleep(400);
}
async function typeInEditor(page, text) {
  await page.evaluate(() => window.__mdr.app.editor.focus());
  await page.keyboard.type(text, { delay: 5 });
}
async function waitDraft(page, id, text, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await storedDraft(page, id)) === text) return true;
    await sleep(150);
  }
  return false;
}

const scenarios = {};

// W1 — a crash-recovery draft that the user neither restored nor dismissed: does it survive the page
// being hidden / reloaded while the offer is on screen?
scenarios.W1 = async (browser) => {
  console.log('[W1] unanswered crash-recovery offer survives a reload / tab switch');
  const ctx = await browser.newContext();
  try {
    const p1 = await ctx.newPage();
    await boot(p1);
    await typeInEditor(p1, 'crash text');
    check('W1 precondition: draft stored', await waitDraft(p1, 'untitled', 'crash text'));
    await p1.close({ runBeforeUnload: false });
    const p2 = await ctx.newPage();
    await boot(p2);
    const offered = await until(p2, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')));
    check('W1 offer after the "crash"', !!offered, JSON.stringify(await toasts(p2)));
    console.log('     draft in IDB while offer is up:', JSON.stringify(await storedDraft(p2, 'untitled')));
    // a) the tab is hidden (user switches tabs) while the offer is up: the real visibilitychange handler runs.
    await p2.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(800);
    const afterHide = await storedDraft(p2, 'untitled');
    check('W1a after the tab is hidden the crash draft is still in IndexedDB', afterHide === 'crash text', `stored ${JSON.stringify(afterHide)}`);
    // b) reload with the offer unanswered.
    await p2.evaluate(() => { delete document.visibilityState; });
    await p2.reload();
    await until(p2, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
    await sleep(1200);
    const t2 = await toasts(p2);
    check('W1b after a reload the offer is shown again', t2.some((t) => t.includes('发现未保存的草稿')), JSON.stringify(t2));
    console.log('     draft in IDB after reload:', JSON.stringify(await storedDraft(p2, 'untitled')));
  } finally {
    await ctx.close();
  }
};

// W1r — same, but the only thing the user does is reload the page with the offer up (no artificial event).
scenarios.W1r = async (browser) => {
  console.log('[W1r] unanswered crash-recovery offer survives two plain reloads');
  const ctx = await browser.newContext();
  try {
    const p1 = await ctx.newPage();
    await boot(p1);
    await typeInEditor(p1, 'crash text');
    check('W1r precondition: draft stored', await waitDraft(p1, 'untitled', 'crash text'));
    await p1.close({ runBeforeUnload: false });
    const p2 = await ctx.newPage();
    await boot(p2);
    await sleep(800);
    check('W1r offer 1', (await toasts(p2)).some((t) => t.includes('发现未保存的草稿')), JSON.stringify(await toasts(p2)));
    for (let i = 2; i <= 3; i++) {
      await p2.reload();
      await until(p2, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
      await sleep(1200);
      const t = await toasts(p2);
      check(`W1r offer ${i} after reload ${i - 1}`, t.some((x) => x.includes('发现未保存的草稿')), `toasts ${JSON.stringify(t)} idb ${JSON.stringify(await storedDraft(p2, 'untitled'))}`);
    }
  } finally {
    await ctx.close();
  }
};

// W2 — 新建 → 丢弃 → the untitled draft is gone; then reload: no offer.
scenarios.W2 = async (browser) => {
  console.log('[W2] 新建 → 丢弃 deletes the untitled draft (R2)');
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await boot(p);
    await typeInEditor(p, 'thrown away');
    check('W2 precondition', await waitDraft(p, 'untitled', 'thrown away'));
    await p.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await until(p, () => document.querySelectorAll('.mdr-dialog').length === 1);
    await p.evaluate(() => [...document.querySelectorAll('.mdr-dialog__btn')].find((b) => b.textContent === '丢弃').click());
    await sleep(1500);
    const d = await storedDraft(p, 'untitled');
    check('W2 untitled draft deleted', d === null, JSON.stringify(d));
    await p.reload();
    await until(p, () => !!window.__mdr && !!window.__mdr.app, null, 20000);
    await sleep(1200);
    const t = await toasts(p);
    check('W2 no offer after reload', !t.some((x) => x.includes('发现未保存的草稿')), JSON.stringify(t));
  } finally {
    await ctx.close();
  }
};

// W3 — offer up; 新建 on the clean untitled doc: how many offers are on screen?
scenarios.W3 = async (browser) => {
  console.log('[W3] crash offer up, 新建 (clean) → offers on screen');
  const ctx = await browser.newContext();
  try {
    const p1 = await ctx.newPage();
    await boot(p1);
    await typeInEditor(p1, 'crash text');
    await waitDraft(p1, 'untitled', 'crash text');
    await p1.close({ runBeforeUnload: false });
    const p = await ctx.newPage();
    await boot(p);
    await sleep(800);
    await p.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(800);
    await p.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(800);
    const offers = (await toasts(p)).filter((x) => x.includes('发现未保存的草稿'));
    check('W3 exactly one restore offer after 新建 ×2 on a clean document', offers.length === 1, `offers ${offers.length}`);
  } finally {
    await ctx.close();
  }
};

// Helpers for the File System Access scenarios: real OPFS handles stand in for picked files.
async function opfsFile(page, name, text) {
  await page.evaluate(async ([n, t]) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n, { create: true });
    const w = await h.createWritable(); await w.write(t); await w.close();
    window.__v2h = h;
    window.showOpenFilePicker = async () => [h];
  }, [name, text]);
}
const clickToolbarFile = (page) => page.click('.mdr-toolbar__file');
async function clickRecent(page, name) {
  await clickToolbarFile(page);
  await page.waitForSelector('.mdr-recent__item', { timeout: 3000 });
  await sleep(200);
  const items = await page.$$eval('.mdr-recent__item', (els) => els.map((e) => e.textContent));
  const idx = items.indexOf(name);
  if (idx < 0) throw new Error(`no recent ${name}: ${JSON.stringify(items)}`);
  await (await page.$$('.mdr-recent__item'))[idx].click();
}
const editorText = (page) => page.evaluate(() => window.__mdr.app.getText());
async function answer(page, label) {
  await until(page, () => document.querySelectorAll('.mdr-dialog').length === 1, null, 3000);
  return page.evaluate((l) => {
    const b = [...document.querySelectorAll('.mdr-dialog__btn')].find((x) => x.textContent === l);
    if (b) b.click();
    return !!b;
  }, label);
}

// W4 — a recent entry whose permission was revoked, then one whose file is gone; dirty document both times.
scenarios.W4 = async (browser) => {
  console.log('[W4] recent entry: revoked permission / missing file (web)');
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await boot(p);
    await opfsFile(p, 'w4.md', '# W4\n');
    await p.evaluate(() => window.__mdr.app.registry.run('file.open'));
    const opened = await until(p, () => window.__mdr.app.getText() === '# W4\n');
    check('W4 precondition: opened through the (mocked) picker', !!opened, JSON.stringify(await editorText(p)));
    await p.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await sleep(500);
    await typeInEditor(p, 'my dirty text');
    await waitDraft(p, 'untitled', 'my dirty text');
    await p.evaluate(() => {
      const P = FileSystemHandle.prototype;
      window.__v2q = P.queryPermission; window.__v2r = P.requestPermission;
      P.queryPermission = async () => 'prompt';
      P.requestPermission = async () => 'denied';
    });
    await clickRecent(p, 'w4.md');
    await answer(p, '丢弃');
    await sleep(1000);
    const t1 = await toasts(p);
    console.log('     revoked permission toasts:', JSON.stringify(t1));
    check('W4a the document stays after a refused permission', (await editorText(p)) === 'my dirty text', JSON.stringify(await editorText(p)));
    check('W4a the message names the file and talks about re-authorising', t1.some((t) => t.includes('w4.md') && t.includes('授权')), JSON.stringify(t1));
    await p.evaluate(() => { const P = FileSystemHandle.prototype; P.queryPermission = window.__v2q; P.requestPermission = window.__v2r; });
    await p.evaluate(() => { for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); });
    // the file disappears (moved / deleted by another program)
    await p.evaluate(async () => { const root = await navigator.storage.getDirectory(); await root['remove' + 'Entry']('w4.md'); });
    await clickRecent(p, 'w4.md');
    await answer(p, '丢弃');
    await sleep(1000);
    const t2 = await toasts(p);
    console.log('     missing file toasts:', JSON.stringify(t2));
    check('W4b the document stays after a missing file', (await editorText(p)) === 'my dirty text');
    check('W4b the message names the file', t2.some((t) => t.includes('w4.md')), JSON.stringify(t2));
    await clickToolbarFile(p);
    await sleep(400);
    const items = await p.$$eval('.mdr-recent__item, .mdr-recent__empty', (els) => els.map((e) => e.textContent));
    check('W4b the entry left the recent list', !items.includes('w4.md'), JSON.stringify(items));
    const d = await storedDraft(p, 'untitled');
    check('W4 the dirty untitled draft is still stored (the open failed: nothing was discarded)', d === 'my dirty text', JSON.stringify(d));
  } finally {
    await ctx.close();
  }
};

// W5 — the picker itself rejects (NotAllowedError "File picker already active." / SecurityError without activation).
scenarios.W5 = async (browser) => {
  console.log('[W5] 打开… picker rejects: what does the message say?');
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await boot(p);
    for (const [name, msg] of [['NotAllowedError', 'File picker already active.'], ['SecurityError', 'Must be handling a user gesture to show a file picker.']]) {
      await p.evaluate(([n, m]) => { window.showOpenFilePicker = async () => { throw new DOMException(m, n); }; for (const b of document.querySelectorAll('.mdr-toast__close')) b.click(); }, [name, msg]);
      await p.evaluate(() => window.__mdr.app.registry.run('file.open'));
      await sleep(800);
      console.log(`     ${name}: ${JSON.stringify(await toasts(p))}`);
    }
  } finally {
    await ctx.close();
  }
};

// W6 — beforeunload with a dirty document.
scenarios.W6 = async (browser) => {
  console.log('[W6] beforeunload');
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await boot(p);
    let asked = 0;
    p.on('dialog', async (d) => { if (d.type() === 'beforeunload') asked++; await d.dismiss().catch(() => {}); });
    await typeInEditor(p, 'dirty');
    await sleep(300);
    await p.close({ runBeforeUnload: true });
    await sleep(800);
    check('W6 dirty: beforeunload asked', asked === 1, `asked ${asked}, closed ${p.isClosed()}`);
  } finally {
    await ctx.close();
  }
};

// W7 — two tabs, both on the untitled document: whose draft survives, and what does 丢弃 in one tab delete?
scenarios.W7 = async (browser) => {
  console.log('[W7] two tabs share the untitled draft key');
  const ctx = await browser.newContext();
  try {
    const p1 = await ctx.newPage();
    await boot(p1);
    const p2 = await ctx.newPage();
    await boot(p2);
    await typeInEditor(p2, 'tab two text');
    await waitDraft(p2, 'untitled', 'tab two text');
    await typeInEditor(p1, 'tab one text');
    const one = await waitDraft(p1, 'untitled', 'tab one text');
    console.log(`     after tab 1 typed last: stored ${JSON.stringify(await storedDraft(p1, 'untitled'))} (tab 2 text no longer recoverable: ${one})`);
    await p2.evaluate(() => window.__mdr.app.registry.run('file.new'));
    await answer(p2, '丢弃');
    await sleep(1200);
    const after = await storedDraft(p1, 'untitled');
    check('W7 丢弃 in tab 2 leaves tab 1’s unsaved draft alone', after === 'tab one text', `stored ${JSON.stringify(after)}`);
  } finally {
    await ctx.close();
  }
};

// W8 — the restore offer is still up while the user has typed NEW text into the document; then 恢复.
scenarios.W8 = async (browser) => {
  console.log('[W8] 恢复 on an old offer after typing new text');
  const ctx = await browser.newContext();
  try {
    const p1 = await ctx.newPage();
    await boot(p1);
    await typeInEditor(p1, 'old crash text');
    await waitDraft(p1, 'untitled', 'old crash text');
    await p1.close({ runBeforeUnload: false });
    const p = await ctx.newPage();
    await boot(p);
    await until(p, () => [...document.querySelectorAll('.mdr-toast__text')].some((e) => e.textContent.includes('发现未保存的草稿')));
    await typeInEditor(p, 'brand new typing');
    await sleep(1500);
    let dialogs = 0;
    p.on('dialog', async (d) => { dialogs++; await d.dismiss().catch(() => {}); });
    const clicked = await p.evaluate(() => {
      const b = [...document.querySelectorAll('.mdr-toast__btn')].find((x) => x.textContent === '恢复');
      if (b) b.click();
      return !!b;
    });
    await sleep(800);
    const qs = await p.evaluate(() => [...document.querySelectorAll('.mdr-dialog__text')].map((e) => e.textContent));
    const t = await editorText(p);
    console.log(`     clicked ${clicked}; questions ${JSON.stringify(qs)}; editor ${JSON.stringify(t)}`);
    // Can the new typing be brought back with undo?
    await p.evaluate(() => window.__mdr.app.editor.focus());
    for (let i = 0; i < 5; i++) { await p.keyboard.press('Meta+z'); await sleep(100); }
    const u = await editorText(p);
    console.log(`     after 5 × ⌘Z: ${JSON.stringify(u)}; IDB ${JSON.stringify(await storedDraft(p, 'untitled'))}`);
    check('W8 the newly typed text is not thrown away without a question (or is recoverable by undo)', qs.length > 0 || t.includes('brand new typing') || u.includes('brand new typing'), JSON.stringify({ t, u }));
  } finally {
    await ctx.close();
  }
};

const browser = await chromium.launch({ headless: true });
try {
  for (const [n, fn] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(n)) continue;
    try { await fn(browser); } catch (e) { check(`${n} ran`, false, String(e).split('\n')[0]); }
  }
} finally {
  await browser.close();
  stopServer();
  clearTimeout(watchdog);
}
console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? ': ' + fails.join(' | ') : ''}`);
process.exit(fails.length ? 1 : 0);
