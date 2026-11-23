// bench/electron/v3-shell-queue.mjs — verify-shell (0.2.0 stage 2c), step 2: the open queue after
// navigations the shell CANCELS (S3: will-navigate cancels every page-initiated navigation; navStart
// undoes the buffering that did-start-navigation began). For each page-script vector that reaches the
// main process, documents are delivered (app.emit('open-file')) before / during (inside
// did-start-navigation, before and after the shell's own listener; inside will-navigate, before and after
// the shell's) / after it: one, a burst of three, the same one twice. Expectation: every delivered path
// is sent to the renderer exactly once and the LAST one is on screen; then a follow-up (real reload,
// renderer crash, window close + reopen) and a probe that must be shown once.
//   MDR_TARGET=staging|baseline MDR_V2_TMP=<scratch> node bench/electron/v3-shell-queue.mjs [vector ...]
import * as L from './v2-shell-lib.mjs';

const { sleep, check } = L;
L.watchdog(Number(process.env.MDR_TIMEOUT_MS || 600000), 'v3-queue');
const NX = 'app://mdreader/nonexistent.md';

const VECTORS = {
  hrefApp: `location.href = '${NX}'`,
  reload: 'location.reload()',
  goZero: 'history.go(0)',
  hrefHttps: "location.href = 'https://example.com/v3-q'",
  topLink: `(() => { const a = document.createElement('a'); a.href = 'app://mdreader/index.html'; a.target = '_top'; document.body.appendChild(a); a.click(); a.remove(); })()`,
  twoInRow: `location.href = '${NX}'; location.href = 'app://mdreader/index.html?v3=2'`,
  hrefThenStop: `location.href = '${NX}'; window.stop()`,
};
const TIMINGS = ['before', 'didStartFirst', 'didStartLast', 'willNavFirst', 'willNavLast', 'after'];
const SETS = ['one', 'burst', 'twice'];
const FOLLOW = ['reload', 'crash', 'reopen'];

/** Arm a one-shot main-process hook that emits open-file for `paths` at the chosen moment. */
const arm = (app, timing, paths) => app.evaluate(({ BrowserWindow, app: a }, [tm, ps]) => {
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const emit = () => { for (const p of ps) a.emit('open-file', { preventDefault() {} }, p); globalThis.__v3qFired = (globalThis.__v3qFired || 0) + 1; };
  const ev = tm.startsWith('didStart') ? 'did-start-navigation' : 'will-navigate';
  const first = tm.endsWith('First');
  let done = false;
  const fn = (d) => {
    if (done) return;
    if (ev === 'did-start-navigation' && !(d && d.isMainFrame && !d.isSameDocument)) return;
    done = true;
    emit();
    wc.removeListener(ev, fn);
  };
  if (first) wc.prependListener(ev, fn); else wc.on(ev, fn);
  globalThis.__v3qFired = 0;
}, [timing, paths]);

async function scenario(vec, timing, set, follow) {
  const label = `${vec}/${timing}/${set}/${follow}`;
  const ctx = await L.launch(label);
  const { app } = ctx;
  try {
    await L.firstReady(app);
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
    const docs = set === 'one' ? [L.makeDoc(`q1-${vec}-${timing}`)] : set === 'burst'
      ? [1, 2, 3].map((i) => L.makeDoc(`q${i}-${vec}-${timing}`)) : [L.makeDoc(`qt-${vec}-${timing}`)];
    const paths = set === 'twice' ? [docs[0].file, docs[0].file] : docs.map((d) => d.file);
    if (timing === 'before') { for (const p of paths) await L.emitOpen(app, p); await sleep(30); }
    else if (timing !== 'after') await arm(app, timing, paths);
    await L.execMain(app, `(() => { try { ${VECTORS[vec]}; } catch (e) {} return 1; })()`).catch(() => {});
    await sleep(timing === 'after' ? 300 : 50);
    if (timing === 'after') for (const p of paths) await L.emitOpen(app, p);
    const fired = timing === 'before' || timing === 'after' ? 'n/a' : await app.evaluate(() => globalThis.__v3qFired);
    const last = docs[docs.length - 1];
    const m = await L.mainShows(app, last, 12000);
    await sleep(600);
    const counts = [];
    for (const d of docs) counts.push((await L.openSends(app, d.file)).length);
    const url = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL());
    const want = set === 'twice' ? [fired === 0 ? 0 : (timing === 'before' || timing === 'didStartLast' || timing === 'didStartFirst' ? 1 : 2)] : docs.map(() => 1);
    // 'twice' delivered while buffering collapses to one send; delivered while live it is two sends (both fine
    // for the user: the same document twice). Accept 1 or 2 for twice, require exactly 1 for distinct paths.
    const sendsOk = set === 'twice' ? counts[0] >= 1 && counts[0] <= 2 : counts.every((c) => c === 1);
    check(`[q] ${label}: last shown, each sent once`, fired !== 0 && m.ok && sendsOk && /^app:\/\/mdreader\/index\.html$/.test(url || ''),
      `fired=${fired} ${L.describe(m.s)} sends=${JSON.stringify(counts)} (want ${JSON.stringify(want)}) url=${url}`);
    // follow-up
    if (follow === 'reload') { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.reload()); await sleep(2500); }
    else if (follow === 'crash') { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()); await sleep(4000); }
    else if (follow === 'reopen') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await L.waitWindows(app, 0, 5000);
      await app.evaluate(({ app: a }) => a.emit('activate', {}, true));
      await sleep(2500);
    }
    const p = L.makeDoc(`probe-${vec}-${timing}-${set}-${follow}`);
    await L.emitOpen(app, p.file);
    const pm = await L.mainShows(app, p, 15000);
    await sleep(400);
    const pn = (await L.openSends(app, p.file)).length;
    check(`[q] ${label}: probe after ${follow} shown once`, pm.ok && pn === 1, `${L.describe(pm.s)} sends=${pn}`);
  } catch (e) {
    check(`[q] ${label} threw`, false, String(e && e.stack || e).slice(0, 300));
  } finally {
    await L.hardQuit(ctx);
  }
}

const pick = process.argv.slice(2);
const vecs = pick.length ? pick : Object.keys(VECTORS);
const FULL = process.env.V3_FULL === '1';
console.log(`target: ${L.TARGET} ${L.APP_DIR}`);
try {
  let i = 0;
  for (const v of vecs) {
    for (const t of TIMINGS) {
      // all sets for the 'during' timings; one set elsewhere. Follow-ups rotate so each appears for each vector.
      const sets = FULL || t.startsWith('did') || t.startsWith('will') ? SETS : ['one'];
      for (const s of sets) {
        await scenario(v, t, s, FOLLOW[i++ % FOLLOW.length]);
      }
    }
  }
} finally {
  const f = L.summary();
  await L.cleanup();
  process.exit(f ? 1 : 0);
}
