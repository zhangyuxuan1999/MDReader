// bench/electron/v2-shell-life.mjs — verify-shell (0.2.0 stage 2a): E1 queue order, E2 restore while
// the dirty-close question is up, E4 新建 / 打开… in every window state, E5 argv, menu items.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<dir> node bench/electron/v2-shell-life.mjs [section ...]
// Sections: e1 e2 e4 e5 menu
import * as L from './v2-shell-lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 400000), 'life');

const names = (xs) => xs.map((x) => path.basename(String(x)));
const opensOf = async (app) => (await L.sent(app)).filter((x) => x.ch === 'mdr:open-file').map((x) => x.arg);
const closeAll = async (app) => {
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  return (await L.waitWindows(app, 0)).length === 0;
};
const burst = (app, files, gapMs) => app.evaluate(({ app: a }, [fs_, g]) => {
  fs_.forEach((f, i) => {
    const go = () => a.emit('open-file', { preventDefault() {} }, f);
    if (g === 0) go(); else setTimeout(go, i * g);
  });
}, [files, gapMs]);
/** After a burst: wait for the LAST requested doc to be shown, then let the rest settle. */
async function settleOn(app, doc, ms = 12000) {
  const m = await L.mainShows(app, doc, ms);
  await sleep(1500);
  const s = await L.mainSnap(app);
  return { ok: m.ok && L.showsPred(doc)(s), s };
}
/** Accept every 丢弃 guard that shows up for `ms` (dirty document replaced by a queued open). */
async function discardGuards(app, ms = 3000) {
  const deadline = Date.now() + ms;
  let n = 0;
  while (Date.now() < deadline) {
    const s = await L.mainSnap(app).catch(() => null);
    if (s && (s.buttons || []).includes('丢弃')) { await L.clickBtn(app, '丢弃'); n++; await sleep(300); }
    await sleep(150);
  }
  return n;
}

const S = {
  // ------------------------------------------------------------------ E1
  async e1() {
    const pats = [['ABA', 'ABA'], ['AAB', 'AAB'], ['ABCAB', 'ABCAB'], ['BAA', 'BAA']];
    for (const [tag, pat] of pats) {
      for (const phase of ['noWindow', 'loading']) {
        const ctx = await L.launch(`e1-${tag}-${phase}`);
        try {
          await L.firstReady(ctx.app);
          const docs = {};
          for (const ch of new Set(pat)) docs[ch] = L.makeDoc(`e1-${tag}-${phase}-${ch}`);
          const files = [...pat].map((c) => docs[c].file);
          if (phase === 'noWindow') {
            await closeAll(ctx.app);
            await sleep(300);
            await burst(ctx.app, files, 15);
          } else {
            // the window is loading (fresh page after close + first open)
            await closeAll(ctx.app);
            await sleep(300);
            await ctx.app.evaluate(({ app: a }) => a.emit('activate', {}, false));
            await sleep(30);
            await burst(ctx.app, files, 10);
          }
          const last = docs[pat.at(-1)];
          const r = await settleOn(ctx.app, last);
          const sends = names(await opensOf(ctx.app));
          const dup = sends.length !== new Set(sends).size;
          check(`[e1] ${phase} burst ${pat}: last request shown, nothing opened twice`, r.ok && !dup, `${L.describe(r.s)} sends=[${sends.join(', ')}]`);
        } finally { await L.hardQuit(ctx); }
      }
    }
    // during the dirty-close question, then 不保存: new window shows the last request
    for (const pat of ['ABA', 'ABCAB']) {
      const ctx = await L.launch(`e1-held-${pat}`);
      try {
        await L.firstReady(ctx.app);
        const docs = {};
        for (const ch of new Set(pat)) docs[ch] = L.makeDoc(`e1-held-${pat}-${ch}`);
        await L.makeDirty(ctx.app, 'DIRTY-e1');
        await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'));
        await burst(ctx.app, [...pat].map((c) => docs[c].file), 20);
        await sleep(600);
        const heldSends = (await opensOf(ctx.app)).length;
        await L.clickBtn(ctx.app, '不保存');
        const r = await settleOn(ctx.app, docs[pat.at(-1)]);
        const sends = names(await opensOf(ctx.app));
        check(`[e1] dirty-close question + burst ${pat} + 不保存: last request shown, nothing opened twice`,
          q.ok && heldSends === 0 && r.ok && sends.length === new Set(sends).size, `${L.describe(r.s)} heldSends=${heldSends} sends=[${sends.join(', ')}]`);
      } finally { await L.hardQuit(ctx); }
    }
    // same with 取消: the held burst goes to the same (dirty) window; guards answered 丢弃
    {
      const pat = 'ABA';
      const ctx = await L.launch('e1-held-cancel');
      try {
        await L.firstReady(ctx.app);
        const docs = { A: L.makeDoc('e1-hc-A'), B: L.makeDoc('e1-hc-B') };
        await L.makeDirty(ctx.app, 'DIRTY-e1c');
        await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'));
        await burst(ctx.app, [...pat].map((c) => docs[c].file), 20);
        await sleep(600);
        await L.clickBtn(ctx.app, '取消');
        const g = await discardGuards(ctx.app, 3000);
        const r = await settleOn(ctx.app, docs.A);
        const sends = names(await opensOf(ctx.app));
        check('[e1] dirty-close question + burst ABA + 取消 (+丢弃): A shown, nothing opened twice',
          q.ok && r.ok && sends.length === new Set(sends).size, `${L.describe(r.s)} guards=${g} sends=[${sends.join(', ')}]`);
      } finally { await L.hardQuit(ctx); }
    }
    // across a crash restore: D shown, crash, then A B D (D = the user's last request) / D A
    for (const pat of ['ABD', 'DA', 'AD']) {
      const ctx = await L.launch(`e1-crash-${pat}`);
      try {
        await L.firstReady(ctx.app);
        const docs = {};
        for (const ch of new Set(pat + 'D')) docs[ch] = L.makeDoc(`e1-crash-${pat}-${ch}`);
        await L.emitOpen(ctx.app, docs.D.file);
        const s0 = await L.mainShows(ctx.app, docs.D);
        const before = (await opensOf(ctx.app)).length;
        await ctx.app.evaluate(({ BrowserWindow, app: a }, fs_) => {
          BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
          fs_.forEach((f, i) => setTimeout(() => a.emit('open-file', { preventDefault() {} }, f), 20 + i * 15));
        }, [...pat].map((c) => docs[c].file));
        const r = await settleOn(ctx.app, docs[pat.at(-1)], 15000);
        const after = names((await opensOf(ctx.app)).slice(before));
        check(`[e1] crash restore + burst ${pat}: last request shown, nothing opened twice`,
          s0.ok && r.ok && after.length === new Set(after).size, `${L.describe(r.s)} sendsSinceCrash=[${after.join(', ')}]`);
      } finally { await L.hardQuit(ctx); }
    }
    // same file through another spelling while buffering: symlink / letter case / NFD
    {
      const ctx = await L.launch('e1-spelling');
      try {
        await L.firstReady(ctx.app);
        const dir = path.join(L.TMP, 'spell');
        fs.mkdirSync(dir);
        const a = L.makeDoc('spell-é', dir);
        const link = path.join(dir, 'link-to-a.md');
        fs.symlinkSync(a.file, link);
        const upper = path.join(dir, path.basename(a.file).toUpperCase());
        const nfd = a.file.normalize('NFD');
        const b = L.makeDoc('spell-b', dir);
        await closeAll(ctx.app);
        await sleep(300);
        await burst(ctx.app, [a.file, b.file, link, upper, nfd], 10);
        await sleep(5000);
        const s = await L.mainSnap(ctx.app);
        const sends = await opensOf(ctx.app);
        console.log(`  spelling burst [a, b, symlink(a), UPPER(a), NFD(a)]: shown=${L.describe(s)} sends=[${names(sends).join(', ')}]`);
        check('[e1] same file under other spellings (symlink/case/NFD) while buffering: opened once', sends.length <= 2,
          `sends=${sends.length} [${names(sends).join(', ')}] (informational: string-keyed dedupe)`);
      } finally { await L.hardQuit(ctx); }
    }
  },

  // ------------------------------------------------------------------ E2
  async e2() {
    const states = ['minimize', 'hide', 'fullscreen'];
    const triggers = ['open-file', 'activate', 'second-instance'];
    for (const st of states) {
      for (const tr of triggers) {
        const ctx = await L.launch(`e2-${st}-${tr}`);
        try {
          await L.firstReady(ctx.app);
          const d = L.makeDoc(`e2-${st}-${tr}`);
          await L.makeDirty(ctx.app, 'DIRTY-e2');
          await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
          const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'));
          await ctx.app.evaluate(({ BrowserWindow, app: a }, s) => {
            const w = BrowserWindow.getAllWindows()[0];
            if (s === 'minimize') w.minimize();
            else if (s === 'hide') a.hide();
            else w.setFullScreen(true);
          }, st);
          await sleep(st === 'fullscreen' ? 2500 : 1000);
          const pre = await ctx.app.evaluate(({ BrowserWindow, app: a }) => {
            const w = BrowserWindow.getAllWindows()[0];
            return { min: w.isMinimized(), vis: w.isVisible(), fs: w.isFullScreen(), hidden: a.isHidden?.() };
          });
          if (tr === 'open-file') await L.emitOpen(ctx.app, d.file);
          else if (tr === 'activate') await ctx.app.evaluate(({ app: a }) => a.emit('activate', {}, true));
          else await ctx.app.evaluate(({ app: a }, f) => a.emit('second-instance', {}, [process.execPath, f], '/'), d.file);
          await sleep(1500);
          const post = await ctx.app.evaluate(({ BrowserWindow, app: a }) => {
            const ws = BrowserWindow.getAllWindows();
            const w = ws[0];
            return { windows: ws.length, min: w.isMinimized(), vis: w.isVisible(), fs: w.isFullScreen(), hidden: a.isHidden?.() };
          });
          const s = await L.mainSnap(ctx.app);
          const stillAsked = (s.buttons || []).includes('不保存');
          const visible = post.vis && !post.min && post.hidden !== true;
          // then 取消: a delivered document must show up
          await L.clickBtn(ctx.app, '取消');
          let shown = 'n/a';
          if (tr !== 'activate') {
            const g = await L.waitMain(ctx.app, (x) => (x.buttons || []).includes('丢弃'), 4000);
            if (g.ok) await L.clickBtn(ctx.app, '丢弃');
            shown = (await L.mainShows(ctx.app, d, 6000)).ok;
          }
          check(`[e2] close question + ${st} + ${tr}: window visible with the question, one window${tr !== 'activate' ? ', doc shown after 取消' : ''}`,
            q.ok && visible && stillAsked && post.windows === 1 && shown !== false,
            `pre=${JSON.stringify(pre)} post=${JSON.stringify(post)} question=${stillAsked} shownAfterCancel=${shown}`);
        } finally {
          // Lead, stage 2c: leave full screen and WAIT for the transition to end before the instance is ended.
          // hardQuit calls app.exit(0); doing that while the exit transition runs makes AppKit raise in
          // -[NSWindow _didExitFullScreen]: the main process dies with SIGTRAP and macOS shows a crash dialog
          // on the user's screen (nine times on 2026-11-20). See CONTRACT section 11, desktop test hygiene.
          await ctx.app.evaluate(async ({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            if (!w || w.isDestroyed() || !w.isFullScreen()) return;
            await new Promise((res) => { w.once('leave-full-screen', res); setTimeout(res, 6000); w.setFullScreen(false); });
            await new Promise((res) => setTimeout(res, 1500));
          }).catch(() => {});
          await L.hardQuit(ctx);
        }
      }
    }
    // hidden app WITHOUT a question (baseline path): open-file must bring it back
    const ctx = await L.launch('e2-hidden-plain');
    try {
      await L.firstReady(ctx.app);
      const d = L.makeDoc('e2-hidden-plain');
      await ctx.app.evaluate(({ app: a }) => a.hide());
      await sleep(1000);
      await L.emitOpen(ctx.app, d.file);
      const m = await L.mainShows(ctx.app, d, 6000);
      const post = await ctx.app.evaluate(({ BrowserWindow, app: a }) => ({ vis: BrowserWindow.getAllWindows()[0].isVisible(), hidden: a.isHidden?.() }));
      check('[e2] hidden app (no question) + open-file: shown and visible', m.ok && post.vis && post.hidden !== true, `${L.describe(m.s)} post=${JSON.stringify(post)}`);
    } finally { await L.hardQuit(ctx); }
  },

  // the dirty-close question is up, the window minimised / app hidden, then ⌘Q (app.quit()):
  // the app must either quit or show the question
  async e2quit() {
    for (const st of ['minimize', 'hide']) {
      const ctx = await L.launch(`e2quit-${st}`);
      try {
        await L.firstReady(ctx.app);
        await L.makeDirty(ctx.app, 'DIRTY-e2q');
        await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'));
        await ctx.app.evaluate(({ BrowserWindow, app: a }, s) => { if (s === 'minimize') BrowserWindow.getAllWindows()[0].minimize(); else a.hide(); }, st);
        await sleep(1000);
        const exited = new Promise((res) => ctx.app.process().once('exit', (code) => res({ code })));
        await ctx.app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
        const ex = await Promise.race([exited, sleep(2500).then(() => null)]);
        const post = ex ? null : await ctx.app.evaluate(({ BrowserWindow, app: a }) => {
          const w = BrowserWindow.getAllWindows()[0];
          return { windows: BrowserWindow.getAllWindows().length, min: w?.isMinimized(), vis: w?.isVisible(), hidden: a.isHidden?.() };
        });
        const visible = !!post && post.vis && !post.min && post.hidden !== true;
        check(`[e2quit] close question + ${st} + ⌘Q: the app quits or the question comes to the front`, q.ok && (!!ex || visible),
          `question=${q.ok} exit=${JSON.stringify(ex)} post=${JSON.stringify(post)}`);
      } finally { await L.hardQuit(ctx); }
    }
  },

  // ------------------------------------------------------------------ E4
  async e4() {
    const stubPanel = (app, file) => app.evaluate(({ dialog }, fp) => {
      globalThis.__v2Panel = 0;
      dialog.showOpenDialog = async () => { globalThis.__v2Panel++; return { canceled: false, filePaths: [fp] }; };
    }, file);
    const panelCalls = (app) => app.evaluate(() => globalThis.__v2Panel);
    const states = {
      noWindow: async (app, cmd) => { await closeAll(app); await sleep(300); await L.menuClick(app, cmd); },
      closingSameTick: async (app, cmd) => app.evaluate(({ BrowserWindow, Menu }, c) => {
        BrowserWindow.getAllWindows()[0].close();
        Menu.getApplicationMenu().getMenuItemById(c).click();
      }, cmd),
      afterClosedEvent: async (app, cmd) => app.evaluate(({ BrowserWindow, Menu }, c) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.once('closed', () => Menu.getApplicationMenu().getMenuItemById(c).click());
        w.close();
      }, cmd),
      crashed: async (app, cmd) => app.evaluate(({ BrowserWindow, Menu }, c) => {
        BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
        setTimeout(() => Menu.getApplicationMenu().getMenuItemById(c).click(), 5);
      }, cmd),
      loading: async (app, cmd) => { await closeAll(app); await sleep(300); await app.evaluate(({ app: a, Menu }, c) => { a.emit('activate', {}, false); setTimeout(() => Menu.getApplicationMenu().getMenuItemById(c).click(), 20); }, cmd); },
      reloading: async (app, cmd) => app.evaluate(({ BrowserWindow, Menu }, c) => {
        BrowserWindow.getAllWindows()[0].webContents.reload();
        setTimeout(() => Menu.getApplicationMenu().getMenuItemById(c).click(), 5);
      }, cmd),
      closeQuestion: async (app, cmd) => {
        await L.makeDirty(app, 'DIRTY-e4');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await L.waitMain(app, (s) => (s.buttons || []).includes('不保存'));
        await L.menuClick(app, cmd);
        await sleep(400);
        await L.clickBtn(app, '不保存');
      },
      closeQuestionHeld: async (app, cmd, held) => {
        await L.makeDirty(app, 'DIRTY-e4h');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await L.waitMain(app, (s) => (s.buttons || []).includes('不保存'));
        await L.emitOpen(app, held.file);
        await sleep(300);
        await L.menuClick(app, cmd);
        await sleep(400);
        await L.clickBtn(app, '不保存');
      },
    };
    const onlyStates = process.env.MDR_E4_STATES ? process.env.MDR_E4_STATES.split(',') : null; // e.g. closeQuestion
    for (const [st, run] of Object.entries(states)) {
      if (onlyStates && !onlyStates.includes(st)) continue;
      for (const cmd of ['file.open', 'file.new']) {
        let ctx = null;
        try {
          ctx = await L.launch(`e4-${st}-${cmd}`);
          await L.firstReady(ctx.app);
          const picked = L.makeDoc(`e4-${st}-picked`);
          const held = L.makeDoc(`e4-${st}-held`);
          await stubPanel(ctx.app, picked.file);
          await run(ctx.app, cmd, held);
          await sleep(5000);
          const s = await L.mainSnap(ctx.app);
          const calls = await panelCalls(ctx.app);
          const ws = await L.windowsInfo(ctx.app);
          const cmds = (await L.sent(ctx.app)).filter((x) => x.ch === 'mdr:command' && x.arg === cmd).length;
          let ok;
          if (cmd === 'file.open') ok = ws.length === 1 && calls === 1 && L.showsPred(picked)(s);
          else ok = ws.length === 1 && (s.title || '').includes('未命名') && calls === 0;
          console.log(`  e4 ${st} ${cmd}: ${L.describe(s)} panelCalls=${calls} cmdSends=${cmds} windows=${ws.length}`);
          check(`[e4] ${cmd} in state ${st}: exactly one window${cmd === 'file.open' ? ', one panel, picked file shown' : ', untitled'}`, ok,
            `${L.describe(s)} panelCalls=${calls} cmdSends=${cmds} windows=${ws.length}`);
        } catch (e) {
          check(`[e4] ${cmd} in state ${st} threw`, false, String(e && e.message).slice(0, 200));
        } finally { await L.hardQuit(ctx); }
      }
    }
  },

  // ------------------------------------------------------------------ E5
  async e5() {
    const dir = path.join(L.TMP, 'argv');
    fs.mkdirSync(dir);
    const mk = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
    const readme = mk('README', '# 标题 readme\n\nmarker-readme-正文\n');
    const log = mk('notes.log', '# 标题 log\n\nmarker-log-正文\n');
    const zero = mk('EMPTY', '');
    const mdA = mk('arg-a.md', '# 标题 arg-a\n\nmarker-arg-a-正文\n');
    const mdB = mk('arg-b.md', '# 标题 arg-b\n\nmarker-arg-b-正文\n');
    const link = path.join(dir, 'LINK'); fs.symlinkSync(readme, link);
    const fifo = path.join(dir, 'FIFO'); execFileSync('mkfifo', [fifo]);
    const sub = path.join(dir, 'subdir'); fs.mkdirSync(sub);
    const big = mk('BIGNOEXT', `# 标题 big\n\n${'正文 一行内容 abc\n'.repeat(200000)}`);
    const appDir = L.APP_DIR;
    const cases = [
      ['README (no extension)', [readme], 'README'],
      ['notes.log (other extension)', [log], 'notes.log'],
      ['0-byte EMPTY', [zero], 'EMPTY'],
      ['symlink LINK → README', [link], 'LINK'],
      ['FIFO (no extension)', [fifo], null],
      ['directory', [sub], null],
      ['missing path no extension', [path.join(dir, 'MISSING')], null],
      ['missing.md', [path.join(dir, 'missing.md')], 'ERR'],
      ['relative README (cwd=dir)', ['README'], 'README', dir],
      ['relative arg-a.md (cwd=dir)', ['arg-a.md'], 'arg-a.md', dir],
      ['switch-looking --x=arg-a.md / -psn_0_1', ['--x=arg-a.md', '-psn_0_1'], null],
      ['app package.json', [path.join(appDir, 'package.json')], 'package.json?'],
      ['app electron/main.mjs', [path.join(appDir, 'electron', 'main.mjs')], null],
      ['Electron executable itself', [path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')], null],
      ['several: arg-a.md README arg-b.md', [mdA, readme, mdB], 'arg-b.md'],
      ['big extensionless file (3.6 MB)', [big], 'BIGNOEXT'],
      ['macOS-style -NSDocumentRevisionsDebugMode YES', ['-NSDocumentRevisionsDebugMode', 'YES'], null],
    ];
    for (const [label, args, expect, cwd] of cases) {
      let ctx = null;
      try {
        ctx = await L.launch(`e5-${label}`, args, cwd ? { cwd } : {});
        await L.firstReady(ctx.app).catch(() => {});
        await sleep(2500);
        const s = await L.mainSnap(ctx.app);
        const sends = names(await opensOf(ctx.app));
        const boxes = await ctx.app.evaluate(() => globalThis.__v2Boxes.slice());
        const title = s.title || '';
        let ok;
        if (expect === null) ok = sends.length === 0 && (s.toasts || []).length === 0 && title.includes('未命名');
        else if (expect === 'ERR') ok = (s.toasts || []).length > 0;
        else if (expect === 'package.json?') ok = true; // informational
        else ok = title.includes(expect) && sends.at(-1) === expect;
        check(`[e5] cold argv ${label}`, ok, `${L.describe(s)} sends=[${sends.join(', ')}] boxes=${JSON.stringify(boxes)}`);
        // the same through second-instance (window open)
        if (expect !== 'ERR') {
          const before = (await opensOf(ctx.app)).length;
          await ctx.app.evaluate(({ app: a }, [xs, wd]) => a.emit('second-instance', {}, [process.execPath, ...xs], wd), [args, cwd || '/']);
          await sleep(2000);
          const s2 = await L.mainSnap(ctx.app);
          const sends2 = names((await opensOf(ctx.app)).slice(before));
          let ok2;
          if (expect === null) ok2 = sends2.length === 0;
          else if (expect === 'package.json?') ok2 = true;
          else ok2 = sends2.at(-1) === expect && (s2.title || '').includes(expect);
          check(`[e5] second-instance argv ${label}`, ok2, `${L.describe(s2)} sends=[${sends2.join(', ')}]`);
        }
      } catch (e) {
        check(`[e5] ${label} threw`, false, String(e && e.message).slice(0, 200));
      } finally { await L.hardQuit(ctx); }
    }
  },

  // ------------------------------------------------------------------ menu
  async menu() {
    const ctx = await L.launch('menu');
    try {
      await L.firstReady(ctx.app);
      const items = await ctx.app.evaluate(({ Menu }) => {
        const out = [];
        const walk = (m) => { for (const it of m.items) { out.push({ id: it.id, label: it.label, accel: it.accelerator || null, role: it.role || null, reg: it.registerAccelerator }); if (it.submenu) walk(it.submenu); } };
        walk(Menu.getApplicationMenu());
        return out;
      });
      console.log(`MENU ${JSON.stringify(items.filter((x) => x.label && x.label !== ''))}`);
      // click every custom item: each must send exactly its own id once
      const ids = items.filter((x) => x.id && /^(file|edit|view)\./.test(x.id)).map((x) => x.id);
      const bad = [];
      for (const id of ids) {
        if (id === 'file.open' || id === 'file.saveAs' || id === 'file.exportHtml' || id === 'file.save' || id === 'file.new') continue; // panels / state changes
        const before = (await L.sent(ctx.app)).length;
        await L.menuClick(ctx.app, id);
        await sleep(150);
        const got = (await L.sent(ctx.app)).slice(before).filter((x) => x.ch === 'mdr:command').map((x) => x.arg);
        if (got.length !== 1 || got[0] !== id) bad.push(`${id}→[${got.join(',')}]`);
        await L.execMain(ctx.app, "document.querySelectorAll('.mdr-dialog__btn, .mdr-palette').length; document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); 1");
      }
      check('[menu] every custom item sends exactly its own command id once', bad.length === 0, bad.join(' ') || `${ids.length} items`);
      const accels = items.filter((x) => x.accel).map((x) => x.accel.replace('CmdOrCtrl', 'Cmd'));
      const dupA = accels.filter((a, i) => accels.indexOf(a) !== i);
      check('[menu] no accelerator is used twice', dupA.length === 0, dupA.join(' '));
    } finally { await L.hardQuit(ctx); }
  },
};

const pick = process.argv.slice(2);
const list = pick.length ? pick : Object.keys(S);
console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
try {
  for (const n of list) {
    const t0 = Date.now();
    try { await S[n](); } catch (e) { check(`[${n}] threw`, false, String(e && e.stack || e).slice(0, 300)); }
    console.log(`-- section ${n} ${Date.now() - t0} ms`);
  }
} finally {
  await L.cleanup();
}
process.exit(L.summary() ? 1 : 0);
