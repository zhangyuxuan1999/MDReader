// bench/electron/v2-shell-nav.mjs — verify-shell (0.2.0 stage 2a): E3 navigation handlers.
// For each scenario (fresh launch): drive real navigation events (webContents.reload / loadURL /
// stop / forcefullyCrashRenderer / page-side location + window.stop), then PROBE: deliver a fresh
// document and require it to be shown in the one window, sent exactly once, and a menu command to
// be delivered. Counts documents shown vs. delivered.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<dir> node bench/electron/v2-shell-nav.mjs [scenario ...]
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 300000), 'nav');

/** Main-process event log for diagnostics. */
const instrument = (app) => app.evaluate(({ BrowserWindow, ipcMain, app: a }) => {
  globalThis.__v2Ev = [];
  const t0 = Date.now();
  const log = (s) => globalThis.__v2Ev.push(`${Date.now() - t0}:${s}`);
  const hook = (w) => {
    const wc = w.webContents;
    if (wc.__v2ev) return;
    wc.__v2ev = true;
    wc.on('did-start-navigation', (d) => log(`start(${d?.isMainFrame ? 'main' : 'sub'}${d?.isSameDocument ? ',same' : ''})`));
    wc.on('did-navigate', () => log('commit'));
    wc.on('did-fail-load', (_e, code, _d, _u, main) => log(`fail(${code},${main})`));
    wc.on('did-stop-loading', () => log('stop'));
    wc.on('render-process-gone', () => log('gone'));
  };
  for (const w of BrowserWindow.getAllWindows()) hook(w);
  a.on('browser-window-created', (_e, w) => hook(w));
  ipcMain.on('mdr:readyForFiles', () => log('ready-for-files'));
});
const events = (app) => app.evaluate(() => globalThis.__v2Ev.slice(-30).join(' '));
const wcDo = (app, fn, arg) => app.evaluate(({ BrowserWindow }, [src, a]) => {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  // eslint-disable-next-line no-new-func
  return new Function('w', 'wc', 'a', src)(w, w.webContents, a);
}, [fn, arg]);
const pageJs = (app, js) => wcDo(app, `wc.executeJavaScript(${JSON.stringify(js)}).catch(() => {}); return true;`);

let probeN = 0;
/** Fresh document → must be shown, sent once; a menu command must reach the renderer. */
async function probe(ctx, name, timeoutMs = 10000) {
  const { app } = ctx;
  const d = L.makeDoc(`probe-${++probeN}`);
  await L.emitOpen(app, d.file);
  const m = await L.mainShows(app, d, timeoutMs);
  await sleep(300);
  const n = (await L.openSends(app, d.file)).length;
  const before = (await L.sent(app)).filter((x) => x.ch === 'mdr:command' && x.arg === 'view.mountAll').length;
  await L.menuClick(app, 'view.mountAll');
  await sleep(400);
  const after = (await L.sent(app)).filter((x) => x.ch === 'mdr:command' && x.arg === 'view.mountAll').length;
  const ws = await L.windowsInfo(app);
  const ok = m.ok && n === 1 && after === before + 1 && ws.length === 1;
  check(`[nav] ${name}: probe shown once + command delivered`, ok,
    `${L.describe(m.s)} sends=${n} cmd=${after - before} windows=${ws.length} ev=[${await events(app).catch(() => '?')}]`);
  return ok;
}

const S = {
  // reload while idle
  async reloadIdle(ctx) { await wcDo(ctx.app, 'wc.reload(); return 1;'); await sleep(2500); return probe(ctx, 'reload idle'); },
  async reloadTwice(ctx) { await wcDo(ctx.app, 'wc.reload(); wc.reload(); return 1;'); await sleep(2500); return probe(ctx, 'two reloads same tick'); },
  async reloadTwiceSpaced(ctx) { await wcDo(ctx.app, 'wc.reload(); setTimeout(() => wc.reload(), 40); return 1;'); await sleep(2500); return probe(ctx, 'two reloads 40 ms apart'); },
  async reloadIgnoringCache(ctx) { await wcDo(ctx.app, 'wc.reloadIgnoringCache(); return 1;'); await sleep(2500); return probe(ctx, 'reloadIgnoringCache (devtools hard reload)'); },
  // a document pushed during the reload: must be shown after the reload
  async openDuringReload(ctx) {
    const d = L.makeDoc('during-reload');
    await ctx.app.evaluate(({ BrowserWindow, app: a }, fp) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.reload();
      for (const ms of [0, 5, 20]) setTimeout(() => a.emit('open-file', { preventDefault() {} }, fp), ms);
    }, d.file);
    const m = await L.mainShows(ctx.app, d, 10000);
    const n = (await L.openSends(ctx.app, d.file)).length;
    check('[nav] open-file at 0/5/20 ms into a reload: shown, sent once', m.ok && n === 1, `${L.describe(m.s)} sends=${n} ev=[${await events(ctx.app)}]`);
    return probe(ctx, 'after open during reload');
  },
  // main-process loadURL + immediate stop (aborted navigation)
  async loadUrlStop(ctx) {
    await wcDo(ctx.app, "wc.loadURL('app://mdreader/index.html?v2=1').catch(() => {}); wc.stop(); return 1;");
    await sleep(1500);
    return probe(ctx, 'loadURL + stop() same tick (aborted)');
  },
  async loadUrlStopLater(ctx) {
    await wcDo(ctx.app, "wc.loadURL('app://mdreader/index.html?v2=1').catch(() => {}); setTimeout(() => wc.stop(), 2); return 1;");
    await sleep(2500);
    return probe(ctx, 'loadURL + stop() 2 ms later');
  },
  async pageAbort(ctx) {
    await pageJs(ctx.app, "location.href = 'app://mdreader/index.html?x=1'; window.stop(); 1");
    await sleep(1500);
    return probe(ctx, 'page location.href + window.stop()');
  },
  async pageReloadAbort(ctx) {
    await pageJs(ctx.app, 'location.reload(); window.stop(); 1');
    await sleep(1500);
    return probe(ctx, 'page location.reload + window.stop()');
  },
  async abortThenReal(ctx) {
    await pageJs(ctx.app, "location.href = 'app://mdreader/index.html?x=1'; window.stop(); 1");
    await sleep(800);
    await wcDo(ctx.app, 'wc.reload(); return 1;');
    await sleep(2500);
    return probe(ctx, 'aborted navigation then a real reload');
  },
  async abortTwiceThenOpen(ctx) {
    await pageJs(ctx.app, "location.href = 'app://mdreader/index.html?x=1'; window.stop(); 1");
    await sleep(300);
    await pageJs(ctx.app, "location.href = 'app://mdreader/index.html?x=2'; window.stop(); 1");
    await sleep(1200);
    return probe(ctx, 'two aborted navigations');
  },
  // the second navigation starts while the first page has subscribed but is still loading
  async navWhileNewPageLoading(ctx) {
    await ctx.app.evaluate(({ BrowserWindow, ipcMain }) => {
      const w = BrowserWindow.getAllWindows()[0];
      let armed = true;
      ipcMain.on('mdr:readyForFiles', () => {
        if (!armed) return;
        armed = false;
        globalThis.__v2LoadingAtReady = w.webContents.isLoading();
        w.webContents.reload();
      });
      w.webContents.reload();
    });
    await sleep(3500);
    const loading = await ctx.app.evaluate(() => globalThis.__v2LoadingAtReady);
    console.log(`  (isLoading at ready-for-files: ${loading})`);
    return probe(ctx, 'reload fired synchronously on the new page\'s ready-for-files');
  },
  async stopAfterReady(ctx) {
    // ready-for-files arrived; a stop() right away (old load still running?) must not break anything
    await ctx.app.evaluate(({ BrowserWindow, ipcMain }) => {
      const w = BrowserWindow.getAllWindows()[0];
      let armed = true;
      ipcMain.on('mdr:readyForFiles', () => { if (armed) { armed = false; w.webContents.stop(); } });
      w.webContents.reload();
    });
    await sleep(3000);
    return probe(ctx, 'stop() on the new page\'s ready-for-files');
  },
  async crashDuringReload(ctx) {
    await wcDo(ctx.app, 'wc.reload(); setTimeout(() => wc.forcefullyCrashRenderer(), 5); return 1;');
    await sleep(4000);
    return probe(ctx, 'crash 5 ms into a reload', 15000);
  },
  async crashAfterAbort(ctx) {
    await pageJs(ctx.app, "location.href = 'app://mdreader/index.html?x=1'; window.stop(); 1");
    await sleep(500);
    await wcDo(ctx.app, 'wc.forcefullyCrashRenderer(); return 1;');
    await sleep(4000);
    return probe(ctx, 'crash after an aborted navigation', 15000);
  },
  async reloadRightAfterCrash(ctx) {
    await wcDo(ctx.app, 'wc.forcefullyCrashRenderer(); setTimeout(() => { try { wc.reload(); } catch {} }, 0); return 1;');
    await sleep(4000);
    return probe(ctx, 'reload right after a crash', 15000);
  },
  // the dirty-close question is up, then a reload
  async reloadDuringCloseQuestion(ctx) {
    await L.makeDirty(ctx.app, 'DIRTY-nav');
    await wcDo(ctx.app, 'w.close(); return 1;');
    const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'));
    await wcDo(ctx.app, 'wc.reload(); return 1;');
    await sleep(3000);
    const s = await L.mainSnap(ctx.app);
    const ok = await probe(ctx, 'reload while the dirty-close question is up');
    // the window must still be closable after that (no stale closeAsked)
    await wcDo(ctx.app, 'w.close(); return 1;');
    await sleep(1500);
    const after = await L.mainSnap(ctx.app);
    check('[nav] after reload during the close question: the window can be closed (or asks once)', q.ok && (after.windows === 0 || (after.buttons || []).includes('不保存')),
      `question=${q.ok} afterReload=${L.describe(s)} afterClose=${L.describe(after)}`);
    return ok;
  },
  async abortDuringCloseQuestion(ctx) {
    await L.makeDirty(ctx.app, 'DIRTY-nav2');
    await wcDo(ctx.app, 'w.close(); return 1;');
    const q = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('不保存'));
    await pageJs(ctx.app, "location.href = 'app://mdreader/index.html?x=1'; window.stop(); 1");
    await sleep(1200);
    const d = L.makeDoc('held-abort');
    await L.emitOpen(ctx.app, d.file);
    await sleep(800);
    const held = (await L.openSends(ctx.app, d.file)).length === 0;
    const c = await L.clickBtn(ctx.app, '取消');
    const g = await L.waitMain(ctx.app, (s) => (s.buttons || []).includes('丢弃'));
    if (g.ok) await L.clickBtn(ctx.app, '丢弃');
    const m = await L.mainShows(ctx.app, d);
    check('[nav] aborted navigation during the close question: doc held, 取消 then shows it', q.ok && held && c && m.ok,
      `question=${q.ok} held=${held} cancel=${c} guard=${g.ok} ${L.describe(m.s)} ev=[${await events(ctx.app)}]`);
    return m.ok;
  },
  // navigation during the INITIAL load (before the first ready-for-files)
  async reloadDuringInitialLoad(ctx) { return probe(ctx, 'reload during the initial load'); },
  async failedLoad(ctx) {
    await wcDo(ctx.app, "wc.loadURL('app://mdreader-nohost/').catch(() => {}); return 1;");
    await sleep(2500);
    const s = await L.mainSnap(ctx.app);
    console.log(`  failed-load page: ${L.describe(s)} url=${s.url ?? ''}`);
    // recovery: a crash-free reload back to the app page
    await wcDo(ctx.app, "wc.loadURL('app://mdreader/').catch(() => {}); return 1;");
    await sleep(2500);
    return probe(ctx, 'failed load, then back to app://mdreader/');
  },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(S);
console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
try {
  for (const n of names) {
    let ctx = null;
    try {
      ctx = await L.launch(n);
      if (n === 'reloadDuringInitialLoad') {
        await instrument(ctx.app);
        // as early as possible: the first window may not exist yet
        await ctx.app.evaluate(({ app: a, BrowserWindow }) => new Promise((res) => {
          const go = (w) => { w.webContents.reload(); res(true); };
          const w0 = BrowserWindow.getAllWindows()[0];
          if (w0) go(w0); else a.once('browser-window-created', (_e, w) => setTimeout(() => go(w), 30));
        }));
        await L.firstReady(ctx.app).catch(() => {});
        await sleep(1500);
      } else {
        await L.firstReady(ctx.app);
        await instrument(ctx.app);
      }
      await S[n](ctx);
    } catch (e) {
      check(`[nav] ${n} threw`, false, String(e && e.stack || e).slice(0, 300));
    } finally {
      await L.hardQuit(ctx);
    }
  }
} finally {
  await L.cleanup();
}
process.exit(L.summary() ? 1 : 0);
