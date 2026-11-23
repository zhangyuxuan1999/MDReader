// bench/electron/verify-hotfix-behaviour.mjs — VERIFIER verify:behaviour#1 (2026-11-20): adversarial
// stress of the open-file / window lifecycle and the September file flows on a PACKAGED build.
//   MDR_EXE=/path/to/MDReader node bench/electron/verify-hotfix-behaviour.mjs [section ...]
// Sections: cycles timing burst sametick guards quit second minimized hidden files enc
//   + (verify:behaviour#2) heldclose crashq crash3 crashrestore windowless races perf
// Every launch uses a fresh mktemp --user-data-dir; app.addRecentDocument is stubbed so nothing
// reaches the macOS recent list. Only synthetic documents; prints titles / lengths / booleans.
import { electron } from './_electron.mjs'; // isolated profile + recent-documents stub, always
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = process.env.MDR_EXE || '/Applications/MDReader.app/Contents/MacOS/MDReader';
const GLOBAL_MS = Number(process.env.MDR_VERIFY_TIMEOUT || 900000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mdr-vhb-docs-'));
const profiles = [];
const apps = new Set();
const results = [];
const errorsAll = [];

function check(section, name, pass, detail = '') {
  results.push({ section, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function doc(name, n = 3, eol = '\n') {
  let t = '';
  for (let i = 1; i <= n; i++) t += `# 标题 ${name} ${i}${eol}${eol}段落 ${i}：这里有内容，不应该显示为空。${eol}${eol}`;
  const p = path.join(TMP, name);
  fs.writeFileSync(p, t);
  return { path: p, name, text: t, marker: `标题 ${name} ${n}`, h1: `标题 ${name} 1` };
}

async function launch(label, args = []) {
  const prof = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mdr-vhb-prof-'));
  profiles.push(prof);
  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${prof}`, ...args], timeout: 30000 });
  apps.add(app);
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`.slice(0, 240)); });
    page.on('pageerror', (e) => errors.push(`${label} pageerror: ${String(e)}`.slice(0, 240)));
    page.on('crash', () => errors.push(`${label} page crash`));
  };
  app.on('window', watch);
  for (const w of app.windows()) watch(w);
  await app.evaluate(({ app: a, webContents }) => {
    a.addRecentDocument = () => {};
    globalThis.__sends = [];
    globalThis.__boxes = [];
    return true;
  });
  const ctx = { app, prof, errors, label };
  return ctx;
}

/** Wrap webContents.send (records open-file basenames) — must run once a webContents exists. */
async function instrument(app) {
  await app.evaluate(({ webContents }) => {
    const any = webContents.getAllWebContents()[0];
    if (!any) return false;
    const proto = Object.getPrototypeOf(any);
    if (proto.__vhb) return true;
    const orig = proto.send;
    proto.send = function (ch, ...a) {
      if (ch === 'mdr:open-file' || ch === 'mdr:command') globalThis.__sends.push({ ch, arg: ch === 'mdr:open-file' ? String(a[0]).split('/').pop() : a[0], loading: this.isLoading() });
      return orig.call(this, ch, ...a);
    };
    proto.__vhb = true;
    return true;
  });
}
const sends = (app) => app.evaluate(() => globalThis.__sends.filter((s) => s.ch === 'mdr:open-file').map((s) => s.arg));

async function quit(ctx) {
  const { app } = ctx;
  try {
    await Promise.race([app.evaluate(({ app: a }) => { setTimeout(() => a.exit(0), 10); }).catch(() => {}), sleep(3000)]);
    await Promise.race([app.close().catch(() => {}), sleep(5000)]);
  } finally {
    try { app.process().kill('SIGKILL'); } catch { /* gone */ }
    apps.delete(app);
    errorsAll.push(...ctx.errors);
  }
}

const emitOpen = (app, p) => app.evaluate(({ app: a }, fp) => { a.emit('open-file', { preventDefault() {} }, fp); return true; }, p);
const winCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);

/** What the one window shows, read through the main process. */
const mainSnap = (app) => Promise.race([mainSnap0(app), sleep(6000).then(() => ({ windows: -1, error: 'mainSnap timeout (node side)' }))]);
const mainSnap0 = (app) => app.evaluate(async ({ BrowserWindow, app: a }) => {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const w = wins[0];
  if (!w) return { windows: 0 };
  const base = { windows: wins.length, visible: w.isVisible(), minimized: w.isMinimized(), hidden: a.isHidden(), edited: w.isDocumentEdited() };
  if (w.webContents.isCrashed() || w.webContents.isLoading()) return { ...base, loading: true };
  try {
    const r = await Promise.race([new Promise((res) => setTimeout(() => res({ error: 'executeJavaScript timeout' }), 2500)), w.webContents.executeJavaScript(`(() => {
      const cm = document.querySelector('.cm-content');
      let text = null;
      try { text = cm && cm.cmView && cm.cmView.view ? cm.cmView.view.state.doc.toString() : null; } catch (e) { text = null; }
      if (text === null) text = [...document.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n');
      return {
        title: document.title,
        text,
        h1: document.querySelector('.mdr-preview__body h1')?.textContent?.trim() ?? null,
        dialogs: [...document.querySelectorAll('.mdr-dialog')].map((d) => [...d.querySelectorAll('.mdr-dialog__btn')].map((b) => b.textContent.trim()).join('/')),
        toasts: [...document.querySelectorAll('.mdr-toast')].map((t) => (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
      };
    })()`)]);
    return { ...base, ...r };
  } catch (e) {
    return { ...base, error: String(e && e.message).slice(0, 120) };
  }
});
const brief = (s) => (s ? `windows=${s.windows} title=${JSON.stringify(s.title ?? null)} len=${s.text?.length ?? '-'} h1=${s.h1 ? 'yes' : 'no'} dialogs=${JSON.stringify(s.dialogs ?? [])}` : 'none');

async function waitShows(app, d, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let s = null;
  while (Date.now() < deadline) {
    s = await mainSnap(app).catch(() => s);
    if (s && s.windows === 1 && s.title?.includes(d.name) && s.text === d.text.replace(/\r\n/g, '\n') && s.h1 === d.h1) return { ok: true, s };
    await sleep(150);
  }
  return { ok: false, s };
}
async function waitWindows(app, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let c = -1;
  while (Date.now() < deadline) {
    c = await winCount(app).catch(() => c);
    if (c === n) return c;
    await sleep(100);
  }
  return c;
}
async function waitReadyWindow(app, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await mainSnap(app).catch(() => null);
    if (s && s.windows === 1 && !s.loading && typeof s.title === 'string' && s.title.length > 0 && s.text !== undefined) return s;
    await sleep(150);
  }
  return null;
}
async function bootReady(label, args) {
  const ctx = await launch(label, args);
  const w = await ctx.app.firstWindow();
  await w.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(600);
  await instrument(ctx.app);
  return ctx;
}
/** Playwright page of the live window. */
async function livePage(app, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = app.windows().filter((w) => !w.isClosed());
    if (ws.length) return ws[ws.length - 1];
    await sleep(100);
  }
  return null;
}
async function typeEnd(page, text) {
  await page.click('.cm-content');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(text, { delay: 5 });
  await sleep(250);
}
async function clickDialog(app, label) {
  return app.evaluate(async ({ BrowserWindow }, l) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (!w) return false;
    return w.webContents.executeJavaScript(`(() => { const bs = [...document.querySelectorAll('.mdr-dialog__btn')].filter((x) => x.textContent.trim() === ${JSON.stringify(l)}); const b = bs[bs.length - 1]; if (!b) return false; b.click(); return true; })()`);
  }, label);
}
const menuClick = (app, id) => app.evaluate(({ Menu }, mid) => { const it = Menu.getApplicationMenu().getMenuItemById(mid); if (!it) return false; it.click(); return true; }, id);
const closeWin = (app) => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.close(); return !!w; });
async function waitTitleNotDirty(app, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await mainSnap(app).catch(() => null);
    if (s && s.title && !s.title.startsWith('●') && !s.edited) return true;
    await sleep(150);
  }
  return false;
}
function exitPromise(app) {
  const t0 = Date.now();
  return new Promise((r) => app.process().once('exit', (code, sig) => r({ code, sig, ms: Date.now() - t0 })));
}

// ------------------------------------------------------------------------------------------ sections
const S = {};

S.cycles = async () => {
  const ctx = await bootReady('cycles');
  try {
    let ok = 0;
    const bad = [];
    for (let i = 1; i <= 20; i++) {
      const d = doc(`cycle-${String(i).padStart(2, '0')}.md`, 1 + (i % 4));
      await closeWin(ctx.app);
      const c = await waitWindows(ctx.app, 0, 6000);
      await sleep([0, 50, 200, 600][i % 4]);
      await emitOpen(ctx.app, d.path);
      const r = await waitShows(ctx.app, d, 15000);
      if (r.ok && c === 0) ok++; else bad.push(`#${i} closed=${c === 0} ${brief(r.s)}`);
    }
    const sent = await sends(ctx.app);
    check('cycles', '20 alternating close-window / open-file cycles: every new window shows its file', ok === 20, `${ok}/20 shown; open-file sends=${sent.length}${bad.length ? `; bad: ${bad.slice(0, 3).join(' | ')}` : ''}`);
  } finally { await quit(ctx); }
};

// Window created by a Dock click (activate) or by an open-file, a document `delay` ms later; and cold start.
S.timing = async () => {
  const ctx = await bootReady('timing');
  try {
    for (const delay of [0, 50, 150, 400]) {
      const d = doc(`timing-activate-${delay}.md`, 2);
      await closeWin(ctx.app);
      await waitWindows(ctx.app, 0, 6000);
      await sleep(300);
      await ctx.app.evaluate(({ app: a }, [ms, p]) => { a.emit('activate'); setTimeout(() => a.emit('open-file', { preventDefault() {} }, p), ms); return true; }, [delay, d.path]);
      const r = await waitShows(ctx.app, d, 15000);
      check('timing', `Dock click creates a window, open-file ${delay} ms later: shown, one window`, r.ok, brief(r.s));
    }
    for (const delay of [0, 50, 150, 400]) {
      const a1 = doc(`timing-first-${delay}.md`, 2);
      const b1 = doc(`timing-second-${delay}.md`, 3);
      await closeWin(ctx.app);
      await waitWindows(ctx.app, 0, 6000);
      await sleep(300);
      await ctx.app.evaluate(({ app: a }, [ms, p, q]) => { a.emit('open-file', { preventDefault() {} }, p); setTimeout(() => a.emit('open-file', { preventDefault() {} }, q), ms); return true; }, [delay, a1.path, b1.path]);
      const r = await waitShows(ctx.app, b1, 15000);
      check('timing', `open-file creates a window, second open-file ${delay} ms later: the second is shown`, r.ok, brief(r.s));
    }
    // cold start: launch with no file, open-file 0/50/150/400 ms after the first window object appears
    for (const delay of [0, 50, 150, 400]) {
      const d = doc(`timing-cold-${delay}.md`, 2);
      const c2 = await launch(`cold-${delay}`);
      try {
        await c2.app.firstWindow();
        await sleep(delay);
        await emitOpen(c2.app, d.path);
        const r = await waitShows(c2.app, d, 20000);
        check('timing', `cold start, open-file ${delay} ms after the first window exists: shown`, r.ok, brief(r.s));
      } finally { await quit(c2); }
    }
  } finally { await quit(ctx); }
};

S.burst = async () => {
  const ctx = await bootReady('burst');
  try {
    const ds = [doc('burst-1.md', 1), doc('burst-2.md', 2), doc('burst-3.md', 3)];
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    await ctx.app.evaluate(({ app: a }, ps) => { for (const p of ps) a.emit('open-file', { preventDefault() {} }, p); return true; }, ds.map((d) => d.path));
    const r = await waitShows(ctx.app, ds[2], 15000);
    await sleep(1500);
    const s2 = await mainSnap(ctx.app);
    const sent = await sends(ctx.app);
    check('burst', 'three open-file in one tick with the window closed: one window, last shown, all 3 delivered in order',
      r.ok && s2.windows === 1 && s2.title?.includes('burst-3.md') && JSON.stringify(sent) === JSON.stringify(['burst-1.md', 'burst-2.md', 'burst-3.md']),
      `${brief(s2)} sends=${JSON.stringify(sent)}`);
    // same burst, 30 ms apart
    const es = [doc('burst-4.md', 1), doc('burst-5.md', 2), doc('burst-6.md', 3)];
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    await ctx.app.evaluate(({ app: a }, ps) => { ps.forEach((p, i) => setTimeout(() => a.emit('open-file', { preventDefault() {} }, p), i * 30)); return true; }, es.map((d) => d.path));
    const r2 = await waitShows(ctx.app, es[2], 15000);
    await sleep(1200);
    const s3 = await mainSnap(ctx.app);
    check('burst', 'three open-file 30 ms apart with the window closed: one window, last shown', r2.ok && s3.windows === 1 && s3.title?.includes('burst-6.md'), brief(s3));
  } finally { await quit(ctx); }
};

S.sametick = async () => {
  const ctx = await bootReady('sametick');
  try {
    const d = doc('sametick-close-then-open.md', 2);
    await ctx.app.evaluate(({ app: a, BrowserWindow }, p) => { BrowserWindow.getAllWindows()[0].close(); a.emit('open-file', { preventDefault() {} }, p); return true; }, d.path);
    const r = await waitShows(ctx.app, d, 15000);
    check('sametick', 'window.close() then open-file in the same tick: one window showing the file', r.ok, brief(r.s));
    const e = doc('sametick-open-then-close.md', 2);
    await ctx.app.evaluate(({ app: a, BrowserWindow }, p) => { a.emit('open-file', { preventDefault() {} }, p); BrowserWindow.getAllWindows()[0].close(); return true; }, e.path);
    await sleep(2500);
    const s = await mainSnap(ctx.app);
    // informational: the user's own close came after the open, so closing is the plausible outcome; it must not crash or hang.
    check('sametick', 'open-file then window.close() in the same tick: app stays alive (0 or 1 window, no crash)', s.windows === 0 || s.windows === 1, `${brief(s)} (outcome: ${s.windows === 0 ? 'window closed, file not shown' : s.title})`);
    const f = doc('sametick-after.md', 2);
    await emitOpen(ctx.app, f.path);
    const r3 = await waitShows(ctx.app, f, 15000);
    check('sametick', 'a later open-file after that still works', r3.ok, brief(r3.s));
  } finally { await quit(ctx); }
};

S.guards = async () => {
  const TYPED = '新增内容';
  // window close: 取消 / 不保存 / 保存
  for (const answer of ['取消', '不保存', '保存']) {
    const d = doc(`guard-close-${answer}.md`, 2);
    const ctx = await bootReady(`guard-close-${answer}`, [d.path]);
    try {
      await waitShows(ctx.app, d, 15000);
      const page = await livePage(ctx.app);
      await typeEnd(page, TYPED);
      await closeWin(ctx.app);
      await sleep(800);
      const q = await mainSnap(ctx.app);
      const clicked = await clickDialog(ctx.app, answer);
      await sleep(1800);
      const s = await mainSnap(ctx.app);
      const disk = fs.readFileSync(d.path, 'utf8');
      let pass;
      if (answer === '取消') pass = s.windows === 1 && s.text === d.text + TYPED && disk === d.text && s.dialogs.length === 0;
      else if (answer === '不保存') pass = s.windows === 0 && disk === d.text;
      else pass = s.windows === 0 && disk === d.text + TYPED;
      check('guards', `close a dirty file doc → ${answer}`, q.dialogs?.length === 1 && clicked && pass, `question=${JSON.stringify(q.dialogs)} after: ${brief(s)} diskBytes=${Buffer.byteLength(disk)} expected=${Buffer.byteLength(answer === '保存' ? d.text + TYPED : d.text)}`);
      if (s.windows === 0) {
        const n = doc(`guard-close-${answer}-next.md`, 2);
        await emitOpen(ctx.app, n.path);
        const r = await waitShows(ctx.app, n, 15000);
        check('guards', `after closing through ${answer}, the next open-file shows its file`, r.ok, brief(r.s));
      }
    } finally { await quit(ctx); }
  }
  // quit: 取消 / 不保存 / 保存
  for (const answer of ['取消', '不保存', '保存']) {
    const d = doc(`guard-quit-${answer}.md`, 2);
    const ctx = await bootReady(`guard-quit-${answer}`, [d.path]);
    try {
      await waitShows(ctx.app, d, 15000);
      const page = await livePage(ctx.app);
      await typeEnd(page, TYPED);
      const exited = exitPromise(ctx.app);
      await ctx.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; });
      await sleep(900);
      const q = await mainSnap(ctx.app).catch(() => ({ windows: -1 }));
      await clickDialog(ctx.app, answer).catch(() => false);
      const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
      const disk = fs.readFileSync(d.path, 'utf8');
      let pass;
      if (answer === '取消') {
        const s = await mainSnap(ctx.app).catch(() => null);
        pass = !ex && s && s.windows === 1 && s.text === d.text + TYPED && disk === d.text;
        // and a quit after cancel asks again
        if (pass) {
          await ctx.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; });
          await sleep(900);
          const again = await mainSnap(ctx.app).catch(() => null);
          check('guards', 'quit → 取消, then quit again: asked again (not quit silently)', again && again.dialogs?.length === 1, brief(again));
        }
      } else if (answer === '不保存') pass = !!ex && ex.code === 0 && disk === d.text;
      else pass = !!ex && ex.code === 0 && disk === d.text + TYPED;
      check('guards', `app.quit() with a dirty file doc → ${answer}`, q.dialogs?.length === 1 && pass, `question=${JSON.stringify(q.dialogs)} exit=${JSON.stringify(ex)} diskBytes=${Buffer.byteLength(disk)}`);
    } finally { await quit(ctx); }
  }
  // open: 取消 / 丢弃 (and whatever else the guard offers)
  for (const answer of ['取消', '丢弃']) {
    const a1 = doc(`guard-open-${answer}-a.md`, 2);
    const b1 = doc(`guard-open-${answer}-b.md`, 3);
    const ctx = await bootReady(`guard-open-${answer}`, [a1.path]);
    try {
      await waitShows(ctx.app, a1, 15000);
      const page = await livePage(ctx.app);
      await typeEnd(page, TYPED);
      await emitOpen(ctx.app, b1.path);
      await sleep(900);
      const q = await mainSnap(ctx.app);
      await clickDialog(ctx.app, answer);
      await sleep(1500);
      const s = answer === '丢弃' ? (await waitShows(ctx.app, b1, 8000)).s : await mainSnap(ctx.app);
      const diskA = fs.readFileSync(a1.path, 'utf8');
      const pass = answer === '取消'
        ? s.title?.includes(a1.name) && s.text === a1.text + TYPED && diskA === a1.text
        : s.title?.includes(b1.name) && s.text === b1.text && diskA === a1.text;
      check('guards', `dirty doc + open-file → ${answer}`, q.dialogs?.length === 1 && pass, `question=${JSON.stringify(q.dialogs)} after: ${brief(s)} diskA unchanged=${diskA === a1.text}`);
    } finally { await quit(ctx); }
  }
};

S.quit = async () => {
  const d = doc('quit-clean.md', 2);
  const ctx = await bootReady('quit-clean', [d.path]);
  try {
    await waitShows(ctx.app, d, 15000);
    const exited = exitPromise(ctx.app);
    await ctx.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; });
    const ex = await Promise.race([exited, sleep(8000).then(() => null)]);
    check('quit', 'app.quit() with a clean document exits at once with code 0, no question', !!ex && ex.code === 0, JSON.stringify(ex));
  } finally { await quit(ctx); }
  const ctx2 = await bootReady('quit-windowless');
  try {
    await closeWin(ctx2.app);
    await waitWindows(ctx2.app, 0, 6000);
    const exited = exitPromise(ctx2.app);
    await ctx2.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; });
    const ex = await Promise.race([exited, sleep(8000).then(() => null)]);
    check('quit', 'app.quit() with no window exits with code 0', !!ex && ex.code === 0, JSON.stringify(ex));
  } finally { await quit(ctx2); }
};

S.second = async () => {
  const ctx = await bootReady('second');
  try {
    const exe = await ctx.app.evaluate(() => process.execPath);
    const d1 = doc('second-open-file.md', 2);
    await ctx.app.evaluate(({ app: a }, [x, p]) => { a.emit('second-instance', {}, [x, p], '/'); return true; }, [exe, d1.path]);
    let r = await waitShows(ctx.app, d1, 12000);
    check('second', 'second-instance WITH a file, window open: shown in the one window', r.ok, brief(r.s));
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(600);
    await ctx.app.evaluate(({ app: a }, x) => { a.emit('second-instance', {}, [x], '/'); return true; }, exe);
    await sleep(1500);
    let s = await mainSnap(ctx.app);
    check('second', 'second-instance WITHOUT a file, window open (minimised): same doc, window restored, still 1 window', s.windows === 1 && s.title?.includes(d1.name) && !s.minimized && s.visible, brief(s) + ` minimized=${s.minimized}`);
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    const d2 = doc('second-closed-file.md', 3);
    await ctx.app.evaluate(({ app: a }, [x, p]) => { a.emit('second-instance', {}, [x, p], '/'); return true; }, [exe, d2.path]);
    r = await waitShows(ctx.app, d2, 15000);
    check('second', 'second-instance WITH a file, window closed: a window shows the file', r.ok, brief(r.s));
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    await ctx.app.evaluate(({ app: a }, x) => { a.emit('second-instance', {}, [x], '/'); return true; }, exe);
    s = await waitReadyWindow(ctx.app, 12000);
    check('second', 'second-instance WITHOUT a file, window closed: one (untitled) window comes up', !!s && s.windows === 1 && s.title.includes('未命名'), brief(s));
    // relative path with a working directory
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    const d3 = doc('second-relative.md', 2);
    await ctx.app.evaluate(({ app: a }, [x, cwd]) => { a.emit('second-instance', {}, [x, 'second-relative.md'], cwd); return true; }, [exe, TMP]);
    r = await waitShows(ctx.app, d3, 15000);
    check('second', 'second-instance with a RELATIVE path + working directory, window closed: shown', r.ok, brief(r.s));
    const sent = await sends(ctx.app);
    check('second', 'no open-file sent twice for one second-instance', new Set(sent).size === sent.length, JSON.stringify(sent));
  } finally { await quit(ctx); }
};

S.minimized = async () => {
  const ctx = await bootReady('minimized');
  try {
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(800);
    const d = doc('minimized.md', 2);
    await emitOpen(ctx.app, d.path);
    const r = await waitShows(ctx.app, d, 12000);
    check('minimized', 'minimised window + open-file: shown, window restored', r.ok && !r.s.minimized && r.s.visible, `${brief(r.s)} minimized=${r.s?.minimized} visible=${r.s?.visible}`);
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await sleep(500);
    const e = doc('win-hidden.md', 2);
    await emitOpen(ctx.app, e.path);
    const r2 = await waitShows(ctx.app, e, 12000);
    check('minimized', 'win.hide() + open-file: shown and visible again', r2.ok && r2.s.visible, `${brief(r2.s)} visible=${r2.s?.visible}`);
  } finally { await quit(ctx); }
};

S.hidden = async () => {
  const ctx = await bootReady('hidden');
  try {
    await ctx.app.evaluate(({ app: a }) => a.hide());
    await sleep(800);
    const h0 = await ctx.app.evaluate(({ app: a }) => a.isHidden());
    const d = doc('app-hidden.md', 2);
    await emitOpen(ctx.app, d.path);
    const r = await waitShows(ctx.app, d, 12000);
    check('hidden', 'app.hide() (⌘H) + open-file: the document is loaded into the window', r.ok, `${brief(r.s)} hiddenBefore=${h0} hiddenAfter=${r.s?.hidden} visible=${r.s?.visible}`);
    check('hidden', 'app.hide() + open-file: the app is un-hidden / window visible afterwards', r.s && r.s.hidden === false && r.s.visible, `hiddenAfter=${r.s?.hidden} visible=${r.s?.visible}`);
    // hidden AND window closed
    await ctx.app.evaluate(({ app: a }) => a.show());
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await ctx.app.evaluate(({ app: a }) => a.hide());
    await sleep(600);
    const e = doc('app-hidden-closed.md', 2);
    await emitOpen(ctx.app, e.path);
    const r2 = await waitShows(ctx.app, e, 15000);
    check('hidden', 'window closed + app hidden + open-file: a window shows the file', r2.ok, `${brief(r2.s)} hidden=${r2.s?.hidden}`);
  } finally { await quit(ctx); }
};

// Renderer crash, read through the main process (a Playwright page object goes stale after a crash).
S.crash = async () => {
  const a1 = doc('crash-a.md', 2);
  const ctx = await bootReady('crash', [a1.path]);
  try {
    await waitShows(ctx.app, a1, 15000);
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await sleep(1500);
    const b1 = doc('crash-b.md', 3);
    await emitOpen(ctx.app, b1.path);
    const r = await waitShows(ctx.app, b1, 15000);
    check('crash', 'renderer crash, then open-file: the window reloads and shows the new file', r.ok, brief(r.s));
    // dirty document, then a crash: is the typed text offered back?
    // the Playwright page object stays "crashed" after the reload: type through the main process
    const TYPED = '崩溃前输入';
    await ctx.app.evaluate(async ({ BrowserWindow }, t) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.focus();
      await w.webContents.executeJavaScript(`(() => { document.querySelector('.cm-content').focus(); return true; })()`);
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['meta'] });
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['meta'] });
      await new Promise((r) => setTimeout(r, 150));
      await w.webContents.insertText(t);
      return true;
    }, TYPED);
    await sleep(400);
    const typed = await mainSnap(ctx.app);
    check('crash', 'typing after the crash reload reaches the editor (document dirty)', typed.text?.includes(TYPED) && (typed.title?.startsWith('●') || typed.edited), brief(typed));
    await sleep(2500); // draft autosave
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await sleep(3000);
    const s = await waitReadyWindow(ctx.app, 12000);
    await sleep(1500);
    const s2 = await mainSnap(ctx.app);
    check('crash', 'dirty document + renderer crash: window comes back (1 window, not crashed)', s2.windows === 1 && !s2.loading, brief(s2));
    note('crash', `after a dirty crash the reloaded window shows title=${JSON.stringify(s2.title)} len=${s2.text?.length} toasts=${JSON.stringify(s2.toasts)} (typed text present=${!!s2.text?.includes(TYPED)})`);
    void s;
    // reopen the dirty file: is the draft offered?
    await emitOpen(ctx.app, b1.path);
    await sleep(2500);
    const s3 = await mainSnap(ctx.app);
    const offered = (s3.toasts || []).some((t) => t.includes('草稿')) || !!s3.text?.includes(TYPED);
    check('crash', 'dirty document + renderer crash: the unsaved text is recoverable (draft offered or still shown)', offered, `${brief(s3)} toasts=${JSON.stringify(s3.toasts)}`);
  } finally { await quit(ctx); }
};
function note(section, s) { console.log(`note [${section}] ${s}`); }
// (final:verify-behaviour#1) machine-readable per-case record for the hotfix-vs-0.1.0 differential:
// what the editor shows (length + sha256), title, visible toasts / dialogs, native boxes, disk bytes.
const sha = (x) => (x == null ? null : crypto.createHash('sha256').update(x).digest('hex').slice(0, 16));
async function dump(ctx, section, name, s, extra = {}) {
  const boxes = await ctx.app.evaluate(() => (globalThis.__boxes || []).slice()).catch(() => null);
  console.log(`DUMP ${JSON.stringify({ section, name, title: s?.title ?? null, len: s?.text?.length ?? null, sha: sha(s?.text ?? null), toasts: s?.toasts ?? null, dialogs: s?.dialogs ?? null, boxes, ...extra })}`);
}
const diskRec = (p) => { try { const b = fs.readFileSync(p); return { diskLen: b.length, diskSha: sha(b) }; } catch (e) { return { diskErr: e.code }; } };
/** Record (instead of showing) native message boxes — e.g. a lenient-decode warning. */
const stubBoxes = (app) => app.evaluate(({ dialog }) => { globalThis.__boxes = []; dialog.showMessageBox = (...a) => { globalThis.__boxes.push(String((a.find((x) => x && x.message) || {}).message)); return Promise.resolve({ response: 0 }); }; return true; });

/** open → type `add` at the end → 保存; returns the disk bytes. */
async function editSave(ctx, p, name, add) {
  await emitOpen(ctx.app, p);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const s = await mainSnap(ctx.app); if (s.title?.includes(name) && !s.loading) break; await sleep(150); }
  await sleep(400);
  const shown = await mainSnap(ctx.app);
  const page = await livePage(ctx.app);
  await typeEnd(page, add);
  await menuClick(ctx.app, 'file.save');
  const saved = await waitTitleNotDirty(ctx.app, 8000);
  const after = await mainSnap(ctx.app);
  await dump(ctx, 'files', name, shown, { saved, afterTitle: after?.title ?? null, afterToasts: after?.toasts ?? null, ...diskRec(p) });
  return { saved, bytes: fs.readFileSync(p) };
}
async function resetClean(ctx) {
  // load a throwaway clean doc so the next open has no guard
  const s = await mainSnap(ctx.app);
  if (s.title?.startsWith('●') || s.edited) { await menuClick(ctx.app, 'file.save'); await waitTitleNotDirty(ctx.app, 4000); }
}

S.files = async () => {
  const ctx = await bootReady('files');
  await stubBoxes(ctx.app);
  try {
    const cases = [
      ['lf-trailing.md', Buffer.from('# LF\n\n第一段。\n第二段。\n', 'utf8')],
      ['lf-no-trailing.md', Buffer.from('# 无尾换行\n\n最后一行没有换行', 'utf8')],
      ['crlf.md', Buffer.from('# CRLF\r\n\r\n一行。\r\n二行。\r\n', 'utf8')],
      ['crlf-no-trailing.md', Buffer.from('# CRLF\r\n\r\n无尾', 'utf8')],
      ['bom-utf8.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM\n\n正文\n', 'utf8')])],
      ['emoji.md', Buffer.from('# 表情 😀\n\n中文、emoji 😀🎉、тест\n', 'utf8')],
    ];
    for (const [name, before] of cases) {
      const p = path.join(TMP, name);
      fs.writeFileSync(p, before);
      const r = await editSave(ctx, p, name, 'X');
      const expected = Buffer.concat([before, Buffer.from('X')]);
      check('files', `${name}: 保存 writes back the exact bytes (+ the typed X, own EOL/BOM)`, r.saved && r.bytes.equals(expected), `saved=${r.saved} disk ${r.bytes.length} B vs expected ${expected.length} B`);
    }
    const iconv = (t, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(t, 'utf8') });
    const encs = [
      ['gbk.md', 'GBK', '# 中文标题\n\n内容，简体中文的段落。\n'],
      ['gb18030.md', 'GB18030', '# 标题\n\n这是简体中文的内容。\n'],
      ['big5.md', 'BIG5', '# 標題\n\n這是繁體中文的內容，請不要變成亂碼。\n'],
      ['sjis.md', 'SHIFT_JIS', '# 見出し\n\nこれは日本語の文章です。\n'],
      ['euckr.md', 'EUC-KR', '# 제목\n\n이것은 한국어 문서입니다.\n'],
    ];
    for (const [name, enc, text] of encs) {
      const p = path.join(TMP, name);
      const before = iconv(text, enc);
      fs.writeFileSync(p, before);
      await emitOpen(ctx.app, p);
      let shown = null;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { shown = await mainSnap(ctx.app); if (shown.title?.includes(name) && !shown.loading) break; await sleep(150); }
      await sleep(300);
      shown = await mainSnap(ctx.app);
      const textOk = shown.text === text;
      const r = await editSave(ctx, p, name, '!');
      const expected = Buffer.concat([before, Buffer.from('!')]);
      check('files', `${name} (${enc}): shown as its real text and round-trips in ${enc} after edit + 保存`, textOk && r.saved && r.bytes.equals(expected), `shownExact=${textOk} saved=${r.saved} disk ${r.bytes.length} B vs ${expected.length} B equal=${r.bytes.equals(expected)}`);
      await resetClean(ctx);
    }
    // symlink
    const realDir = path.join(TMP, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    const target = path.join(realDir, 'target.md');
    fs.writeFileSync(target, '# 符号链接目标\n\n原始\n');
    const link = path.join(TMP, 'link.md');
    fs.symlinkSync(target, link);
    const rl = await editSave(ctx, link, 'link.md', 'S');
    const still = fs.lstatSync(link).isSymbolicLink();
    check('files', '保存 through a symlink keeps the symlink and updates the target', rl.saved && still && fs.readFileSync(target, 'utf8') === '# 符号链接目标\n\n原始\nS', `saved=${rl.saved} stillSymlink=${still}`);
    // hard link
    const ha = path.join(TMP, 'hardA.md');
    const hb = path.join(TMP, 'hardB.md');
    fs.writeFileSync(ha, '# 硬链接\n\n原始\n');
    fs.linkSync(ha, hb);
    const ino = fs.statSync(ha).ino;
    const rh = await editSave(ctx, ha, 'hardA.md', 'H');
    check('files', '保存 keeps the inode (hard links stay joined)', rh.saved && fs.statSync(ha).ino === ino && fs.readFileSync(hb, 'utf8').endsWith('H'), `saved=${rh.saved} sameInode=${fs.statSync(ha).ino === ino}`);
    // mtime conflict
    const race = path.join(TMP, 'race.md');
    fs.writeFileSync(race, '# 竞争\n\n我的版本\n');
    await emitOpen(ctx.app, race);
    { const dl = Date.now() + 8000; while (Date.now() < dl) { const s = await mainSnap(ctx.app); if (s.title?.includes('race.md')) break; await sleep(150); } }
    await sleep(1200);
    const theirs = '# 竞争\n\n别的程序写入的版本，绝对不能丢\n';
    fs.writeFileSync(race, theirs);
    const page = await livePage(ctx.app);
    await typeEnd(page, 'R');
    await menuClick(ctx.app, 'file.save');
    await sleep(1800);
    const sC = await mainSnap(ctx.app);
    const diskC = fs.readFileSync(race, 'utf8');
    await dump(ctx, 'files', 'race.md(conflict)', sC, diskRec(race));
    const prompted = (sC.toasts || []).some((t) => t.includes('其他程序修改')) || (sC.dialogs || []).length > 0;
    check('files', 'mtime conflict: another program changed the file → 保存 is refused with a prompt, their text kept', diskC === theirs && prompted && (sC.title?.startsWith('●') || sC.edited), `diskKeptTheirs=${diskC === theirs} prompt=${prompted} toasts=${JSON.stringify(sC.toasts)} dialogs=${JSON.stringify(sC.dialogs)} stillDirty=${sC.title?.startsWith('●') || sC.edited}`);
    await menuClick(ctx.app, 'file.save');
    await waitTitleNotDirty(ctx.app, 6000);
    const diskC2 = fs.readFileSync(race, 'utf8');
    await dump(ctx, 'files', 'race.md(insist)', await mainSnap(ctx.app), diskRec(race));
    check('files', 'mtime conflict: a second 保存 (user insists) writes the editor text', diskC2 === '# 竞争\n\n我的版本\nR', `bytes=${Buffer.byteLength(diskC2)}`);
  } finally { await quit(ctx); }
};

/** Encoding edge cases that the new fileIO decode heuristics could REGRESS (were fine in 0.1.0). */
S.enc = async () => {
  const ctx = await bootReady('enc');
  await stubBoxes(ctx.app);
  try {
    const ansiLine = '\u001b[32m✓\u001b[0m test passed \u001b[2m(3 ms)\u001b[0m';
    const ansi = `# 测试日志\n\n\`\`\`\n${Array.from({ length: 30 }, () => ansiLine).join('\n')}\n\`\`\`\n`;
    const ff = '# 分页\n\n第一页\n\f\n第二页\n\f\n第三页\n';
    const latin1 = Buffer.from('# Über élan\n\nfaçade Zürich, naïve café.\n', 'latin1');
    const cp1252 = Buffer.from([...Buffer.from('# Quote \x93smart\x94 \x96 dash\n\nCaf', 'latin1'), 0xe9, 0x0a]);
    const zhAscii = '# English title\n\nMostly ASCII with one 中文 word.\n';
    const utf8Bad = Buffer.concat([Buffer.from('# 标题\n\n这是一个中文段落，', 'utf8'), Buffer.from([0xff]), Buffer.from('后面还有内容。\n', 'utf8')]);
    const cases = [
      ['ansi-log.md', Buffer.from(ansi, 'utf8'), ansi],
      ['formfeed.md', Buffer.from(ff, 'utf8'), ff],
      ['latin1.md', latin1, '# Über élan\n\nfaçade Zürich, naïve café.\n'],
      ['cp1252.md', cp1252, '# Quote “smart” – dash\n\nCafé\n'],
      ['ascii-zh.md', Buffer.from(zhAscii, 'utf8'), zhAscii],
      ['utf8-one-bad-byte.md', utf8Bad, null],
      ['utf16le-nobom.md', Buffer.from('# Title\n\nUTF-16 文本\n', 'utf16le'), '# Title\n\nUTF-16 文本\n'],
    ];
    for (const [name, bytes, expected] of cases) {
      const p = path.join(TMP, name);
      fs.writeFileSync(p, bytes);
      await emitOpen(ctx.app, p);
      let s = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) { s = await mainSnap(ctx.app); if (s.title?.includes(name) || (s.toasts || []).some((t) => t.includes('失败'))) break; await sleep(150); }
      await sleep(500);
      s = await mainSnap(ctx.app);
      const boxes = await ctx.app.evaluate(() => globalThis.__boxes.length);
      await dump(ctx, 'enc', name, s, diskRec(p));
      const ok = expected === null ? s.title?.includes(name) && s.text.includes('后面还有内容') && s.text.includes('�') : s.title?.includes(name) && s.text === expected;
      check('enc', `${name}: opened and shown as its real text`, ok, `title=${JSON.stringify(s.title)} len=${s.text?.length} toasts=${JSON.stringify(s.toasts)}`);
      // close any native warning box (lenient UTF-8) — it is non-blocking for the renderer
      void boxes;
    }
  } finally { await quit(ctx); }
};

// ------------------------------------------------------------------------------------------ round-2 sections
// Added by verify:behaviour#2 (2026-11-20) for the fix:round2 changes: documents held while the dirty-close
// question is up, crash restore, crashes during a question, the windowless 新建 / 打开… menu, reloads.

/** Wait until the one window's page has subscribed (title present, not loading). */
async function waitTitle(app, frag, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let s = null;
  while (Date.now() < deadline) {
    s = await mainSnap(app).catch(() => s);
    if (s && s.windows === 1 && !s.loading && s.title?.includes(frag)) return { ok: true, s };
    await sleep(150);
  }
  return { ok: false, s };
}
/** Type through the main process (Playwright page objects go stale across crashes / reloads). */
async function typeMain(app, t) {
  await app.evaluate(async ({ BrowserWindow }, txt) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    w.webContents.focus();
    await w.webContents.executeJavaScript(`(() => { document.querySelector('.cm-content').focus(); return true; })()`);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['meta'] });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['meta'] });
    await new Promise((r) => setTimeout(r, 150));
    await w.webContents.insertText(txt);
    return true;
  }, t);
  await sleep(400);
}
const crashNow = (app) => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()); w.webContents.forcefullyCrashRenderer(); return true; });

// The dirty-close question is up when a document is double-clicked (held back by the shell).
S.heldclose = async () => {
  const TYPED = '关闭前输入';
  for (const answer of ['取消', '不保存', '保存']) {
    const a1 = doc(`held-${answer}-a.md`, 2);
    const b1 = doc(`held-${answer}-b.md`, 3);
    const ctx = await bootReady(`held-${answer}`, [a1.path]);
    try {
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, TYPED);
      await closeWin(ctx.app);
      await sleep(800);
      const q = await mainSnap(ctx.app);
      await emitOpen(ctx.app, b1.path);
      await sleep(900);
      const mid = await mainSnap(ctx.app);
      await clickDialog(ctx.app, answer);
      await sleep(1500);
      let s = await mainSnap(ctx.app);
      let extra = '';
      if (answer === '取消') {
        // the held document reaches the same (still dirty) renderer: its own discard guard asks now
        const guard = s.dialogs?.length === 1 ? s.dialogs[0] : null;
        if (guard) { await clickDialog(ctx.app, '丢弃'); extra = ` guard=${guard}`; }
        s = (await waitShows(ctx.app, b1, 10000)).s;
      } else {
        s = (await waitShows(ctx.app, b1, 15000)).s;
      }
      const diskA = fs.readFileSync(a1.path, 'utf8');
      const diskOk = answer === '保存' ? diskA === a1.text + TYPED : diskA === a1.text;
      const shown = s && s.windows === 1 && s.title?.includes(b1.name) && s.text === b1.text;
      check('heldclose', `dirty close question up + open-file(b) → ${answer}: b ends up shown, one modal at a time, a.md bytes right`,
        q.dialogs?.length === 1 && mid.dialogs?.length === 1 && shown && diskOk,
        `question=${JSON.stringify(q.dialogs)} duringOpen=${JSON.stringify(mid.dialogs)}${extra} after: ${brief(s)} diskA ${Buffer.byteLength(diskA)} B ok=${diskOk}`);
    } finally { await quit(ctx); }
  }
  // the question came from quit: 取消 → the held document is delivered; 不保存 → the app quits (documented exception)
  for (const answer of ['取消', '不保存']) {
    const a1 = doc(`heldquit-${answer}-a.md`, 2);
    const b1 = doc(`heldquit-${answer}-b.md`, 3);
    const ctx = await bootReady(`heldquit-${answer}`, [a1.path]);
    try {
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, TYPED);
      const exited = exitPromise(ctx.app);
      await ctx.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; });
      await sleep(900);
      const q = await mainSnap(ctx.app).catch(() => ({}));
      await emitOpen(ctx.app, b1.path);
      await sleep(900);
      const mid = await mainSnap(ctx.app).catch(() => ({}));
      await clickDialog(ctx.app, answer).catch(() => false);
      if (answer === '取消') {
        await sleep(1200);
        let s = await mainSnap(ctx.app);
        const guard = s.dialogs?.length === 1 ? s.dialogs[0] : null;
        if (guard) await clickDialog(ctx.app, '丢弃');
        s = (await waitShows(ctx.app, b1, 10000)).s;
        check('heldquit', 'dirty quit question up + open-file(b) → 取消: app stays, b ends up shown', !!s?.title?.includes(b1.name) && s.text === b1.text && mid.dialogs?.length === 1,
          `question=${JSON.stringify(q.dialogs)} duringOpen=${JSON.stringify(mid.dialogs)} guard=${guard} after: ${brief(s)}`);
      } else {
        const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
        const diskA = fs.readFileSync(a1.path, 'utf8');
        check('heldquit', 'dirty quit question up + open-file(b) → 不保存: app exits 0, a.md untouched (b not shown — documented quit exception)', !!ex && ex.code === 0 && diskA === a1.text,
          `question=${JSON.stringify(q.dialogs)} duringOpen=${JSON.stringify(mid.dialogs)} exit=${JSON.stringify(ex)}`);
      }
    } finally { await quit(ctx); }
  }
};

// Renderer crashes while a dirty-close / dirty-quit question is up, then a document is double-clicked.
S.crashq = async () => {
  for (const via of ['close', 'quit']) {
    const a1 = doc(`crashq-${via}-a.md`, 2);
    const b1 = doc(`crashq-${via}-b.md`, 3);
    const ctx = await bootReady(`crashq-${via}`, [a1.path]);
    try {
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, '崩溃前');
      if (via === 'close') await closeWin(ctx.app);
      else await ctx.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; });
      await sleep(900);
      const q = await mainSnap(ctx.app).catch(() => ({}));
      await crashNow(ctx.app);
      await sleep(2500);
      const after = await mainSnap(ctx.app).catch(() => ({ windows: -1 }));
      const crashed = await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()); return w ? w.webContents.isCrashed() : null; }).catch(() => 'err');
      await emitOpen(ctx.app, b1.path);
      const r = await waitShows(ctx.app, b1, 12000);
      const diskA = fs.readFileSync(a1.path, 'utf8');
      check('crashq', `dirty ${via} question up, renderer crashes, then open-file(b): b is shown`, q.dialogs?.length === 1 && r.ok && diskA === a1.text,
        `question=${JSON.stringify(q.dialogs)} afterCrash: ${brief(after)} loading=${after.loading} isCrashed=${crashed} → after open: ${brief(r.s)} loading=${r.s?.loading}`);
      if (!r.ok) {
        // recovery path the user would try: close the window, double-click again
        await closeWin(ctx.app);
        await waitWindows(ctx.app, 0, 6000);
        await sleep(300);
        await emitOpen(ctx.app, b1.path);
        const r2 = await waitShows(ctx.app, b1, 12000);
        note('crashq', `${via}: after closing the dead window and opening b again: shown=${r2.ok} ${brief(r2.s)}`);
      }
    } finally { await quit(ctx); }
  }
};

// Three crashes inside a minute: the window is given up; the next open-file starts fresh.
S.crash3 = async () => {
  const a1 = doc('crash3-a.md', 2);
  const ctx = await bootReady('crash3', [a1.path]);
  try {
    await waitShows(ctx.app, a1, 15000);
    await ctx.app.evaluate(({ dialog }) => { globalThis.__boxes = []; const orig = dialog.showMessageBox; dialog.showMessageBox = (...a) => { globalThis.__boxes.push(String((a.find((x) => x && x.message) || {}).message)); return Promise.resolve({ response: 0 }); }; void orig; return true; });
    const seen = [];
    for (let i = 1; i <= 3; i++) {
      await crashNow(ctx.app).catch(() => false);
      await sleep(i < 3 ? 3500 : 2000);
      const s = await mainSnap(ctx.app).catch(() => ({ windows: -1 }));
      seen.push(`#${i}:${s.windows}${s.title ? `/${s.title}` : ''}`);
    }
    const w = await winCount(ctx.app);
    const boxes = await ctx.app.evaluate(() => globalThis.__boxes);
    const b1 = doc('crash3-b.md', 3);
    await emitOpen(ctx.app, b1.path);
    const r = await waitShows(ctx.app, b1, 15000);
    check('crash3', '3 renderer crashes: window given up with a message; the next open-file shows its file', w === 0 && boxes.length === 1 && r.ok,
      `after each crash ${seen.join(' ')}; windows=${w} boxes=${JSON.stringify(boxes)} → ${brief(r.s)}`);
  } finally { await quit(ctx); }
};

// Crash restore: the document on screen when the renderer died is reopened; a crash while untitled.
S.crashrestore = async () => {
  const a1 = doc('restore-a.md', 2);
  const ctx = await bootReady('restore', [a1.path]);
  try {
    await waitShows(ctx.app, a1, 15000);
    // a parentless dialog.showMessageBox (3rd crash in a minute) runs app-modal on macOS and blocks the
    // main process until answered: record it instead, so the section cannot hang on an unseen alert.
    await ctx.app.evaluate(({ dialog }) => { globalThis.__boxes = []; dialog.showMessageBox = (...a) => { globalThis.__boxes.push(String((a.find((x) => x && x.message) || {}).message)); return Promise.resolve({ response: 0 }); }; return true; });
    await crashNow(ctx.app);
    const r = await waitShows(ctx.app, a1, 15000);
    check('crashrestore', 'clean doc + renderer crash: the reloaded window shows the same document again', r.ok, brief(r.s));
    // crash, then the window is closed before the reload finished: restore withdrawn, next open is just b
    const nBefore = (await sends(ctx.app)).length;
    await crashNow(ctx.app);
    await sleep(50);
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(500);
    const b1 = doc('restore-b.md', 3);
    await emitOpen(ctx.app, b1.path);
    const r2 = await waitShows(ctx.app, b1, 15000);
    await sleep(1200);
    const tailSends = (await sends(ctx.app)).slice(nBefore);
    check('crashrestore', 'crash then close at once, then open-file(b): b shown, the crashed doc not re-sent into the new window', r2.ok && JSON.stringify(tailSends) === '["restore-b.md"]',
      `${brief(r2.s)} sendsSinceCrash=${JSON.stringify(tailSends)}`);
    // crash, then open-file(b) during the reload: b ends on screen (restore first, newest last)
    await sleep(61000); // out of the 3-crashes-per-minute window
    await crashNow(ctx.app);
    await sleep(30);
    const c1 = doc('restore-c.md', 2);
    await emitOpen(ctx.app, c1.path);
    const r3 = await waitShows(ctx.app, c1, 15000);
    await sleep(1500);
    const s3 = await mainSnap(ctx.app);
    const boxes = await ctx.app.evaluate(() => globalThis.__boxes);
    check('crashrestore', 'crash showing b, open-file(c) 30 ms later: c is what ends on screen', r3.ok && s3.title?.includes(c1.name) && boxes.length === 0, `${brief(s3)} boxes=${JSON.stringify(boxes)}`);
  } finally { await quit(ctx); }
};

// Windowless 文件 → 新建 / 打开… (and ⌘N / ⌘O via the rebuilt menu)
S.windowless = async () => {
  const ctx = await bootReady('windowless');
  try {
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(500);
    const acc = await ctx.app.evaluate(({ Menu }) => { const m = Menu.getApplicationMenu(); const n = m.getMenuItemById('file.new'); const o = m.getMenuItemById('file.open'); return { n: n?.registerAccelerator, o: o?.registerAccelerator, nAcc: n?.accelerator, oAcc: o?.accelerator }; });
    const clickedNew = await menuClick(ctx.app, 'file.new');
    const s = await waitReadyWindow(ctx.app, 12000);
    check('windowless', 'no window, 文件 → 新建: an untitled window comes up', clickedNew && !!s && s.windows === 1 && s.title.includes('未命名'), `${brief(s)} accel=${JSON.stringify(acc)}`);
    // the window is back: menu accelerators back to renderer-bound (else ⌘N fires twice)
    await sleep(600);
    const acc2 = await ctx.app.evaluate(({ Menu }) => { const m = Menu.getApplicationMenu(); return { n: m.getMenuItemById('file.new')?.registerAccelerator, o: m.getMenuItemById('file.open')?.registerAccelerator }; });
    // file.new is RENDERER_UNBOUND in menu.mjs: the menu always owns ⌘N; ⌘O is the renderer's again with a window.
    check('windowless', 'with a window again ⌘O is renderer-bound again (registerAccelerator false; ⌘N stays menu-owned)', acc2.n === true && acc2.o === false && acc.n === true && acc.o === true, `windowless=${JSON.stringify(acc)} withWindow=${JSON.stringify(acc2)}`);
    // 打开… with no window: stub the native open panel to return b
    const b1 = doc('windowless-open.md', 3);
    await ctx.app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); return true; }, b1.path);
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(500);
    const clickedOpen = await menuClick(ctx.app, 'file.open');
    const r = await waitShows(ctx.app, b1, 15000);
    check('windowless', 'no window, 文件 → 打开… (panel answered with b): a window shows b', clickedOpen && r.ok, brief(r.s));
    // other commands with no window are ignored and do not create a window
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    const clickedSave = await menuClick(ctx.app, 'file.save');
    await sleep(1500);
    const w = await winCount(ctx.app);
    check('windowless', 'no window, 文件 → 保存: nothing happens, no crash, no window', w === 0, `clicked=${clickedSave} windows=${w}`);
    // then a double-click still works and is not followed by a stale 保存 / 打开 command
    const c1 = doc('windowless-after.md', 2);
    await emitOpen(ctx.app, c1.path);
    const r2 = await waitShows(ctx.app, c1, 15000);
    await sleep(1200);
    const cmds = await ctx.app.evaluate(() => globalThis.__sends.filter((x) => x.ch === 'mdr:command').map((x) => x.arg));
    check('windowless', 'after that an open-file shows its file; no stale command sent (file.save never sent)', r2.ok && !cmds.includes('file.save'), `${brief(r2.s)} commands=${JSON.stringify(cmds)}`);
  } finally { await quit(ctx); }
};

// Reload / loading-window races and duplicate deliveries.
S.races = async () => {
  const ctx = await bootReady('races');
  try {
    const a1 = doc('race-reload.md', 2);
    await ctx.app.evaluate(({ BrowserWindow, app: a }, p) => { BrowserWindow.getAllWindows()[0].webContents.reload(); setTimeout(() => a.emit('open-file', { preventDefault() {} }, p), 30); return true; }, a1.path);
    let r = await waitShows(ctx.app, a1, 15000);
    check('races', 'webContents.reload(), open-file 30 ms later: shown after the reload', r.ok, brief(r.s));
    // same path twice while closed: delivered once
    const b1 = doc('race-dup.md', 2);
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    const before = (await sends(ctx.app)).length;
    await ctx.app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p); a.emit('open-file', { preventDefault() {} }, p); return true; }, b1.path);
    r = await waitShows(ctx.app, b1, 15000);
    await sleep(1000);
    const dupSends = (await sends(ctx.app)).slice(before);
    check('races', 'the same path twice in one tick with the window closed: shown, sent once', r.ok && dupSends.length === 1, `${brief(r.s)} sends=${JSON.stringify(dupSends)}`);
    // window closed while it is still loading the double-clicked file: what does the next Dock click show?
    const c1 = doc('race-close-loading.md', 2);
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    await ctx.app.evaluate(({ app: a, BrowserWindow }, p) => { a.emit('open-file', { preventDefault() {} }, p); setTimeout(() => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.close(); }, 40); return true; }, c1.path);
    await sleep(1500);
    const w0 = await winCount(ctx.app);
    await ctx.app.evaluate(({ app: a }) => { a.emit('activate'); return true; });
    const sA = await waitReadyWindow(ctx.app, 12000);
    await sleep(1500);
    const sA2 = await mainSnap(ctx.app);
    note('races', `open-file then close 40 ms later (loading window): windows=${w0}; next Dock click shows ${brief(sA2)} (pending path kept=${!!sA2.title?.includes(c1.name)})`);
    check('races', 'closing a loading window does not lose or hang anything: the next Dock click brings one working window', !!sA && sA2.windows === 1 && !sA2.loading, brief(sA2));
    // nonexistent path while closed: a window with an error, and the next open works
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await sleep(300);
    await emitOpen(ctx.app, path.join(TMP, 'does-not-exist.md'));
    await sleep(2500);
    const sm = await mainSnap(ctx.app);
    const d1 = doc('race-after-missing.md', 2);
    await emitOpen(ctx.app, d1.path);
    r = await waitShows(ctx.app, d1, 12000);
    check('races', 'missing file with the window closed → a window with an error; the next open-file shows its file', sm.windows === 1 && r.ok, `missing: ${brief(sm)} toasts=${JSON.stringify(sm.toasts)} → ${brief(r.s)}`);
  } finally { await quit(ctx); }
};

// Big legacy-encoded / almost-UTF-8 files: the new scoring must not make opening slow (0.1.0 baseline: run with MDR_EXE=installed).
S.perf = async () => {
  const ctx = await bootReady('perf');
  try {
    const para = '这是一个用于测试的中文段落，包含常见的汉字和标点符号。我们需要确保打开大文件时不会变慢。\n\n';
    const big = `# 大文件\n\n${para.repeat(Math.ceil(12_000_000 / Buffer.byteLength(para, 'utf8')))}`;
    const gbk = execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', 'GBK'], { input: Buffer.from(big, 'utf8'), maxBuffer: 64 << 20 });
    const utf8Bad = Buffer.concat([Buffer.from(big, 'utf8'), Buffer.from([0xff, 0x0a])]);
    const cases = [['perf-gbk-8mb.md', gbk], ['perf-utf8-12mb-onebad.md', utf8Bad], ['perf-utf8-12mb.md', Buffer.from(big, 'utf8')]];
    for (const [name, bytes] of cases) {
      const p = path.join(TMP, name);
      fs.writeFileSync(p, bytes);
      const t = await ctx.app.evaluate(async ({ BrowserWindow }, fp) => {
        const w = BrowserWindow.getAllWindows()[0];
        const t0 = Date.now();
        await w.webContents.executeJavaScript(`window.mdrNative.readFile(${JSON.stringify(fp)}).then((r) => r.text.length, () => -1)`);
        return Date.now() - t0;
      }, p);
      const t0 = Date.now();
      await emitOpen(ctx.app, p);
      const rr = await waitTitle(ctx.app, name, 40000);
      const ms = Date.now() - t0;
      check('perf', `${name} (${(bytes.length / 1e6).toFixed(1)} MB): readFile ${t} ms; open-file until title ${ms} ms`, rr.ok, `len=${rr.s?.text?.length}`);
      await sleep(800);
    }
  } finally { await quit(ctx); }
};

// Damaged / mixed legacy files where the new decoder REFUSES (empty 未命名 + toast) what 0.1.0 showed.
// Informational per case (prints what is shown); run with the installed exe as well to compare.
S.enc2 = async () => {
  const ctx = await bootReady('enc2');
  await stubBoxes(ctx.app);
  try {
    const iconv = (t, to) => execFileSync('/usr/bin/iconv', ['-f', 'UTF-8', '-t', to], { input: Buffer.from(t, 'utf8') });
    const zh = '# 会议纪要\n\n今天讨论了项目的进度和下一步的计划，大家都同意按时完成。\n\n## 结论\n\n下周继续。\n';
    const gbk = iconv(zh, 'GBK');
    const cases = [
      ['gbk-clean.md', gbk, zh],
      ['gbk-truncated-last-char.md', gbk.subarray(0, gbk.length - 2), null], // drop "\n" and half of 。
      ['gbk-stray-ff.md', Buffer.concat([gbk.subarray(0, 20), Buffer.from([0xff]), gbk.subarray(20)]), null],
      ['gbk-stray-80.md', Buffer.concat([gbk.subarray(0, 20), Buffer.from([0x80]), gbk.subarray(20)]), null],
      ['utf8-plus-gbk-paragraph.md', Buffer.concat([Buffer.from('# 标题\n\n这一段是 UTF-8。\n\n', 'utf8'), iconv('这一段是从别处粘贴的 GBK。\n', 'GBK')]), null],
      ['gbk-short.md', iconv('# 你好\n', 'GBK'), '# 你好\n'],
      ['utf16be-nobom.md', Buffer.from(Buffer.from('# 标题\n\n内容\n', 'utf16le').swap16()), '# 标题\n\n内容\n'],
      ['utf8-few-nul.md', Buffer.from('# Title\n\nsome text\u0000 with a NUL\u0000 or two.\n', 'utf8'), '# Title\n\nsome text\u0000 with a NUL\u0000 or two.\n'],
    ];
    for (const [name, bytes, expected] of cases) {
      const p = path.join(TMP, name);
      fs.writeFileSync(p, bytes);
      await emitOpen(ctx.app, p);
      let s = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) { s = await mainSnap(ctx.app); if (s.title?.includes(name) || (s.toasts || []).some((t) => t.includes('失败') || t.includes('无法'))) break; await sleep(150); }
      await sleep(400);
      s = await mainSnap(ctx.app);
      const opened = !!s.title?.includes(name);
      const cjk = (s.text || '').match(/[一-鿿]/g)?.length ?? 0;
      const fffd = (s.text || '').split('�').length - 1;
      const exact = expected === null ? null : s.text === expected;
      await dump(ctx, 'enc2', name, s, diskRec(p));
      note('enc2', `${name} (${bytes.length} B): opened=${opened} len=${s.text?.length} cjk=${cjk} U+FFFD=${fffd} exact=${exact} toasts=${JSON.stringify(s.toasts)}`);
      if (expected !== null) check('enc2', `${name}: shown exactly`, opened && exact, `len=${s.text?.length}`);
      // load a clean doc so the next case has no guard / stale title
      const r = doc(`enc2-reset-${name}`, 1);
      await emitOpen(ctx.app, r.path);
      await waitShows(ctx.app, r, 6000);
    }
  } finally { await quit(ctx); }
};

// ------------------------------------------------------------------------------------------ final round
// Added by final:verify-behaviour#1 (2026-11-20): lead edit L2 (renderer crash while the quit question
// is up → quit cancelled, normal crash recovery) and the stuck-open-queue hunt.

const pageEval = (app, js) => app.evaluate(async ({ BrowserWindow }, code) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  if (!w || w.webContents.isLoading() || w.webContents.isCrashed()) return null;
  return Promise.race([w.webContents.executeJavaScript(code), new Promise((r) => setTimeout(() => r(null), 2500))]);
}, js).catch(() => null);
const draftShown = (app) => pageEval(app, `document.body.innerText.includes('发现未保存的草稿')`);
async function waitFor(fn, ms = 8000, step = 200) {
  const dl = Date.now() + ms;
  let v = null;
  while (Date.now() < dl) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}
const clickToast = (app, label) => pageEval(app, `(() => { const b = [...document.querySelectorAll('.mdr-toast__btn')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
const procAlive = (app) => { try { const p = app.process(); return p.exitCode === null && p.signalCode === null; } catch { return false; } };
const quitSoon = (app) => app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); return true; }).catch(() => false);
/** Does a menu command still reach the renderer? 文件 → 新建 must end on an untitled document (a discard
 *  guard, if the doc is dirty, is answered 丢弃). Returns {ok, sent, s}. */
async function menuNewWorks(app) {
  const before = await app.evaluate(() => globalThis.__sends.filter((x) => x.ch === 'mdr:command' && x.arg === 'file.new').length).catch(() => 0);
  await menuClick(app, 'file.new');
  await sleep(700);
  let s = await mainSnap(app);
  if (s.dialogs?.length) { await clickDialog(app, '丢弃'); await sleep(600); s = await mainSnap(app); }
  const r = await waitFor(async () => { const x = await mainSnap(app); return x.windows === 1 && x.title?.startsWith('未命名') && x.text === '' ? x : null; }, 6000);
  const sent = (await app.evaluate(() => globalThis.__sends.filter((x) => x.ch === 'mdr:command' && x.arg === 'file.new').length).catch(() => 0)) - before;
  return { ok: !!r, sent, s: r || (await mainSnap(app)) };
}
async function openWorks(app, name) {
  const d = doc(name, 2);
  await emitOpen(app, d.path);
  let r = await waitShows(app, d, 10000);
  if (!r.ok && r.s?.dialogs?.length) { await clickDialog(app, '丢弃'); r = await waitShows(app, d, 8000); }
  return r;
}

// (6) L2: renderer crash while the dirty QUIT question is up.
S.l2 = async () => {
  // (a)+(b) dirty doc, quit question, crash → reload shows the doc + draft; open-file works; then quit again.
  for (const variant of ['clean-then-quit', 'restore-draft-then-quit']) {
    const a1 = doc(`l2-${variant}-a.md`, 2);
    const ctx = await bootReady(`l2-${variant}`, [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, 'L2草稿');
      await sleep(2500); // let the renderer persist its IndexedDB draft
      await quitSoon(ctx.app);
      await sleep(900);
      const q = await mainSnap(ctx.app);
      await crashNow(ctx.app);
      const back = await waitShows(ctx.app, a1, 15000);
      const draft = await waitFor(() => draftShown(ctx.app), 6000);
      const alive = procAlive(ctx.app);
      check('l2', `(a) ${variant}: dirty quit question up + crash → window reloads, shows a.md again, draft offered, app still running`,
        q.dialogs?.length === 1 && back.ok && !!draft && alive, `question=${JSON.stringify(q.dialogs)} after: ${brief(back.s)} draft=${!!draft} alive=${alive} boxes=${JSON.stringify(await ctx.app.evaluate(() => globalThis.__boxes))}`);
      // a document opened afterwards is shown (draft toast still up is fine)
      const b1 = doc(`l2-${variant}-b.md`, 3);
      await emitOpen(ctx.app, b1.path);
      let rb = await waitShows(ctx.app, b1, 10000);
      check('l2', `(a) ${variant}: open-file after the crash recovery shows the file`, rb.ok, brief(rb.s));
      // back to a.md for (b)
      await emitOpen(ctx.app, a1.path);
      await waitShows(ctx.app, a1, 10000);
      let dirty = false;
      if (variant === 'restore-draft-then-quit') {
        // the draft toast was for a.md's docId; reopening a.md offers it again
        const offered = await waitFor(() => draftShown(ctx.app), 6000);
        const clicked = await clickToast(ctx.app, '恢复');
        await sleep(800);
        const s = await mainSnap(ctx.app);
        dirty = !!(s.title?.startsWith('●') || s.edited);
        note('l2', `restore draft: offeredAgain=${!!offered} clicked=${clicked} → ${brief(s)} dirty=${dirty} hasDraftText=${s.text?.includes('L2草稿')}`);
        if (!dirty) { await typeMain(ctx.app, '再改'); dirty = true; }
      }
      const exited = exitPromise(ctx.app);
      await quitSoon(ctx.app);
      if (!dirty) {
        const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
        check('l2', '(b) after the crash recovery, app.quit() with a clean document exits (code 0)', !!ex && ex.code === 0, `exit=${JSON.stringify(ex)}`);
      } else {
        await sleep(900);
        const q2 = await mainSnap(ctx.app);
        await clickDialog(ctx.app, '不保存');
        const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
        const diskA = fs.readFileSync(a1.path, 'utf8');
        check('l2', '(b) after the crash recovery, dirty doc: app.quit() asks again, 不保存 exits 0, a.md untouched', q2.dialogs?.length === 1 && !!ex && ex.code === 0 && diskA === a1.text,
          `question=${JSON.stringify(q2.dialogs)} exit=${JSON.stringify(ex)} diskOk=${diskA === a1.text}`);
      }
    } finally { await quit(ctx); }
  }

  // (c) close question (red button) up, then app.quit(), then a crash.
  {
    const a1 = doc('l2-c-a.md', 2);
    const ctx = await bootReady('l2-c', [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, 'C改');
      await closeWin(ctx.app);
      await sleep(800);
      const q = await mainSnap(ctx.app);
      await quitSoon(ctx.app);
      await sleep(600);
      const q2 = await mainSnap(ctx.app);
      await crashNow(ctx.app);
      const back = await waitShows(ctx.app, a1, 15000);
      const alive = procAlive(ctx.app);
      check('l2', '(c) close question up, then app.quit() (no second question), then crash → window recovers with a.md, app alive',
        q.dialogs?.length === 1 && q2.dialogs?.length === 1 && back.ok && alive, `closeQ=${JSON.stringify(q.dialogs)} afterQuit=${JSON.stringify(q2.dialogs)} → ${brief(back.s)} alive=${alive}`);
      const r = await openWorks(ctx.app, 'l2-c-b.md');
      const m = await menuNewWorks(ctx.app);
      check('l2', '(c) afterwards open-file and 文件 → 新建 both work', r.ok && m.ok && m.sent === 1, `open: ${brief(r.s)} new: ok=${m.ok} sent=${m.sent}`);
      // can it still be closed and quit?
      const exited = exitPromise(ctx.app);
      await closeWin(ctx.app);
      const w0 = await waitWindows(ctx.app, 0, 6000);
      await quitSoon(ctx.app);
      const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
      check('l2', '(c) afterwards the window closes and app.quit() exits 0', w0 === 0 && !!ex && ex.code === 0, `windows=${w0} exit=${JSON.stringify(ex)}`);
    } finally { await quit(ctx); }
  }

  // (d) crash while quitting with a clean document: the quit must still complete.
  for (const delay of [0, 5, 30]) {
    const a1 = doc(`l2-d-${delay}.md`, 2);
    const ctx = await bootReady(`l2-d-${delay}`, [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      const exited = exitPromise(ctx.app);
      await ctx.app.evaluate(({ app: a, BrowserWindow }, d) => {
        const w = BrowserWindow.getAllWindows()[0];
        setTimeout(() => { a.quit(); setTimeout(() => { try { w.webContents.forcefullyCrashRenderer(); } catch { /* gone */ } }, d); }, 0);
        return true;
      }, delay).catch(() => false);
      const ex = await Promise.race([exited, sleep(8000).then(() => null)]);
      let extra = '';
      if (!ex) extra = ` still running: ${brief(await mainSnap(ctx.app).catch(() => null))}`;
      check('l2', `(d) clean doc, app.quit() + crash ${delay} ms later: the app exits`, !!ex, `exit=${JSON.stringify(ex)}${extra}`);
    } finally { await quit(ctx); }
  }
  // (d2) crash FIRST, then quit at once while the page reloads (clean doc)
  {
    const a1 = doc('l2-d2.md', 2);
    const ctx = await bootReady('l2-d2', [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      const exited = exitPromise(ctx.app);
      await ctx.app.evaluate(({ app: a, BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); setTimeout(() => a.quit(), 20); return true; }).catch(() => false);
      const ex = await Promise.race([exited, sleep(8000).then(() => null)]);
      check('l2', '(d2) clean doc, crash then app.quit() 20 ms later (page reloading): the app exits', !!ex, `exit=${JSON.stringify(ex)}`);
    } finally { await quit(ctx); }
  }

  // (e) three crashes in a row, each during a quit question: give-up path.
  {
    const a1 = doc('l2-e-a.md', 2);
    const ctx = await bootReady('l2-e', [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      const seen = [];
      for (let i = 1; i <= 3; i++) {
        // make it dirty (after a crash the restored a.md is clean again)
        const ok = await waitShows(ctx.app, a1, 15000);
        await typeMain(ctx.app, `E${i}`);
        await sleep(300);
        await quitSoon(ctx.app);
        await sleep(900);
        const q = await mainSnap(ctx.app);
        await crashNow(ctx.app).catch(() => false);
        await sleep(i < 3 ? 1500 : 2500);
        const s = await mainSnap(ctx.app).catch(() => ({ windows: -1 }));
        seen.push(`#${i}: shown=${ok.ok} q=${q.dialogs?.length ?? '-'} → windows=${s.windows}`);
      }
      const w = await winCount(ctx.app);
      const boxes = await ctx.app.evaluate(() => globalThis.__boxes);
      const alive = procAlive(ctx.app);
      const b1 = doc('l2-e-b.md', 3);
      await emitOpen(ctx.app, b1.path);
      const r = await waitShows(ctx.app, b1, 15000);
      check('l2', '(e) 3 crashes during quit questions: error box, window destroyed, app alive, next open-file shows its file in a new window',
        w === 0 && boxes.length === 1 && alive && r.ok, `${seen.join('; ')}; windows=${w} boxes=${JSON.stringify(boxes)} alive=${alive} → ${brief(r.s)}`);
      const exited = exitPromise(ctx.app);
      await quitSoon(ctx.app);
      const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
      check('l2', '(e) afterwards app.quit() exits 0', !!ex && ex.code === 0, `exit=${JSON.stringify(ex)}`);
    } finally { await quit(ctx); }
  }

  // (f) crash during the quit question, then close the window instead of quitting.
  {
    const a1 = doc('l2-f-a.md', 2);
    const ctx = await bootReady('l2-f', [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, 'F改');
      await sleep(2000);
      await quitSoon(ctx.app);
      await sleep(900);
      await crashNow(ctx.app);
      const back = await waitShows(ctx.app, a1, 15000);
      const nBefore = (await sends(ctx.app)).length;
      await closeWin(ctx.app);
      await sleep(800);
      const sc = await mainSnap(ctx.app);
      let closedQ = JSON.stringify(sc.dialogs ?? null);
      if (sc.windows === 1 && sc.dialogs?.length) { await clickDialog(ctx.app, '不保存'); }
      const w0 = await waitWindows(ctx.app, 0, 6000);
      await sleep(300);
      const b1 = doc('l2-f-b.md', 3);
      await emitOpen(ctx.app, b1.path);
      const r = await waitShows(ctx.app, b1, 15000);
      await sleep(1500);
      const tail = (await sends(ctx.app)).slice(nBefore);
      const wins = await winCount(ctx.app);
      const alive = procAlive(ctx.app);
      check('l2', '(f) crash during quit question, then close the window: closes, app stays, next open-file shows b in ONE new window, nothing stale re-sent',
        back.ok && w0 === 0 && r.ok && wins === 1 && alive && JSON.stringify(tail) === JSON.stringify([b1.name]),
        `recovered=${back.ok} closeQuestion=${closedQ} windowsAfterClose=${w0} → ${brief(r.s)} windows=${wins} sendsAfter=${JSON.stringify(tail)} alive=${alive}`);
      const m = await menuNewWorks(ctx.app);
      check('l2', '(f) and 文件 → 新建 still works in that window', m.ok && m.sent === 1, `ok=${m.ok} sent=${m.sent} ${brief(m.s)}`);
    } finally { await quit(ctx); }
  }
};

// User-scenario variants: the SAME file reopened after closing its window; edit + 保存, close, reopen.
S.user = async () => {
  const a1 = doc('user-same.md', 3);
  const ctx = await bootReady('user', [a1.path]);
  try {
    const first = await waitShows(ctx.app, a1, 15000);
    let ok = 0; const bad = [];
    for (let i = 1; i <= 3; i++) {
      await closeWin(ctx.app);
      const c = await waitWindows(ctx.app, 0, 6000);
      await sleep(i * 150);
      await emitOpen(ctx.app, a1.path);
      const r = await waitShows(ctx.app, a1, 12000);
      if (r.ok && c === 0) ok++; else bad.push(`#${i} ${brief(r.s)}`);
    }
    check('user', 'same file: shown, window closed, the same file double-clicked again (3 rounds): shown every time', first.ok && ok === 3, `${ok}/3 ${bad.join(' | ')}`);
    // edit + 保存, close, reopen → the saved text
    await typeMain(ctx.app, '已保存的追加');
    await menuClick(ctx.app, 'file.save');
    const saved = await waitTitleNotDirty(ctx.app, 8000);
    await closeWin(ctx.app);
    const c = await waitWindows(ctx.app, 0, 6000);
    await emitOpen(ctx.app, a1.path);
    const want = { ...a1, text: a1.text + '已保存的追加' };
    const r = await waitShows(ctx.app, want, 12000);
    check('user', 'edit + 保存, close the window, double-click the file: the saved text is shown', saved && c === 0 && r.ok, `saved=${saved} closed=${c === 0} ${brief(r.s)}`);
    // Dock click (activate) then double-click, and double-click while hidden, after closing
    await closeWin(ctx.app);
    await waitWindows(ctx.app, 0, 6000);
    await ctx.app.evaluate(({ app: a }) => { a.hide(); return true; });
    await sleep(300);
    await emitOpen(ctx.app, a1.path);
    const r2 = await waitShows(ctx.app, want, 12000);
    check('user', 'window closed + app hidden (⌘H), double-click the same file: shown', r2.ok, brief(r2.s));
  } finally { await quit(ctx); }
};

// (6g) quit question up, a document arrives (held), then the renderer crashes: after the reload the held
// document must be what ends on screen; the quit stays cancelled; quit again works.
S.l2g = async () => {
  for (const order of ['open-then-crash', 'crash-then-open-10ms']) {
    const a1 = doc(`l2g-${order}-a.md`, 2);
    const b1 = doc(`l2g-${order}-b.md`, 3);
    const ctx = await bootReady(`l2g-${order}`, [a1.path]);
    try {
      await stubBoxes(ctx.app);
      await waitShows(ctx.app, a1, 15000);
      await typeMain(ctx.app, 'G改');
      await sleep(1500);
      await quitSoon(ctx.app);
      await sleep(900);
      const q = await mainSnap(ctx.app);
      if (order === 'open-then-crash') {
        await emitOpen(ctx.app, b1.path);
        await sleep(600);
        await crashNow(ctx.app);
      } else {
        await ctx.app.evaluate(({ app: a, BrowserWindow }, p) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); setTimeout(() => a.emit('open-file', { preventDefault() {} }, p), 10); return true; }, b1.path);
      }
      const r = await waitShows(ctx.app, b1, 15000);
      await sleep(1500);
      const s2 = await mainSnap(ctx.app);
      const alive = procAlive(ctx.app);
      const diskA = fs.readFileSync(a1.path, 'utf8');
      check('l2', `(g) ${order}: quit question up, b held, crash → b ends on screen, app alive, a.md untouched`,
        q.dialogs?.length === 1 && r.ok && s2.title?.includes(b1.name) && alive && diskA === a1.text, `question=${JSON.stringify(q.dialogs)} → ${brief(s2)} alive=${alive} sends=${JSON.stringify(await sends(ctx.app))}`);
      const m = await menuNewWorks(ctx.app);
      const exited = exitPromise(ctx.app);
      await quitSoon(ctx.app);
      await sleep(900);
      const sq = await mainSnap(ctx.app).catch(() => null);
      if (sq?.dialogs?.length) await clickDialog(ctx.app, '不保存');
      const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
      check('l2', `(g) ${order}: then 文件 → 新建 works and app.quit() exits`, m.ok && m.sent === 1 && !!ex, `new ok=${m.ok} sent=${m.sent} quitQuestion=${JSON.stringify(sq?.dialogs ?? null)} exit=${JSON.stringify(ex)}`);
    } finally { await quit(ctx); }
  }
};

// (7) Stuck-state hunt: the open queue must never stay buffering under a live, subscribed renderer.
S.stuck = async () => {
  const scen = [
    // [name, setup(ctx) → returns {a}, answer, after-answer handler]
    'save-panel-cancelled', 'save-fails', 'cancel-nothing-held', 'held-then-reload', 'held-then-cancel-then-command', 'command-during-dialog',
  ];
  for (const name of scen) {
    const TMPD = fs.mkdtempSync(path.join(TMP, `stuck-${name}-`));
    let ctx = null;
    try {
      let a1 = null;
      if (name === 'save-panel-cancelled') {
        ctx = await bootReady(`stuck-${name}`);
        await ctx.app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); return true; });
        await typeMain(ctx.app, '未命名的内容');
      } else {
        const p = path.join(TMPD, `stuck-${name}.md`);
        const text = `# 标题 ${name}\n\n内容。\n`;
        fs.writeFileSync(p, text);
        a1 = { path: p, name: path.basename(p), text };
        ctx = await bootReady(`stuck-${name}`, [p]);
        await waitTitle(ctx.app, a1.name, 15000);
        await typeMain(ctx.app, '改动');
        if (name === 'save-fails') fs.chmodSync(TMPD, 0o555); // the atomic write cannot create its temp file
      }
      await stubBoxes(ctx.app);
      await closeWin(ctx.app);
      await sleep(800);
      const q = await mainSnap(ctx.app);
      const b1 = doc(`stuck-${name}-b.md`, 3);
      const holdB = name !== 'cancel-nothing-held' && name !== 'command-during-dialog';
      if (holdB) { await emitOpen(ctx.app, b1.path); await sleep(700); }
      let detail = `question=${JSON.stringify(q.dialogs)}`;
      if (name === 'command-during-dialog') {
        // a menu command while the dialog is up and nothing is held: goes to the renderer as in 0.1.0
        const before = (await ctx.app.evaluate(() => globalThis.__sends.filter((x) => x.ch === 'mdr:command').length));
        await menuClick(ctx.app, 'view.toggleToc').catch(() => false);
        await menuClick(ctx.app, 'view.toggleToc').catch(() => false);
        await sleep(600);
        const cmds = (await ctx.app.evaluate(() => globalThis.__sends.filter((x) => x.ch === 'mdr:command').map((x) => x.arg))).slice(before);
        detail += ` commandsDuringDialog=${JSON.stringify(cmds)}`;
        await clickDialog(ctx.app, '取消');
      } else if (name === 'held-then-reload') {
        await ctx.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.reload(); return true; });
      } else if (name === 'cancel-nothing-held' || name === 'held-then-cancel-then-command') {
        if (name === 'held-then-cancel-then-command') { await menuClick(ctx.app, 'file.new'); await sleep(300); }
        await clickDialog(ctx.app, '取消');
      } else {
        await clickDialog(ctx.app, '保存');
      }
      await sleep(1800);
      const s1 = await mainSnap(ctx.app);
      detail += ` afterAnswer: ${brief(s1)} toasts=${JSON.stringify(s1.toasts)}`;
      if (name === 'save-fails') fs.chmodSync(TMPD, 0o755);
      // The held b (if any) must now be delivered: the dirty doc's open guard may ask 取消/丢弃 first.
      let rb = { ok: true, s: s1 };
      if (holdB) {
        if (s1.dialogs?.length) { detail += ` guard=${JSON.stringify(s1.dialogs)}`; await clickDialog(ctx.app, '丢弃'); }
        rb = await waitShows(ctx.app, b1, 10000);
        if (!rb.ok && rb.s?.dialogs?.length) { await clickDialog(ctx.app, '丢弃'); rb = await waitShows(ctx.app, b1, 8000); }
      }
      if (name === 'held-then-cancel-then-command') {
        const cmds = await ctx.app.evaluate(() => globalThis.__sends.filter((x) => x.ch === 'mdr:command').map((x) => x.arg));
        detail += ` commands=${JSON.stringify(cmds)}`;
      }
      // then: a menu command and an open-file must both work
      const m = await menuNewWorks(ctx.app);
      const r = await openWorks(ctx.app, `stuck-${name}-c.md`);
      const diskA = a1 ? fs.readFileSync(a1.path, 'utf8') : null;
      // and the user is not trapped: the window closes, the app quits
      const exited = exitPromise(ctx.app);
      await closeWin(ctx.app);
      const w0 = await waitWindows(ctx.app, 0, 6000);
      await quitSoon(ctx.app);
      const ex = await Promise.race([exited, sleep(6000).then(() => null)]);
      check('stuck', `${name}: held doc delivered (if any), then 文件 → 新建 and open-file work, window closes, app quits`,
        q.dialogs?.length === 1 && rb.ok && m.ok && m.sent === 1 && r.ok && w0 === 0 && !!ex,
        `${detail} | held→ ${holdB ? brief(rb.s) : 'n/a'} | new: ok=${m.ok} sent=${m.sent} | open: ${r.ok} | diskA ${diskA === null ? '-' : diskA === a1.text ? 'unchanged' : `changed(${Buffer.byteLength(diskA)} B)`} | closed=${w0 === 0} exit=${JSON.stringify(ex)}`);
    } catch (e) {
      check('stuck', `${name}: threw`, false, String(e && e.stack || e).slice(0, 300));
    } finally {
      try { fs.chmodSync(TMPD, 0o755); } catch { /* gone */ }
      if (ctx) await quit(ctx);
    }
  }
};

// ------------------------------------------------------------------------------------------ run
const timer = setTimeout(() => {
  console.log(JSON.stringify({ watchdog: 'TIMEOUT', ms: GLOBAL_MS }));
  for (const a of apps) { try { a.process().kill('SIGKILL'); } catch { /* gone */ } }
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(2);
}, GLOBAL_MS);

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(S);
console.log(`target: ${EXE}`);
try {
  for (const n of names) {
    const t0 = Date.now();
    try { await S[n](); } catch (e) { check(n, 'section threw', false, String(e && e.stack || e).slice(0, 300)); }
    console.log(`-- section ${n} ${Date.now() - t0} ms`);
  }
} finally {
  for (const a of [...apps]) { try { a.process().kill('SIGKILL'); } catch { /* gone */ } }
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  clearTimeout(timer);
}
const failed = results.filter((r) => !r.pass);
console.log(`\nconsole/page errors: ${errorsAll.length}`);
for (const e of errorsAll.slice(0, 20)) console.log(`  ${e}`);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name} — ${f.detail}`);
process.exit(0);
