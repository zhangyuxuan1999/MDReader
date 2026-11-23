// bench/electron/v3-shell-stuck.mjs — verify-shell (0.2.0 stage 2c): page-script navigations that reach
// did-start-navigation but never will-navigate (a form blocked by CSP form-action, about:blank,
// about:srcdoc). After each: is a document delivered with open-file shown (queue state), and is the app
// page still there? Main-process event log included. Defence in depth: a document cannot run script.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-stuck.mjs [case ...]
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 240000), 'v3-stuck');
const NX = 'app://mdreader/nonexistent.md';
const CASES = {
  formSubmit: `(() => { const f = document.createElement('form'); f.action = '${NX}'; document.body.appendChild(f); f.submit(); f.remove(); })()`,
  formPost: `(() => { const f = document.createElement('form'); f.action = 'app://mdreader/index.html'; f.method = 'post'; document.body.appendChild(f); f.requestSubmit(); f.remove(); })()`,
  formHttps: "(() => { const f = document.createElement('form'); f.action = 'https://example.com/v3-form'; document.body.appendChild(f); f.submit(); f.remove(); })()",
  aboutBlank: "location.href = 'about:blank'",
  aboutSrcdoc: "location.href = 'about:srcdoc'",
};

async function run(name) {
  const ctx = await L.launch(name);
  const { app } = ctx;
  try {
    await L.firstReady(app);
    await app.evaluate(({ BrowserWindow, shell, ipcMain }) => {
      shell.openExternal = async () => {};
      globalThis.__ev = [];
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const log = (s) => globalThis.__ev.push(s);
      wc.on('did-start-navigation', (d) => { if (d.isMainFrame) log(`start ${d.url}${d.isSameDocument ? ' same' : ''}`); });
      wc.on('will-navigate', (_e, u) => log(`will-navigate ${u}`));
      wc.on('did-navigate', (_e, u) => log(`did-navigate ${u}`));
      wc.on('did-fail-load', (_e, c, _d, u, main) => log(`did-fail-load ${c} ${u} main=${main}`));
      wc.on('did-stop-loading', () => log('did-stop-loading'));
      ipcMain.on('mdr:readyForFiles', () => log('ready-for-files'));
    });
    await L.execMain(app, `(() => { try { ${CASES[name]}; } catch (e) { return String(e); } return 1; })()`).catch(() => {});
    await sleep(1500);
    const d = L.makeDoc(`stuck-${name}`);
    await L.emitOpen(app, d.file);
    const m = await L.mainShows(app, d, 8000);
    const n = (await L.openSends(app, d.file)).length;
    const st = await app.evaluate(({ BrowserWindow }) => ({ url: BrowserWindow.getAllWindows()[0]?.webContents.getURL(), ev: globalThis.__ev }));
    check(`[stuck] ${name}: app page kept and a later document is shown`, m.ok && n === 1,
      `${L.describe(m.s)} sends=${n} url=${st.url} ev=${JSON.stringify(st.ev)}`);
    // second probe: a menu command reaches the renderer?
  } finally {
    await L.hardQuit(ctx);
  }
}
/** about:blank with a DIRTY document: can the window still be closed, can the app still quit? */
async function dirtyBlank() {
  const ctx = await L.launch('dirtyBlank');
  const { app } = ctx;
  let exit = null;
  app.process().once('exit', (code, signal) => { exit = { code, signal }; });
  try {
    await L.firstReady(app);
    await L.makeDirty(app, 'DIRTY-blank');
    await L.execMain(app, "(() => { location.href = 'about:blank'; return 1; })()").catch(() => {});
    await sleep(1500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(2000);
    const afterClose = await L.windowsInfo(app);
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 10); });
    for (let i = 0; i < 30 && !exit; i++) await sleep(100);
    check('[stuck] dirtyBlank: after about:blank a dirty window can still be closed or the app quit', afterClose.length === 0 || !!exit,
      `windowsAfterClose=${JSON.stringify(afterClose)} exitAfterQuit=${JSON.stringify(exit)}`);
  } finally {
    await L.hardQuit(ctx);
  }
}
CASES.dirtyBlank = 'special';
const pick = process.argv.slice(2);
console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
try {
  for (const n of pick.length ? pick : Object.keys(CASES)) {
    try { if (n === 'dirtyBlank') await dirtyBlank(); else await run(n); } catch (e) { check(`[stuck] ${n} threw`, false, String(e && e.message).slice(0, 200)); }
  }
} finally {
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
