// bench/electron/v2-shell-startup.mjs — verify-shell (0.2.0 stage 2a): repeated cold starts.
// Each launch: poll the main process every 250 ms for up to MDR_START_MS (default 40 s) and record
// when the first BrowserWindow exists, when its page has .cm-content, and whether it is visible.
// A launch without a working window is dumped (app ready? windows? url? loading? crashed?).
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<dir> MDR_RUNS=10 node bench/electron/v2-shell-startup.mjs [--with-doc]
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
const RUNS = Number(process.env.MDR_RUNS || 10);
const START_MS = Number(process.env.MDR_START_MS || 40000);
L.watchdog(RUNS * (START_MS + 15000) + 20000, 'startup');
const withDoc = process.argv.includes('--with-doc');

const times = [];
try {
  for (let i = 0; i < RUNS; i++) {
    const d = withDoc ? L.makeDoc(`start-${i}`) : null;
    const t0 = Date.now();
    let ctx = null;
    try {
      ctx = await L.launch(`start-${i}`, d ? [d.file] : []);
      const tLaunch = Date.now() - t0;
      let tWin = null; let tUi = null; let last = null;
      while (Date.now() - t0 < START_MS) {
        last = await ctx.app.evaluate(async ({ app: a, BrowserWindow }) => {
          const ws = BrowserWindow.getAllWindows();
          const w = ws[0];
          const r = { ready: a.isReady(), windows: ws.length };
          if (w) {
            r.url = w.webContents.getURL(); r.loading = w.webContents.isLoading(); r.visible = w.isVisible(); r.crashed = w.webContents.isCrashed();
            try {
              r.ui = await Promise.race([w.webContents.executeJavaScript("({cm: !!document.querySelector('.cm-content'), title: document.title, bridge: typeof window.mdrNative})"), new Promise((res) => setTimeout(() => res(null), 1500))]);
            } catch (e) { r.ui = { err: String(e && e.message) }; }
          }
          return r;
        }).catch((e) => ({ evalErr: String(e && e.message).slice(0, 120) }));
        if (last.windows > 0 && tWin === null) tWin = Date.now() - t0;
        if (last.ui?.cm && last.visible && (!d || last.ui.title?.includes(d.name))) { tUi = Date.now() - t0; break; }
        await sleep(250);
      }
      times.push(tUi);
      check(`[startup] run ${i}: a visible window with the editor${d ? ' showing the argv doc' : ''} within ${START_MS} ms`, tUi !== null,
        `launch=${tLaunch}ms window=${tWin}ms ui=${tUi}ms last=${JSON.stringify(last)} errors=${JSON.stringify(ctx.errors.slice(0, 3))}`);
    } catch (e) {
      check(`[startup] run ${i} threw`, false, String(e && e.message).slice(0, 200));
    } finally { await L.hardQuit(ctx); }
  }
} finally {
  await L.cleanup();
}
console.log(`ui times: ${JSON.stringify(times)}`);
process.exit(L.summary() ? 1 : 0);
