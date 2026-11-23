// bench/electron/v3-shell-dev.mjs — verify-shell (0.2.0 stage 2c): the dev configuration of S3.
// With MDR_DEV_URL set, only a reload of the exact dev page passes will-navigate (isDevReload). What about
// the same URL with another query / path / host, a pushState'd URL, and does a PASSED reload re-arm the
// open queue (a probe document shown exactly once afterwards)?
//   MDR_APP_DIR=<project root> MDR_DEV_URL=http://localhost:5385/ MDR_V2_TMP=<scratch> node bench/electron/v3-shell-dev.mjs
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 300000), 'v3-dev');
const DEV = process.env.MDR_DEV_URL;
if (!DEV) { console.error('set MDR_DEV_URL'); process.exit(64); }
const u = new URL(DEV);
const CASES = [
  ['reload', 'location.reload()', 'pass'],
  ['href same', `location.href = ${JSON.stringify(DEV)}`, 'pass'],
  ['href same#hash', `location.href = ${JSON.stringify(`${DEV}#v3`)}`, 'samedoc'],
  ['href ?query', `location.href = ${JSON.stringify(`${DEV}?v3=1`)}`, 'cancel'],
  ['href /other', `location.href = ${JSON.stringify(new URL('/v3-other', DEV).href)}`, 'cancel'],
  ['href 127.0.0.1 same port', `location.href = ${JSON.stringify(`http://127.0.0.1:${u.port}/`)}`, 'cancel'],
  ['href other port', `location.href = ${JSON.stringify(`http://localhost:${Number(u.port) + 1}/`)}`, 'cancel'],
  ['pushState then reload', "history.pushState({}, '', '/v3-pushed'); location.reload()", 'pass?'],
  ['href app:// 404', "location.href = 'app://mdreader/nonexistent.md'", 'cancel'],
  ['reload + stop', 'location.reload(); window.stop()', 'any'],
];

async function run([name, js, want]) {
  const ctx = await L.launch(`dev-${name}`);
  const { app } = ctx;
  try {
    await L.firstReady(app);
    await app.evaluate(({ BrowserWindow, shell }) => {
      globalThis.__ext = [];
      shell.openExternal = async (x) => { globalThis.__ext.push(x); };
      globalThis.__ev = [];
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.on('did-start-navigation', (d) => { if (d.isMainFrame) globalThis.__ev.push(`start${d.isSameDocument ? '(same)' : ''} ${d.url}`); });
      wc.on('will-navigate', (e, x) => setImmediate(() => globalThis.__ev.push(`will-navigate ${x} ${e.defaultPrevented ? 'PREVENTED' : 'ALLOWED'}`)));
      wc.on('did-navigate', (_e, x) => globalThis.__ev.push(`did-navigate ${x}`));
    });
    const before = (await L.sent(app)).length;
    await L.execMain(app, `(() => { ${js}; return 1; })()`).catch(() => {});
    await sleep(3500);
    await L.firstReady(app).catch(() => {});
    const d = L.makeDoc(`dev-${name.replace(/\W+/g, '-')}`);
    await L.emitOpen(app, d.file);
    const m = await L.mainShows(app, d, 12000);
    await sleep(400);
    const n = (await L.openSends(app, d.file)).length;
    const st = await app.evaluate(({ BrowserWindow }) => ({ url: BrowserWindow.getAllWindows()[0]?.webContents.getURL(), ev: globalThis.__ev, ext: globalThis.__ext }));
    const navigated = st.ev.some((e) => e.startsWith('did-navigate'));
    const allowed = st.ev.some((e) => e.endsWith('ALLOWED'));
    const okNav = want === 'pass' ? allowed : want === 'cancel' ? !allowed && !navigated : true;
    check(`[dev] ${name}: expected ${want}; probe shown once afterwards`, okNav && m.ok && n === 1,
      `allowed=${allowed} navigated=${navigated} url=${st.url} ext=${JSON.stringify(st.ext)} ${L.describe(m.s)} sends=${n} ev=${JSON.stringify(st.ev)} sentBefore=${before}`);
  } finally {
    await L.hardQuit(ctx);
  }
}
console.log(`target: ${L.APP_DIR} dev=${DEV}`);
try {
  const only = process.argv.slice(2);
  for (const c of CASES) {
    if (only.length && !only.includes(c[0])) continue;
    try { await run(c); } catch (e) { check(`[dev] ${c[0]} threw`, false, String(e && e.message).slice(0, 200)); }
  }
} finally {
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
